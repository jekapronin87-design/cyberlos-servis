import type { RoutingMode } from '../../shared/types';
import { OpenAiCompatProvider } from './openai';
import type { ChatProvider, ProviderEvent, ProviderMessage, ProviderRequest } from './types';
import { ProviderHttpError } from './types';

export interface Classification {
  hard: boolean;
  /** В ходе запроса участвуют личные/деловые данные (CRM, досье, файлы, экран): отправлять их сторонним облачным моделям нельзя. */
  sensitive: boolean;
  reason: string;
}

const HARD_RE =
  /(?<![а-яё])(код|кода|коде|программ[а-яё]*|скрипт[а-яё]*|отлад[а-яё]*|рефактор[а-яё]*|баг[а-яё]*|ошибк[а-яё]*|алгоритм[а-яё]*|проанализир[а-яё]*|анализ[а-яё]*|аналитик[а-яё]*|отчёт[а-яё]*|отчет[а-яё]*|стратеги[а-яё]*|сравни[а-яё]*|договор[а-яё]*|юридическ[а-яё]*|подробн[а-яё]*|детальн[а-яё]*|разбер[а-яё]*|спланируй|распиши|исследуй|реши задач[а-яё]*)(?![а-яё])|claude|клод|посерьёзн[а-яё]*|посерьезн[а-яё]*|подумай хорошо/i;
const HARD_TOOL = /^(project_|code_|run_script|npm_install|git_|delegate_task|crm_|schedule_create)/;
const SENSITIVE_TOOL = /^(crm_|profile_|kb_|mentor_|fs_|screen_|camera_|browser_|call_)/;

/** Что за запрос: простой (болтовня, время, напоминание) или сложный (код, анализ, много шагов). */
export function classify(messages: ProviderMessage[]): Classification {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && m.content.some((b) => b.type === 'text')) {
      lastUserIdx = i;
      break;
    }
  }
  const text = lastUserIdx >= 0 ? messages[lastUserIdx]!.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ') : '';
  const turn = messages.slice(lastUserIdx + 1);
  const toolNames: string[] = [];
  let toolSteps = 0;
  let toolErrors = 0;
  for (const m of turn) {
    for (const b of m.content) {
      if (b.type === 'tool_use') toolNames.push(b.name);
      if (b.type === 'tool_result') {
        toolSteps += 1;
        if (b.isError) toolErrors += 1;
      }
    }
  }
  // Чувствительность смотрим по всей истории диалога: данные CRM, попавшие в контекст раньше, остаются в нём.
  const allNames = messages.flatMap((m) => m.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use').map((b) => b.name));
  const sensitive = allNames.some((n) => SENSITIVE_TOOL.test(n));
  if (text.length > 700) return { hard: true, sensitive, reason: 'длинный запрос' };
  if (HARD_RE.test(text)) return { hard: true, sensitive, reason: 'сложная задача (код/анализ/планирование)' };
  if (toolNames.some((n) => HARD_TOOL.test(n))) return { hard: true, sensitive, reason: 'работа с кодом или CRM' };
  if (toolSteps >= 4 || toolErrors >= 2) return { hard: true, sensitive, reason: 'много шагов' };
  return { hard: false, sensitive, reason: 'простой запрос' };
}

export interface RouterOptions {
  mode: RoutingMode;
  free: OpenAiCompatProvider[];
  claude: ChatProvider | null;
  claudeModel: string;
}

/**
 * Автовыбор модели. Простые запросы — бесплатные модели (по очереди, при сбое — следующая), сложные — Claude.
 * Если платная модель недоступна (нет ключа/баланса) — работаем на бесплатных; если бесплатные упали — идём в Claude.
 * Личные данные (досье, память, CRM, файлы) сторонним облакам не отправляются: для таких запросов только локальная модель или Claude.
 */
export class RoutingProvider implements ChatProvider {
  readonly id = 'auto';
  readonly name = 'Авто (бесплатные + Claude)';

  constructor(private o: RouterOptions) {}

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const cls = classify(req.messages);
    const { mode, free, claude } = this.o;
    const usableFree = cls.sensitive ? free.filter((p) => p.local) : free;

    type Cand = { p: ChatProvider; model: string; label: string };
    const claudeCand: Cand[] = claude ? [{ p: claude, model: this.o.claudeModel, label: 'Claude' }] : [];
    const freeCands: Cand[] = usableFree.map((p) => ({ p, model: p.model, label: p.name }));
    let order: Cand[];
    if (mode === 'claude') order = claudeCand;
    else if (mode === 'free') order = freeCands;
    else order = cls.hard ? [...claudeCand, ...freeCands] : [...freeCands, ...claudeCand];
    if (order.length === 0) {
      throw new ProviderHttpError(0, cls.sensitive && mode === 'free' ? 'Для запросов с личными данными нужна локальная модель (Ollama) или Claude: сторонним облакам такие данные не отправляются.' : 'Нет доступной модели. Включите бесплатную модель или добавьте ключ Claude.');
    }

    let lastErr: unknown = null;
    for (const c of order) {
      let started = false;
      try {
        const reason = `${cls.reason}${cls.sensitive ? ', личные данные' : ''}`;
        yield { type: 'route', provider: c.p.id, model: c.model, reason };
        for await (const ev of c.p.stream({ ...req, model: c.model }, signal)) {
          if (ev.type !== 'route') started = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (signal.aborted) return;
        if (started) throw e; // уже начали отвечать — переключаться нельзя, получится каша
        lastErr = e;
      }
    }
    throw lastErr;
  }
}
