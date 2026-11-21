import { PROFILE_SECTIONS, type ProfileSection, type ProfileSectionId } from '../shared/types';
import { nowIso, type Db } from './db/database';
import { scanForInjection } from './security/injection';
import type { ToolRegistry } from './tools/registry';

export const MAX_SECTION_CHARS = 4000;
export const MAX_PROFILE_PROMPT_CHARS = 6000;

const IDS = PROFILE_SECTIONS.map((s) => s.id) as string[];

/** Luhn: номера банковских карт нельзя хранить в досье. */
function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Досье не место для секретов: пароли, ключи API и номера карт сюда не сохраняются —
 * текст из досье уходит в запросы к ИИ.
 */
export function findSecret(text: string): string | null {
  if (/(sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text)) {
    return 'похоже на ключ или токен';
  }
  if (/(пароль|password|passwd|pwd|пин-?код|pin)\s*(от\s+\S+\s*)?[:=—-]\s*\S{4,}/i.test(text)) return 'похоже на пароль';
  const cards = text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? [];
  for (const c of cards) {
    const d = c.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'похоже на номер банковской карты';
  }
  return null;
}

export function validateProfileText(text: unknown): string {
  if (typeof text !== 'string') throw new Error('Текст должен быть строкой');
  const t = text.replace(/\r/g, '').trim();
  if (t.length > MAX_SECTION_CHARS) throw new Error(`Раздел длиннее ${MAX_SECTION_CHARS} символов`);
  const secret = findSecret(t);
  if (secret) throw new Error(`В досье нельзя хранить секреты: ${secret}. Уберите это из текста.`);
  if (scanForInjection(t).suspicious) throw new Error('Текст содержит фразы, похожие на попытку управлять ассистентом, — сохранить нельзя.');
  return t;
}

export function isSectionId(v: unknown): v is ProfileSectionId {
  return typeof v === 'string' && IDS.includes(v);
}

export class ProfileRepo {
  constructor(private db: Db) {}

  list(): ProfileSection[] {
    const rows = this.db.prepare('SELECT section, body, updated_at FROM profile').all() as { section: string; body: string; updated_at: string }[];
    const map = new Map(rows.map((r) => [r.section, r]));
    return PROFILE_SECTIONS.map((s) => ({ ...s, body: map.get(s.id)?.body ?? '', updatedAt: map.get(s.id)?.updated_at ?? null }));
  }

  set(section: ProfileSectionId, body: string): void {
    if (!isSectionId(section)) throw new Error('Неизвестный раздел досье');
    const text = validateProfileText(body);
    if (!text) {
      this.db.prepare('DELETE FROM profile WHERE section = ?').run(section);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO profile (section, body, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(section) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(section, text, nowIso());
  }

  /** Добавляет текст к разделу; если не помещается — ошибка (ничего не обрезается молча). */
  append(section: ProfileSectionId, addition: string): void {
    const cur = this.list().find((s) => s.id === section)!.body;
    const add = validateProfileText(addition);
    if (!add) return;
    this.set(section, cur ? `${cur}\n${add}` : add);
  }

  clear(): void {
    this.db.prepare('DELETE FROM profile').run();
  }

  /** Блок для системного промпта: только заполненные разделы, с ограничением размера. */
  forPrompt(): { title: string; body: string }[] {
    let budget = MAX_PROFILE_PROMPT_CHARS;
    const out: { title: string; body: string }[] = [];
    for (const s of this.list()) {
      if (!s.body || budget <= 0) continue;
      const body = s.body.length > budget ? s.body.slice(0, budget) + '…' : s.body;
      budget -= body.length;
      out.push({ title: s.title, body });
    }
    return out;
  }
}

/** Инструменты досье. Запись — с подтверждением, чтобы ассистент не мог «втихую» сохранить о вас что-то. */
export function registerProfileTools(registry: ToolRegistry, repo: ProfileRepo): void {
  registry.register({
    name: 'profile_get',
    description: 'Показывает текущее досье о пользователе (разделы: обо мне, работа, близкие, цели, распорядок, стиль общения, чего не делать).',
    risk: 'safe',
    mutates: false,
    domain: 'local',
    inputSchema: { type: 'object', properties: {} },
    describe: () => 'Прочитать досье о пользователе',
    execute: () => {
      const filled = repo.list().filter((s) => s.body);
      return filled.length ? filled.map((s) => `## ${s.title} (${s.id})\n${s.body}`).join('\n\n') : 'Досье пока пусто.';
    },
  });

  registry.register<{ entries: { section: string; text: string }[]; mode?: string }>({
    name: 'profile_save',
    description:
      'Сохраняет в досье пользователя факты о нём, которые он сам рассказал (после знакомства или импорта текста). entries — список {section, text}, section: ' +
      `${IDS.join(' | ')}. mode: "append" (по умолчанию, добавить) или "replace" (заменить раздел). ` +
      'Сохраняй только то, что пользователь действительно сказал, кратко и фактически; не добавляй догадки. Никогда не сохраняй пароли, ключи, номера карт. ' +
      'Пользователь увидит и подтвердит все записи.',
    risk: 'medium',
    mutates: true,
    domain: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        entries: { type: 'array', description: 'Список записей: [{"section":"about","text":"…"}]' },
        mode: { type: 'string', enum: ['append', 'replace'] },
      },
      required: ['entries'],
    },
    describe: (i) => {
      const list = Array.isArray(i.entries) ? i.entries : [];
      const lines = list.slice(0, 12).map((e) => {
        const title = PROFILE_SECTIONS.find((s) => s.id === e?.section)?.title ?? String(e?.section);
        return `• ${title}: ${String(e?.text ?? '').slice(0, 220)}`;
      });
      return `Сохранить в досье о вас (${i.mode === 'replace' ? 'заменить разделы' : 'добавить'}):\n${lines.join('\n')}`;
    },
    execute: (i) => {
      const list = Array.isArray(i.entries) ? i.entries : [];
      if (list.length === 0) throw new Error('Нет записей для сохранения');
      if (list.length > 12) throw new Error('Не больше 12 записей за раз');
      // сначала проверяем всё, потом пишем — чтобы не сохранить половину
      for (const e of list) {
        if (!e || !isSectionId(e.section)) throw new Error(`Неизвестный раздел: ${String((e as { section?: unknown })?.section)}`);
        validateProfileText(e.text);
      }
      for (const e of list) (i.mode === 'replace' ? repo.set(e.section as ProfileSectionId, e.text) : repo.append(e.section as ProfileSectionId, e.text));
      return `Сохранено записей: ${list.length}.`;
    },
  });
}
