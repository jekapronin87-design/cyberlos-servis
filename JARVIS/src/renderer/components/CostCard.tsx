import { useCallback, useEffect, useState } from 'react';
import type { Settings, UsageDto } from '../../shared/types';

const clean = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка');
const fmtTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} млн` : n >= 1000 ? `${Math.round(n / 1000)} тыс.` : String(n));
const usd = (n: number): string => `$${n.toFixed(2)}`;
const CHEAP = 'claude-haiku-5-5';

/** Расходы на платную модель: сколько потрачено, дневной лимит, самая дешёвая модель, экономия токенов. */
export function CostCard({ settings: s, onUpdate }: { settings: Settings; onUpdate: (p: Partial<Settings>) => Promise<void> }) {
  const [u, setU] = useState<UsageDto | null>(null);
  const [budget, setBudget] = useState(String(s.dailyBudgetUsd));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setU(await window.jarvis.usage.get());
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => setBudget(String(s.dailyBudgetUsd)), [s.dailyBudgetUsd]);

  const run = async (fn: () => Promise<void>, ok: string): Promise<void> => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };
  const cheap = /haiku/i.test(s.model);

  return (
    <div className="card" id="cost-card">
      <h2>Расходы на ИИ</h2>
      <p className="muted small">
        Платит ваш счёт Anthropic (API) — он отдельный от подписки Claude. Программа считает токены сама и <strong>примерно</strong> переводит их в доллары (цены за семейство модели). Точная сумма — в console.anthropic.com → Billing.
      </p>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      <div className="cost-tiles">
        <div className="cost-t"><b>{u ? usd(u.today.usd) : '—'}</b><span>сегодня · {u?.today.calls ?? 0} запросов</span></div>
        <div className="cost-t"><b>{u ? usd(u.month.usd) : '—'}</b><span>за месяц · {u ? fmtTok(u.month.tokens) : '—'} токенов</span></div>
        <div className="cost-t"><b>{s.dailyBudgetUsd > 0 ? usd(s.dailyBudgetUsd) : 'нет'}</b><span>дневной лимит</span></div>
      </div>
      {u && u.rows.length > 0 && (
        <ul className="small cost-rows">
          {u.rows.map((r) => (
            <li key={r.model}><code>{r.model}</code> — {usd(r.usd)} · {r.calls} запросов · вход {fmtTok(r.input)}, из кэша {fmtTok(r.cacheRead)}, выход {fmtTok(r.output)}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <label className="field">
          <span>Дневной лимит расходов на Claude, $ (0 — без лимита)</span>
          <div className="row">
            <input id="budget" type="number" min={0} max={10000} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} style={{ maxWidth: 140 }} />
            <button className="btn" onClick={() => void run(() => onUpdate({ dailyBudgetUsd: Number(budget) }), 'Лимит сохранён')}>Сохранить</button>
          </div>
          <small className="muted">Когда лимит на сегодня исчерпан, запросы к Claude останавливаются (или идут на бесплатные модели, если они настроены) — больше этой суммы за день не уйдёт.</small>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.smartTools} onChange={(e) => void run(() => onUpdate({ smartTools: e.target.checked }), e.target.checked ? 'Экономия включена' : 'Теперь модели отправляются все инструменты (дороже)')} />
        <span><strong>Экономить токены:</strong> отправлять модели только нужные инструменты и использовать кэш. Раньше КАЖДЫЙ запрос нёс описание всех ~80 инструментов (около 9 500 токенов) — это главная причина дорогих запросов.</span>
      </label>
      <div className="row">
        <span className="small">Модель: <code>{s.model}</code>{cheap ? ' — самая дешёвая' : ''}</span>
        {!cheap && <button className="btn btn-primary" id="cheap-model" onClick={() => void run(() => onUpdate({ model: CHEAP }), 'Включена самая дешёвая модель Claude (Haiku): примерно в 3–5 раз дешевле Sonnet')}>Переключить на самую дешёвую (Haiku)</button>}
      </div>
      <p className="muted small">Ещё дешевле: бесплатные модели (Gemini, Groq, Ollama на этом компьютере) в «Настройки → Модели» — простое пойдёт на них, а Claude останется для сложного. Платными остаются и голос OpenAI (распознавание, озвучка, «Живой разговор» — дороже всего), и картинки.</p>
    </div>
  );
}
