import { useCallback, useEffect, useState } from 'react';
import type { FreeProviderConfig, ProviderStatusDto, Settings } from '../../shared/types';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function ModelsCard({ settings, onUpdate }: { settings: Settings; onUpdate: (p: Partial<Settings>) => Promise<void> }) {
  const [list, setList] = useState<ProviderStatusDto[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [top, setTop] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => setList(await window.jarvis.models.list()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (id: string, change: Partial<FreeProviderConfig>): Promise<void> => {
    try {
      await onUpdate({ freeProviders: settings.freeProviders.map((c) => (c.id === id ? { ...c, ...change } : c)) });
      await load();
      setTop(null);
    } catch (e) {
      setTop({ ok: false, text: clean(e) });
    }
  };

  const say = (id: string, ok: boolean, text: string): void => setMsg((m) => ({ ...m, [id]: { ok, text } }));

  const test = async (p: ProviderStatusDto): Promise<void> => {
    setBusy(p.id);
    say(p.id, true, 'Проверяю…');
    try {
      const r = await window.jarvis.models.test(p.id);
      say(p.id, true, `Работает. Ответ модели: «${r.slice(0, 60)}»`);
    } catch (e) {
      say(p.id, false, clean(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" id="models-card">
      <h2>Модели и экономия</h2>
      <p className="muted small">
        Подключите бесплатные модели — Системно сам решит, кому отдать запрос: простое (разговор, время, напоминания) делают бесплатные, сложное (код, анализ, много шагов) — Claude. Если бесплатная модель не отвечает или упёрлась в лимит — запрос уйдёт на следующую.
        <strong> Личные данные</strong> (досье, память, CRM, файлы) сторонним облачным моделям не отправляются — только локальной (Ollama) или Claude.
      </p>
      {top && <div className={`banner ${top.ok ? 'banner-ok' : 'banner-err'}`}>{top.text}</div>}
      <label className="field">
        <span>Режим</span>
        <select id="routing-mode" value={settings.routingMode} onChange={(e) => void onUpdate({ routingMode: e.target.value as Settings['routingMode'] }).catch((er) => setTop({ ok: false, text: clean(er) }))}>
          <option value="smart">Авто: простое — бесплатные, сложное — Claude (рекомендуется)</option>
          <option value="free">Только бесплатные (платный Claude не используется никогда)</option>
          <option value="claude">Только Claude</option>
        </select>
      </label>
      {list.map((p) => (
        <div key={p.id} className="list-item" style={{ display: 'block' }} data-provider={p.id}>
          <label className="check">
            <input type="checkbox" checked={p.enabled} onChange={(e) => void patch(p.id, { enabled: e.target.checked })} />
            <span>
              <strong>{p.name}</strong> {p.local && <span className="tag">на этом компьютере</span>} {p.needsKey && !p.hasKey && <span className="tag">нужен ключ</span>}
              {p.needsKey && p.hasKey && <span className="tag">ключ сохранён</span>}
            </span>
          </label>
          <p className="muted small" style={{ margin: '2px 0 6px 26px' }}>{p.help}</p>
          {p.enabled && (
            <div style={{ marginLeft: 26 }}>
              <div className="row">
                <input aria-label="Модель" defaultValue={p.model} placeholder="Название модели" onBlur={(e) => e.target.value !== p.model && void patch(p.id, { model: e.target.value.trim() })} />
                {p.id === 'custom' && <input aria-label="Адрес" defaultValue={p.baseUrl} placeholder="https://…/v1" onBlur={(e) => e.target.value !== p.baseUrl && void patch(p.id, { baseUrl: e.target.value.trim() })} />}
              </div>
              {p.needsKey && (
                <div className="row" style={{ marginTop: 6 }}>
                  <input type="password" aria-label="Ключ" placeholder={p.hasKey ? 'Ключ сохранён — вставьте новый, чтобы заменить' : 'Вставьте API-ключ'} value={keys[p.id] ?? ''} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} autoComplete="off" />
                  <button className="btn" disabled={!(keys[p.id] ?? '').trim()} onClick={() => void window.jarvis.models.setKey(p.id, keys[p.id]!).then((l) => { setList(l); setKeys({ ...keys, [p.id]: '' }); say(p.id, true, 'Ключ сохранён (хранится зашифрованным)'); }).catch((e) => say(p.id, false, clean(e)))}>
                    Сохранить ключ
                  </button>
                  {p.hasKey && <button className="btn btn-danger" onClick={() => void window.jarvis.models.clearKey(p.id).then(setList)}>Удалить ключ</button>}
                </div>
              )}
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn" disabled={busy === p.id} onClick={() => void test(p)}>Проверить</button>
                {msg[p.id] && <span className={msg[p.id]!.ok ? 'ok small' : 'small'} style={msg[p.id]!.ok ? undefined : { color: 'var(--danger, #f88)' }}>{msg[p.id]!.text}</span>}
              </div>
            </div>
          )}
        </div>
      ))}
      <label className="field" style={{ marginTop: 12 }}>
        <span>Модель для картинок (ключ OpenAI — тот же, что для голоса)</span>
        <input value={settings.imageModel} onChange={(e) => void onUpdate({ imageModel: e.target.value.trim() }).catch(() => undefined)} />
      </label>
    </div>
  );
}
