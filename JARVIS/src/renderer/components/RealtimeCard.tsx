import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { testRealtime } from '../voice/realtime';

const VOICES: [string, string][] = [
  ['cedar', 'cedar — глубокий мужской (рекомендуется)'],
  ['ash', 'ash — мужской'],
  ['echo', 'echo — мужской'],
  ['verse', 'verse — мужской, выразительный'],
  ['marin', 'marin — женский, естественный'],
  ['coral', 'coral — женский'],
  ['shimmer', 'shimmer — женский'],
  ['sage', 'sage'],
  ['ballad', 'ballad'],
  ['alloy', 'alloy'],
];
const MODELS: [string, string][] = [
  ['gpt-realtime', 'gpt-realtime — лучшее качество (дороже)'],
  ['gpt-realtime-mini', 'gpt-realtime-mini — дешевле, чуть проще'],
];

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function RealtimeCard({ settings: s, onUpdate }: { settings: Settings; onUpdate: (p: Partial<Settings>) => Promise<void> }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => {
    void window.jarvis.app.info().then((i) => setHasKey(i.hasVoiceKey), () => setHasKey(null));
  }, []);
  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };
  const on = s.voiceEngine === 'realtime';
  return (
    <div className="card" id="realtime-card">
      <h2>Живой разговор (как в голосовом режиме ChatGPT)</h2>
      <p className="muted small">
        Голос в голос через OpenAI Realtime: ассистент слушает и отвечает почти мгновенно, без пауз «распознал → подумал → озвучил», его можно перебивать. Все дела (CRM, файлы, браузер, программы, память) он по-прежнему делает через ядро Системно со всеми правами и подтверждениями; голосом опасные действия не подтверждаются.
      </p>
      <div className="banner banner-demo">
        <strong>Что важно знать.</strong> Пока разговор идёт, звук передаётся в OpenAI, а их голосовая модель пересказывает вам ответы ассистента (включая данные CRM; телефоны и почта скрываются). Разговор <strong>платный по минутам</strong> (тариф OpenAI смотрите на их сайте), поэтому он включается кнопкой микрофона и сам заканчивается после тишины ({Math.round(s.voiceSessionSec / 60)} мин — это настройка «беседа» выше) или по слову «пока». Работает только с ключом OpenAI.
      </div>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      <div className="rt-status" data-testid="rt-status">
        <span className={`pill ${on ? 'on' : 'off'}`}>{on ? '● Живой разговор ВКЛЮЧЁН' : '○ Живой разговор выключен (сейчас обычный режим)'}</span>
        {hasKey === false && <span className="muted small">⚠ Нет ключа OpenAI — добавьте его в «Голос» выше.</span>}
        {!s.micEnabled && <span className="muted small">⚠ Микрофон не разрешён — включите «Разрешить использование микрофона» в блоке «Голос».</span>}
      </div>
      <div className="row">
        {!on ? (
          <button className="btn btn-primary rt-big" id="rt-enable" disabled={busy} onClick={() => void run(() => onUpdate({ voiceEngine: 'realtime' }), 'Включено. Теперь на главном экране нажмите кнопку «Живой разговор» (внизу слева) — и говорите.')}>
            ▶ Включить живой разговор
          </button>
        ) : (
          <button className="btn rt-big" id="rt-disable" disabled={busy} onClick={() => void run(() => onUpdate({ voiceEngine: 'classic' }), 'Выключено: снова обычный режим (слово «Системно»).')}>
            ■ Выключить живой разговор
          </button>
        )}
      </div>
      <ol className="small muted" style={{ margin: '8px 0' }}>
        <li>Нажмите «Включить живой разговор».</li>
        <li>Перейдите на главный экран («Системно» в меню слева): внизу будет кнопка <strong>«Живой разговор»</strong> — нажмите её и говорите. Ещё там можно переключать режим «Голос: Обычный / Живой разговор».</li>
        <li>Чтобы закончить — скажите «пока» или нажмите ту же кнопку.</li>
      </ol>
      <p className="muted small">Озвучка «Голоса Windows / Облачный синтез» ниже относится только к <strong>обычному</strong> режиму. В живом разговоре говорит голос OpenAI — его вы выбираете в этой карточке.</p>
      <div className="row">
        <label className="field grow">
          <span>Модель</span>
          <select value={MODELS.some((m) => m[0] === s.realtimeModel) ? s.realtimeModel : '__other'} onChange={(e) => e.target.value !== '__other' && void run(() => onUpdate({ realtimeModel: e.target.value }), 'Модель сохранена')}>
            {MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            {!MODELS.some((m) => m[0] === s.realtimeModel) && <option value="__other">{s.realtimeModel} (своя)</option>}
          </select>
        </label>
        <label className="field grow">
          <span>Голос</span>
          <select value={s.realtimeVoice} onChange={(e) => void run(() => onUpdate({ realtimeVoice: e.target.value }), 'Голос сохранён')}>
            {VOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Терпение к паузам</span>
        <select value={s.realtimePatience} onChange={(e) => void run(() => onUpdate({ realtimePatience: e.target.value as Settings['realtimePatience'] }), 'Сохранено (применится к следующему разговору)')}>
          <option value="fast">Быстро — отвечает почти сразу после паузы</option>
          <option value="normal">Обычно</option>
          <option value="patient">Долго — дожидается конца длинной мысли (рекомендуется, если вы говорите много)</option>
        </select>
      </label>
      <div className="row">
        <button className="btn" id="rt-test" disabled={busy} onClick={() => void run(async () => setMsg({ ok: true, text: await testRealtime() }), '')}>
          Проверить доступ (без разговора)
        </button>
      </div>
      <small className="muted">Проверка создаёт сессию и сразу её закрывает — звук не передаётся. Если пишет «не нашёл модель» или «нет доступа» — выберите другую модель или проверьте счёт и доступ аккаунта OpenAI.</small>
    </div>
  );
}
