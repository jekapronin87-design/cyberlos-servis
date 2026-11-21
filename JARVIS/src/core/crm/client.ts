import type { SecretStore } from '../security/secrets';

export const SECRET_CRM_PASSWORD = 'crm.password';

/**
 * Разрешённые для JARVIS пути CRM. ТОЛЬКО чтение: клиент не умеет отправлять ничего, кроме входа,
 * а GET допускается лишь на этот список. Остальной API CRM для него недоступен физически.
 */
const ALLOWED_GET: RegExp[] = [
  /^\/auth\/me$/,
  /^\/crm\/pipelines$/,
  /^\/crm\/pipelines\/[\w-]{1,40}\/deals$/,
  /^\/crm\/pipelines\/deals\/[\w-]{1,40}\/history$/,
  /^\/crm\/tasks$/,
  /^\/crm\/team$/,
  /^\/crm\/production-orders$/,
  /^\/crm\/inventory$/,
];

export interface CrmConfig {
  baseUrl: string;
  /** test — тестовая CRM с учебными данными; production — рабочая (только чтение). */
  environment: 'test' | 'production';
  email: string;
  /** Маскировать телефоны, почту и фамилии в данных, передаваемых ИИ. */
  maskPii: boolean;
}

export class CrmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function validateCrmBaseUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > 200) throw new Error('Некорректный адрес CRM');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error('Некорректный адрес CRM (пример: https://crm.example.ru)');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Адрес CRM должен начинаться с https:// (http:// — только для localhost)');
  if (u.username || u.password) throw new Error('Адрес не должен содержать логин и пароль');
  return u.toString().replace(/\/+$/, '');
}

type Fetch = typeof fetch;
const MAX_BODY = 8 * 1024 * 1024;

/** Клиент CRM «Сайберлос» (чтение). Токен хранится только в памяти. */
export class CrmClient {
  private token: string | null = null;

  constructor(
    private getConfig: () => CrmConfig | null,
    private secrets: SecretStore,
    private fetchImpl: Fetch = fetch,
  ) {}

  configured(): boolean {
    return !!this.getConfig() && this.secrets.has(SECRET_CRM_PASSWORD);
  }

  resetSession(): void {
    this.token = null;
  }

  private cfg(): CrmConfig {
    const c = this.getConfig();
    if (!c || !c.baseUrl || !c.email) throw new CrmError('CRM не подключена. Укажите адрес и учётную запись в Настройки → CRM.');
    return c;
  }

  async login(): Promise<void> {
    const c = this.cfg();
    const password = this.secrets.get(SECRET_CRM_PASSWORD);
    if (!password) throw new CrmError('Не задан пароль учётной записи CRM.');
    const res = await this.fetchImpl(`${c.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: c.email, password }),
      signal: AbortSignal.timeout(20_000),
    }).catch((e: unknown) => {
      throw this.netError(e);
    });
    if (res.status === 401) throw new CrmError('CRM отклонила вход: неверный email или пароль.', 401);
    if (res.status === 403) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new CrmError(`CRM не пускает эту учётную запись: ${j.error ?? 'доступ запрещён'}.`, 403);
    }
    if (!res.ok) throw new CrmError(`CRM вернула ошибку входа (${res.status}).`, res.status);
    const j = (await res.json()) as { token?: unknown };
    if (typeof j.token !== 'string') throw new CrmError('Неожиданный ответ CRM при входе.');
    this.token = j.token;
  }

  private netError(e: unknown): CrmError {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) return new CrmError('CRM не ответила вовремя.');
    return new CrmError('Нет связи с CRM. Проверьте адрес и интернет.');
  }

  /** GET с проверкой по списку разрешённых путей. */
  async get<T>(path: string, query?: Record<string, string>, retry = true): Promise<T> {
    const [clean] = path.split('?');
    if (!clean || !ALLOWED_GET.some((re) => re.test(clean))) throw new CrmError(`Путь «${clean}» не входит в список разрешённых для чтения.`);
    const c = this.cfg();
    if (!this.token) await this.login();
    const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
    const res = await this.fetchImpl(`${c.baseUrl}${clean}${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    }).catch((e: unknown) => {
      throw this.netError(e);
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.get<T>(path, query, false);
    }
    if (res.status === 403) throw new CrmError('У учётной записи JARVIS нет права на этот раздел CRM (ошибка 403). Добавьте роли соответствующее право «просмотр».', 403);
    if (res.status === 404) throw new CrmError('Раздел CRM не найден (404) — возможно, версия CRM отличается.', 404);
    if (!res.ok) throw new CrmError(`CRM вернула ошибку ${res.status}.`, res.status);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new CrmError('Ответ CRM слишком большой.');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CrmError('CRM вернула не JSON.');
    }
  }
}

/** Права, которых НЕ должно быть у учётной записи JARVIS: любое из них означает, что она может изменять данные. */
export const WRITE_LIKE_PERMISSIONS = [
  'team.manage', 'team.terminate', 'roles.manage', 'pipeline.manage_all', 'pipeline.cold_leads.manage', 'pipeline.dealer_acquisition.manage',
  'pipeline.dealer_sales.manage', 'pipeline.production.manage', 'deals.bulk_move', 'deals.bulk_message', 'deals.bulk_delete', 'inventory.manage',
  'tasks.assign', 'integrations.manage',
];

/** Права, нужные JARVIS для чтения. */
export const READ_PERMISSIONS = [
  'pipeline.view_all', 'tasks.view_all', 'team.view', 'inventory.view', 'pipeline.production.view',
];
