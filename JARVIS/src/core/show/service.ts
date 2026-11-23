import { buildStatsDeck, sanitizeDeck, statsFacts, type DeckDto } from '../../shared/deck';
import type { CrmDashboardDto } from '../../shared/types';
import type { AuditLog } from '../security/audit';
import type { ToolRegistry } from '../tools/registry';

type Listener = (deck: DeckDto) => void;

/**
 * «Показ»: вывод на экран анимированных презентаций (статистика CRM, любые данные, которые собрал ассистент).
 * Колода — только данные; рисует и анимирует интерфейс. Ничего не меняет в CRM и на компьютере.
 */
export class ShowService {
  private listeners = new Set<Listener>();

  constructor(
    private deps: {
      /** Сводка из живой CRM (по ключу) или из CRM «Сайберлос»; null — ничего не подключено. */
      dashboard: () => Promise<CrmDashboardDto | null>;
      audit: AuditLog;
    },
  ) {}

  onDeck(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Показать колоду на экране; возвращает очищенную колоду. */
  show(input: unknown): DeckDto {
    const deck = sanitizeDeck(input);
    this.deps.audit.record({ actor: 'assistant', action: 'show.deck', decision: 'info', details: { slides: deck.slides.length, title: deck.title.slice(0, 60) } });
    for (const l of this.listeners) l(deck);
    return deck;
  }

  /** Статистика бизнеса: колода из данных CRM + короткие факты для голоса. */
  async stats(): Promise<{ facts: string[]; slides: number }> {
    const dash = await this.deps.dashboard();
    if (!dash) throw new Error('CRM не подключена: нет данных для статистики.');
    const deck = this.show(buildStatsDeck(dash));
    return { facts: statsFacts(dash), slides: deck.slides.length };
  }

  registerTools(registry: ToolRegistry): void {
    const base = { risk: 'low', mutates: false, domain: 'local' } as const;
    registry.register({
      ...base,
      external: true,
      name: 'show_stats',
      description:
        'Открывает на экране красивую анимированную презентацию «Статистика бизнеса» из данных CRM (воронки, стадии, менеджеры, задачи, производство, замечания). Вызывай, когда пользователь просит «покажи статистику/цифры/как дела в бизнесе». Возвращает главные факты — перескажи их коротко.',
      inputSchema: { type: 'object', properties: {} },
      describe: () => 'Показать статистику бизнеса на экране',
      execute: async () => {
        const r = await this.stats();
        return `Презентация открыта на экране (${r.slides} слайдов). Главное:\n${r.facts.map((f) => '• ' + f).join('\n')}`;
      },
    });
    registry.register<{ title?: string; slides?: unknown; source?: string; autoplaySec?: number }>({
      ...base,
      name: 'show_deck',
      description:
        'Показывает на экране анимированную презентацию из слайдов. Используй, когда пользователь просит «покажи», «визуализируй», «сравни», «выведи на экран». Сначала собери данные инструментами, потом вызови это. ' +
        'slides — массив: {kind:"title",title,subtitle} · {kind:"kpis",title,items:[{label,value,unit?,note?,tone?}]} · {kind:"bars",title,unit?,items:[{label,value,note?,tone?}]} · {kind:"funnel",title,stages:[{label,value}]} · ' +
        '{kind:"donut",title,items:[{label,value,tone?}]} · {kind:"table",title,columns:[...],rows:[[...]]} · {kind:"text",title,bullets:[...]}. tone: good|bad|warn|neutral. До 24 слайдов; числа — настоящие, не выдумывай.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          source: { type: 'string', description: 'Откуда данные (подпись)' },
          autoplaySec: { type: 'integer', description: 'Секунд на слайд (3–40)' },
          slides: { type: 'array', items: { type: 'object' } },
        },
        required: ['slides'],
      },
      describe: (i) => `Показать на экране: ${String(i.title ?? 'презентация').slice(0, 60)}`,
      execute: (i) => {
        const d = this.show(i);
        return `Презентация «${d.title}» открыта на экране (${d.slides.length} слайдов). Пользователь листает её сам или голосом: «дальше», «назад», «закрой».`;
      },
    });
  }
}
