import { useRef, useState } from 'react';
import { VoiceListener } from '../voice/listener';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

/** Проверка микрофона: слышит ли программа вас и что именно распознаёт — по шагам, чтобы было видно, где обрыв. */
export function MicTest({ micEnabled }: { micEnabled: boolean }) {
  const [state, setState] = useState<'idle' | 'listen' | 'recognize'>('idle');
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [steps, setSteps] = useState<{ ok: boolean; text: string }[]>([]);
  const ref = useRef<VoiceListener | null>(null);

  const start = async (): Promise<void> => {
    setSteps([]);
    setPeak(0);
    if (!micEnabled) {
      setSteps([{ ok: false, text: 'Микрофон выключен в настройках: включите «Микрофон» выше.' }]);
      return;
    }
    const info = await window.jarvis.app.info();
    if (!info.hasVoiceKey) {
      setSteps([{ ok: false, text: 'Нет ключа голоса (OpenAI): без него речь не распознаётся. Добавьте его в «Ключ API голоса».' }]);
      return;
    }
    setState('listen');
    setSteps([{ ok: true, text: 'Скажите фразу, например: «Системно, доброе утро» (до 8 секунд).' }]);
    let got = false;
    const l = new VoiceListener({
      continuous: false,
      onState: (s) => {
        if (s === 'idle') {
          setState((cur) => (cur === 'listen' ? 'idle' : cur));
          setLevel(0);
          if (!got) setSteps((p) => [...p, { ok: false, text: 'Речь не услышана: уровень звука слишком низкий. Проверьте, что выбран нужный микрофон в Windows (Параметры → Система → Звук → Ввод) и что он не отключён.' }]);
        }
      },
      onLevel: (v) => {
        setLevel(v);
        setPeak((p) => Math.max(p, v));
      },
      onError: (m) => setSteps((p) => [...p, { ok: false, text: m }]),
      onUtterance: (blob) => {
        got = true;
        setState('recognize');
        setSteps((p) => [...p, { ok: true, text: `Звук записан (${Math.round(blob.size / 1024)} КБ). Распознаю…` }]);
        void blob.arrayBuffer().then((buf) => window.jarvis.voice.transcribe(new Uint8Array(buf), blob.type || 'audio/wav')).then(
          (t) => setSteps((p) => [...p, t.trim() ? { ok: true, text: `Услышал: «${t.trim()}»` } : { ok: false, text: 'Сервис распознавания вернул пустой ответ (тишина или неразборчиво). Говорите ближе и громче.' }]),
          (e) => setSteps((p) => [...p, { ok: false, text: `Распознавание не удалось: ${clean(e)}` }]),
        ).finally(() => setState('idle'));
      },
    });
    ref.current = l;
    await l.start();
  };

  return (
    <div className="card" id="mic-test" style={{ marginTop: 10 }}>
      <h3 style={{ marginTop: 0 }}>Проверить микрофон</h3>
      <div className="row">
        <button className="btn" id="mic-test-btn" disabled={state !== 'idle'} onClick={() => void start()}>{state === 'listen' ? 'Слушаю…' : state === 'recognize' ? 'Распознаю…' : 'Проверить'}</button>
        <div style={{ flex: 1, height: 10, background: 'rgba(80,160,220,0.15)', borderRadius: 5, overflow: 'hidden' }} aria-label="Уровень звука">
          <div style={{ width: `${Math.round(level * 100)}%`, height: '100%', background: 'linear-gradient(90deg,#2aa9ff,#7fe0ff)', transition: 'width 60ms' }} />
        </div>
        <span className="muted small">пик: {Math.round(peak * 100)}%</span>
      </div>
      {steps.map((s, i) => (
        <p key={i} className={s.ok ? 'small' : 'small'} style={{ color: s.ok ? undefined : 'var(--danger, #f88)', margin: '4px 0' }}>{s.ok ? '✓' : '✗'} {s.text}</p>
      ))}
    </div>
  );
}
