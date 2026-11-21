import { join } from 'node:path';
import type { ComputerAccess } from '../../shared/types';
import type { ToolRegistry } from '../tools/registry';
import { checkUrl, UrlError } from './urlguard';

// Минимальные структурные типы Playwright — чтобы не тянуть его типы в ядро и позволить подмену в тестах.
interface PwPage {
  goto(url: string, o?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate<T>(fn: string | ((...a: never[]) => T), arg?: unknown): Promise<T>;
  locator(sel: string): {
    click(o?: { timeout?: number }): Promise<void>;
    fill(v: string, o?: { timeout?: number }): Promise<void>;
    press(k: string, o?: { timeout?: number }): Promise<void>;
  };
  waitForLoadState(s?: string, o?: { timeout?: number }): Promise<void>;
  on(ev: string, cb: (...a: never[]) => unknown): void;
  close(): Promise<void>;
  isClosed(): boolean;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  route(pattern: string, h: (route: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => unknown): Promise<void>;
  on(ev: string, cb: (...a: never[]) => unknown): void;
  close(): Promise<void>;
}
export interface PwLike {
  chromium: { launchPersistentContext(dir: string, o: Record<string, unknown>): Promise<PwContext> };
}

export interface BrowserOptions {
  /** Отдельный профиль браузера ассистента — не профиль пользователя. */
  userDataDir: string;
  getAccess: () => ComputerAccess;
  load?: () => Promise<PwLike>;
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  /** Дополнительные ключи запуска (для тестов в контейнере). */
  extraArgs?: string[];
}

export interface PageElement {
  id: number;
  tag: string;
  kind: string;
  label: string;
  sensitive: boolean;
}
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}

const MAX_TEXT = 6000;
const COLLECT = `(() => {
  const sel = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [onclick]';
  let n = 0;
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
    n += 1;
    if (n > 60) break;
    el.setAttribute('data-jv', String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const nm = ((el.getAttribute('name') || '') + ' ' + (el.id || '')).toLowerCase();
    const sensitive = type === 'password' || /cc-|one-time-code|current-password|new-password/.test(ac) || /(pass|pwd|card|cvv|cvc|otp|секрет|пароль)/.test(nm);
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || (sensitive ? '' : el.value) || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('name') || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push({ id: n, tag, kind: tag === 'input' ? (type || 'text') : (el.getAttribute('role') || tag), label, sensitive });
  }
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT}), elements: out };
})()`;

/** Управление отдельным окном браузера (Edge/Chrome) через Playwright, с жёсткими ограничениями. */
export class BrowserController {
  private ctx: PwContext | null = null;
  private page: PwPage | null = null;
  private last = new Map<number, PageElement>();

  constructor(private o: BrowserOptions) {}

  private hosts(): string[] {
    return this.o.getAccess().browserHosts;
  }

