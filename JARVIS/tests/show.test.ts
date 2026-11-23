import { describe, expect, it } from 'vitest';
import { buildStatsDeck, MAX_SLIDES, sanitizeDeck, statsFacts } from '../src/shared/deck';
import { parseShowControl } from '../src/shared/voice';
import { SAMPLE_DASHBOARD } from '../src/renderer/hud/sampleData';
import { makeCore } from './helpers';

const ctx = { runId: 'r', conversationId: 0, signal: new AbortController().signal };

describe('Показ: колода', () => {
  it('очищает данные от модели: типы, длины, числа, неизвестные слайды отбрасываются', () => {
    const d = sanitizeDeck({
      title: 'T'.repeat(300),
      autoplaySec: 999,
      slides: [
        { kind: 'kpis', title: 'К', items: [{ label: 'a', value: '12', tone: 'good' }, { label: 'b', value: 'не число', tone: 'xxx' }] },
        { kind: 'hack', title: 'x' },
        { kind: 'bars', title: 'Б', items: [{ label: '<img src=x onerror=alert(1)>', value: 5 }] },
        { kind: 'table', title: 'Т', columns: ['a', 'b'], rows: [['1', '2', '3'], 'bad'] },
        { kind: 'donut', title: 'Д', items: [{ label: 'a', value: -5 }] },
      ],
    });
    expect(d.title.length).toBeLessThanOrEqual(80);
    expect(d.autoplaySec).toBeUndefined();
    expect(d.slides.map((s) => s.kind)).toEqual(['kpis', 'bars', 'table', 'donut']);
    const k = d.slides[0] as { items: { value: number; tone?: string }[] };
    expect(k.items[0]).toMatchObject({ value: 12, tone: 'good' });
    expect(k.items[1]).toMatchObject({ value: 0 });
    expect(k.items[1]!.tone).toBeUndefined();
    expect((d.slides[2] as { rows: string[][] }).rows[0]).toEqual(['1', '2']);
    expect((d.slides[3] as { items: { value: number }[] }).items[0]!.value).toBe(0);
    expect(() => sanitizeDeck({ slides: [{ kind: 'zzz' }] })).toThrow(/нет ни одного слайда/);
    expect(sanitizeDeck({ slides: Array.from({ length: 80 }, () => ({ kind: 'text', title: 't', bullets: ['x'] })) }).slides).toHaveLength(MAX_SLIDES);
  });

  it('колода «Статистика» из сводки: заглавный, главное, воронки, итог, менеджеры, производство, выводы', () => {
    const d = buildStatsDeck(SAMPLE_DASHBOARD, { sample: true });
    expect(d.source).toBe('ПРИМЕР ДАННЫХ');
    const kinds = d.slides.map((s) => s.kind);
    expect(kinds[0]).toBe('title');
    expect(kinds).toEqual(expect.arrayContaining(['kpis', 'bars', 'funnel', 'donut', 'text']));
    expect(kinds.filter((k) => k === 'funnel')).toHaveLength(SAMPLE_DASHBOARD.overview.pipelines.length);
    const facts = statsFacts(SAMPLE_DASHBOARD);
    expect(facts.join(' ')).toMatch(/работе \d+ сделок/);
    expect(facts.join(' ')).toContain('Просроченных задач');
  });

  it('голосовое управление показом', () => {
    expect(parseShowControl('Дальше')).toBe('next');
    expect(parseShowControl('назад')).toBe('prev');
    expect(parseShowControl('пауза')).toBe('pause');
    expect(parseShowControl('продолжай')).toBe('play');
    expect(parseShowControl('Закрой')).toBe('close');
    expect(parseShowControl('с начала')).toBe('first');
    expect(parseShowControl('что у нас в производстве')).toBeNull();
    expect(parseShowControl('дальше мы будем обсуждать договор с клиентом')).toBeNull();
  });
});

describe('Показ: инструменты ассистента', () => {
  it('show_deck показывает колоду (событие уходит в интерфейс), show_stats без CRM — понятная ошибка; оба только для чтения', async () => {
    const h = makeCore();
    const seen: unknown[] = [];
    h.core.show.onDeck((d) => seen.push(d));
    const r = String(await h.core.tools.get('show_deck')!.execute({ title: 'Сравнение', slides: [{ kind: 'bars', title: 'Продажи', items: [{ label: 'Окт', value: 5 }, { label: 'Ноя', value: 8 }] }] }, ctx));
    expect(r).toContain('открыта на экране');
    expect(seen).toHaveLength(1);
    await expect(async () => h.core.tools.get('show_deck')!.execute({ slides: [] }, ctx)).rejects.toThrow(/нет ни одного слайда/);
    await expect(async () => h.core.tools.get('show_stats')!.execute({}, ctx)).rejects.toThrow(/CRM не подключена/);
    for (const n of ['show_deck', 'show_stats']) {
      const t = h.core.tools.list().find((x) => x.name === n)!;
      expect(t.risk).toBe('low');
      expect(t.mutates).toBe(false);
    }
  });

  it('show_stats с живой CRM: открывает презентацию и возвращает главные факты', async () => {
    const iso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const f = (async (url: string) => {
      const p = new URL(url).pathname.replace('/api/readonly/', '');
      const deals = [{ id: 'd1', title: 'С', stageSemantic: 'ACTIVE', updatedAt: iso(12), pipeline: { id: 'p', name: 'Продажа' }, stage: { name: 'КП', semantic: 'ACTIVE' }, assignee: { id: 'u1', fullName: 'Иван' } }];
      const body = p === 'deals' ? { ok: true, count: 1, nextCursor: null, data: deals } : p === 'city/summary' ? { ok: true, data: { tasks: { open: 5, overdue: 2 } } } : { ok: true, count: 0, nextCursor: null, data: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const h = makeCore({ crmFetch: f });
    h.core.aquaSave({ baseUrl: '', maskPii: true }, 'sro_TestKey1234567890abcdefghijklmnop');
    const decks: { slides: unknown[]; source?: string }[] = [];
    h.core.show.onDeck((d) => decks.push(d));
    const out = String(await h.core.tools.get('show_stats')!.execute({}, ctx));
    expect(decks).toHaveLength(1);
    expect(decks[0]!.source).toContain('Аквамастер');
    expect(decks[0]!.slides.length).toBeGreaterThanOrEqual(5);
    expect(out).toContain('Просроченных задач: 2 из 5');
    expect(out).toContain('Без движения');
  });
});
