import { nowIso, type Db } from '../db/database';
import { KB_SEED } from './seed';

export type KbCategory = 'crm_guide' | 'regulation' | 'sales_script' | 'material' | 'faq';
export const KB_CATEGORIES: Record<KbCategory, string> = {
  crm_guide: 'Руководство по CRM',
  regulation: 'Регламент',
  sales_script: 'Скрипт продаж',
  material: 'Учебный материал',
  faq: 'Частые вопросы',
};

export interface KbDoc {
  id: number;
  title: string;
  category: KbCategory;
  body: string;
  source: string;
  status: 'draft' | 'approved';
  version: number;
  builtin: boolean;
  approvedAt: string | null;
  updatedAt: string;
}

export interface KbHit {
  docId: number;
  title: string;
  version: number;
  source: string;
  text: string;
  score: number;
}

export const MAX_DOC_CHARS = 60_000;

interface Row {
  id: number; title: string; category: KbCategory; body: string; source: string; status: 'draft' | 'approved'; version: number;
  builtin: number; approved_at: string | null; updated_at: string;
}
const toDoc = (r: Row): KbDoc => ({ id: r.id, title: r.title, category: r.category, body: r.body, source: r.source, status: r.status, version: r.version, builtin: !!r.builtin, approvedAt: r.approved_at, updatedAt: r.updated_at });

const STOP = new Set(['это', 'как', 'что', 'для', 'при', 'или', 'так', 'его', 'она', 'они', 'все', 'вот', 'быть', 'есть', 'если', 'надо', 'нужно', 'можно', 'мне', 'нам', 'вам', 'про', 'над', 'без', 'чем', 'где', 'когда', 'какой', 'какая', 'какие', 'ли', 'же', 'бы']);

/** Токены с простейшим «стеммингом» (первые 5 букв) — для русского достаточно, чтобы «заявку/заявки/заявка» совпадали. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)).map((t) => (t.length > 5 ? t.slice(0, 5) : t));
}

function chunk(body: string): string[] {
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length > 700 && cur) {
      out.push(cur);
      cur = p;
    } else cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length > 1200 ? c.match(/[\s\S]{1,900}(?:\s|$)/g) ?? [c] : [c]));
}

/** База знаний: только УТВЕРЖДЁННЫЕ документы участвуют в ответах; правка возвращает документ в черновики. */
export class KbRepo {
  constructor(private db: Db) {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get() as { n: number }).n;
    if (n === 0) this.seed();
  }

  private seed(): void {
    const ts = nowIso();
    const ins = this.db.prepare(
      `INSERT INTO kb_documents (title, category, body, source, status, version, builtin, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'approved', 1, 1, ?, ?, ?)`,
    );
    for (const d of KB_SEED) ins.run(d.title, d.category, d.body, d.source, ts, ts, ts);
  }

  list(): KbDoc[] {
    return (this.db.prepare('SELECT * FROM kb_documents ORDER BY category, title').all() as unknown as Row[]).map(toDoc);
  }
  get(id: number): KbDoc | null {
    const r = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toDoc(r) : null;
  }

  private validate(d: { title: string; category: string; body: string; source?: string }): { title: string; category: KbCategory; body: string; source: string } {
    const title = String(d.title ?? '').trim();
    const body = String(d.body ?? '').trim();
    if (!title || title.length > 150) throw new Error('Название: от 1 до 150 символов');
    if (!body) throw new Error('Текст документа пуст');
    if (body.length > MAX_DOC_CHARS) throw new Error(`Документ длиннее ${MAX_DOC_CHARS} символов`);
    if (!(d.category in KB_CATEGORIES)) throw new Error('Неизвестная категория');
    return { title, category: d.category as KbCategory, body, source: String(d.source ?? '').trim().slice(0, 200) };
  }

  /** Создание или правка. Любая правка сбрасывает утверждение. */
  save(input: { id?: number; title: string; category: string; body: string; source?: string }): KbDoc {
    const v = this.validate(input);
    const ts = nowIso();
    if (input.id) {
      const cur = this.get(input.id);
      if (!cur) throw new Error('Документ не найден');
      const changed = cur.title !== v.title || cur.body !== v.body || cur.source !== v.source || cur.category !== v.category;
      if (changed) {
        this.db
          .prepare(`UPDATE kb_documents SET title = ?, category = ?, body = ?, source = ?, status = 'draft', approved_at = NULL, version = version + 1, updated_at = ? WHERE id = ?`)
          .run(v.title, v.category, v.body, v.source, ts, input.id);
      }
      return this.get(input.id)!;
    }
    const res = this.db
      .prepare(`INSERT INTO kb_documents (title, category, body, source, status, version, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 1, 0, ?, ?)`)
      .run(v.title, v.category, v.body, v.source, ts, ts);
    return this.get(Number(res.lastInsertRowid))!;
  }

  setApproved(id: number, approved: boolean): KbDoc {
    if (!this.get(id)) throw new Error('Документ не найден');
    this.db.prepare('UPDATE kb_documents SET status = ?, approved_at = ? WHERE id = ?').run(approved ? 'approved' : 'draft', approved ? nowIso() : null, id);
    return this.get(id)!;
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id);
  }

  /** Поиск по утверждённым документам: простая взвешенная релевантность (частота × редкость, заголовок весомее). */
  search(query: string, limit = 4): KbHit[] {
    const q = [...new Set(tokens(query))];
    if (q.length === 0) return [];
    const docs = this.list().filter((d) => d.status === 'approved');
    const chunks: { doc: KbDoc; text: string; toks: string[] }[] = [];
    for (const d of docs) for (const c of chunk(d.body)) chunks.push({ doc: d, text: c, toks: tokens(d.title + ' ' + c) });
    if (chunks.length === 0) return [];
    const df = new Map<string, number>();
    for (const c of chunks) for (const t of new Set(c.toks)) df.set(t, (df.get(t) ?? 0) + 1);
    const hits: KbHit[] = [];
    for (const c of chunks) {
      const titleToks = new Set(tokens(c.doc.title));
      let score = 0;
      let matched = 0;
      for (const t of q) {
        const tf = c.toks.filter((x) => x === t).length;
        if (!tf) continue;
        matched++;
        const idf = Math.log(1 + chunks.length / (df.get(t) ?? 1));
        score += (1 + Math.log(tf)) * idf * (titleToks.has(t) ? 1.8 : 1);
      }
      // нужно, чтобы совпала хотя бы половина значимых слов запроса — иначе лучше честно ответить «не найдено»
      if (matched >= Math.max(1, Math.ceil(q.length / 2))) hits.push({ docId: c.doc.id, title: c.doc.title, version: c.doc.version, source: c.doc.source, text: c.text, score: score * (matched / q.length) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