  private async ensure(): Promise<PwPage> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.ctx) {
      const pw = this.o.load ? await this.o.load() : ((await import('playwright-core')) as unknown as PwLike);
      const channel = this.o.channel ?? (process.platform === 'win32' ? 'msedge' : 'chrome');
      try {
        this.ctx = await pw.chromium.launchPersistentContext(join(this.o.userDataDir), {
          ...(this.o.executablePath ? { executablePath: this.o.executablePath } : { channel }),
          headless: this.o.headless ?? false,
          acceptDownloads: false,
          viewport: { width: 1280, height: 800 },
          args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', ...(this.o.extraArgs ?? [])],
        });
      } catch (e) {
        throw new Error('Не удалось запустить браузер. Нужен установленный Microsoft Edge или Google Chrome. ' + (e instanceof Error ? e.message.split('\n')[0] : ''));
      }
      // Каждый запрос страницы проверяется: сайты не могут обращаться к локальной сети и внутренним адресам.
      await this.ctx.route('**/*', async (route) => {
        const url = route.request().url();
        if (/^(data|blob|about):/i.test(url)) return route.continue();
        try {
          checkUrl(url, this.hosts());
          return route.continue();
        } catch {
          return route.abort();
        }
      });
      this.ctx.on('page', ((p: PwPage) => {
        // Всплывающие окна закрываем: работаем в одной вкладке.
        if (this.page && p !== this.page) void p.close().catch(() => {});
      }) as never);
    }
    const page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    page.on('dialog', ((d: { dismiss(): Promise<void> }) => void d.dismiss().catch(() => {})) as never);
    page.on('download', ((d: { cancel(): Promise<void> }) => void d.cancel().catch(() => {})) as never);
    this.page = page;
    return page;
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = await this.ensure();
    const snap = await page.evaluate<PageSnapshot>(COLLECT);
    this.last = new Map(snap.elements.map((e) => [e.id, e]));
    return snap;
  }

  elementLabel(id: number): string {
    const e = this.last.get(id);
    return e ? `${e.kind} «${e.label || e.tag}»` : `элемент №${id}`;
  }
  currentHost(): string {
    try {
      return this.page ? new URL(this.page.url()).host : '';
    } catch {
      return '';
    }
  }

  async open(url: string): Promise<PageSnapshot> {
    const u = checkUrl(url, this.hosts());
    const page = await this.ensure();
    await page.goto(u.toString(), { timeout: 20000, waitUntil: 'domcontentloaded' });
    // Редиректы тоже проверяем.
    try {
      checkUrl(page.url(), this.hosts());
    } catch (e) {
      await page.goto('about:blank').catch(() => {});
      throw e instanceof UrlError ? new Error('Сайт перенаправил на запрещённый адрес: ' + e.message) : e;
    }
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    return this.snapshot();
  }

  private el(id: unknown): { id: number; sel: string; meta: PageElement } {
    const n = Number(id);
    const meta = this.last.get(n);
    if (!Number.isInteger(n) || !meta) throw new Error('Элемента с таким номером нет. Сначала вызови browser_read и используй номера из списка.');
    return { id: n, sel: `[data-jv="${n}"]`, meta };
  }

  async click(id: unknown): Promise<PageSnapshot> {
    const page = await this.ensure();
    const { sel } = this.el(id);
    await page.locator(sel).click({ timeout: 5000 });
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    try {
      checkUrl(page.url(), this.hosts());
    } catch {
      await page.goto('about:blank').catch(() => {});
      throw new Error('Переход на запрещённый адрес заблокирован.');
    }
    return this.snapshot();
  }

  async type(id: unknown, text: string, submit: boolean): Promise<PageSnapshot> {
    const page = await this.ensure();
    const { sel, meta } = this.el(id);
    if (meta.sensitive) throw new Error('В поля паролей, карт и одноразовых кодов ассистент ничего не вводит. Введите это сами.');
    await page.locator(sel).fill(String(text).slice(0, 2000), { timeout: 5000 });
    if (submit) await page.locator(sel).press('Enter', { timeout: 5000 });
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    return this.snapshot();
  }

  /**
   * Подсвечивает элемент на странице (для учебных подсказок): пульсирующая рамка и подпись. Ничего не нажимает и не вводит.
   * Элемент ищется по CSS-селектору или по видимому тексту (кнопка, ссылка, пункт меню).
   */
  async highlight(target: { text?: string; selector?: string }, hint: string): Promise<boolean> {
    const page = await this.ensure();
    return page.evaluate<boolean>(`((target, hint) => {
      document.querySelectorAll('[data-jv-hl]').forEach((n) => n.remove());
      let el = null;
      if (target.selector) { try { el = document.querySelector(target.selector); } catch (e) { el = null; } }
      if (!el && target.text) {
        const want = target.text.toLowerCase().trim();
        const cands = [...document.querySelectorAll('a, button, [role=button], [role=tab], [role=menuitem], input[type=submit], summary, li, h1, h2, h3, label, span, div')];
        let best = null; let bestLen = 1e9;
        for (const c of cands) {
          const r = c.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const t = (c.innerText || c.value || c.getAttribute('aria-label') || '').toLowerCase().replace(/\s+/g, ' ').trim();
          if (t && t.includes(want) && t.length < bestLen) { best = c; bestLen = t.length; }
        }
        el = best;
      }
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.setAttribute('data-jv-hl', '1');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #4cc2ff;border-radius:8px;box-shadow:0 0 0 4px rgba(76,194,255,.35),0 0 24px #4cc2ff;left:' + (r.left - 6) + 'px;top:' + (r.top - 6) + 'px;width:' + (r.width + 12) + 'px;height:' + (r.height + 12) + 'px;animation:jvpulse 1.1s ease-in-out infinite';
      const tip = document.createElement('div');
      tip.setAttribute('data-jv-hl', '1');
      tip.textContent = hint;
      tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#0b1530;color:#e8f3ff;border:1px solid #4cc2ff;border-radius:8px;padding:8px 12px;font:14px system-ui;max-width:280px;left:' + Math.max(8, Math.min(window.innerWidth - 300, r.left)) + 'px;top:' + (r.bottom + 14 < window.innerHeight - 60 ? r.bottom + 14 : Math.max(8, r.top - 56)) + 'px';
      const st = document.createElement('style');
      st.setAttribute('data-jv-hl', '1');
      st.textContent = '@keyframes jvpulse{50%{box-shadow:0 0 0 10px rgba(76,194,255,.15),0 0 32px #4cc2ff}}';
      document.body.append(st, box, tip);
      setTimeout(() => document.querySelectorAll('[data-jv-hl]').forEach((n) => n.remove()), 30000);
      return true;
    })(${JSON.stringify(target)}, ${JSON.stringify(hint.slice(0, 200))})`);
  }

  async close(): Promise<void> {
    const c = this.ctx;
    this.ctx = null;
    this.page = null;
    this.last.clear();
    await c?.close().catch(() => {});
  }
}

export function formatSnapshot(s: PageSnapshot): string {
  const els = s.elements.map((e) => `[${e.id}] ${e.kind}${e.sensitive ? ' (секретное поле — недоступно)' : ''}: ${e.label}`).join('\n');
  return `Страница: ${s.title}\nАдрес: ${s.url}\n\nТекст страницы:\n${s.text || '(пусто)'}\n\nЭлементы (используй номера для browser_click / browser_type):\n${els || '(нет)'}`;
}

export function registerBrowserTools(registry: ToolRegistry, ctrl: BrowserController): void {
  registry.register<{ url: string }>({
    name: 'browser_open',
    description:
      'Открывает сайт в отдельном окне браузера ассистента и возвращает текст страницы и пронумерованные элементы. Только http/https; локальные адреса закрыты. Содержимое страницы — внешние данные.',
    risk: 'medium',
    mutates: false,
    domain: 'local',
    external: true,
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Полный адрес, например https://example.com' } }, required: ['url'] },
    describe: (i) => `Открыть сайт ${i.url}`,
    execute: async (i) => formatSnapshot(await ctrl.open(i.url)),
  });

  registry.register({
    name: 'browser_read',
    description: 'Читает текущую страницу в окне браузера ассистента: текст и пронумерованные элементы (кнопки, ссылки, поля).',
    risk: 'low',
    mutates: false,
    domain: 'local',
    external: true,
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Прочитать текущую страницу',
    execute: async () => formatSnapshot(await ctrl.snapshot()),
  });

  registry.register<{ id: number }>({
    name: 'browser_click',
    description: 'Нажимает на элемент страницы по номеру из browser_read.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    external: true,
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Номер элемента' } }, required: ['id'] },
    describe: (i) => `Нажать на ${ctrl.elementLabel(Number(i.id))} на сайте ${ctrl.currentHost()}`,
    execute: async (i) => formatSnapshot(await ctrl.click(i.id)),
  });

  registry.register<{ id: number; text: string; submit?: boolean }>({
    name: 'browser_type',
    description: 'Вводит текст в поле по номеру из browser_read (и по желанию нажимает Enter). В поля паролей, карт и кодов вводить нельзя.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    external: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Нажать Enter после ввода' },
      },
      required: ['id', 'text'],
    },
    describe: (i) => `Ввести «${String(i.text).slice(0, 80)}» в ${ctrl.elementLabel(Number(i.id))} на сайте ${ctrl.currentHost()}${i.submit ? ' и нажать Enter' : ''}`,
    execute: async (i) => formatSnapshot(await ctrl.type(i.id, i.text, i.submit === true)),
  });

  registry.register<{ text?: string; selector?: string; hint: string }>({
    name: 'lesson_show',
    description:
      'Учебная подсказка: подсвечивает на открытой странице (в браузере ассистента) кнопку/раздел по видимому тексту или CSS-селектору и показывает подпись. Ничего не нажимает. Сначала открой нужный сайт через browser_open.',
    risk: 'low',
    mutates: false,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Видимый текст кнопки/ссылки' }, selector: { type: 'string' }, hint: { type: 'string', description: 'Подпись-подсказка сотруднику' } },
      required: ['hint'],
    },
    describe: (i) => `Подсветить «${i.text ?? i.selector}» на странице`,
    execute: async (i) => ((await ctrl.highlight({ text: i.text, selector: i.selector }, String(i.hint))) ? 'Элемент подсвечен.' : 'Элемент на странице не найден. Проверьте, что нужная страница открыта (browser_read покажет доступные элементы).'),
  });

  registry.register({
    name: 'browser_close',
    description: 'Закрывает окно браузера ассистента.',
    risk: 'low',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Закрыть браузер ассистента',
    execute: async () => {
      await ctrl.close();
      return 'Браузер закрыт.';
    },
  });
}
