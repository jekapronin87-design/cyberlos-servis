import { useEffect, useState } from 'react';
import type { ProfileSection } from '../../shared/types';
import { formatTime } from '../format';

const clean = (e: unknown): string =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка';

export function ProfileView(props: {
  enabled: boolean;
  onIntroduce: () => void;
  onImportedText: (name: string, text: string, truncated: boolean) => void;
}) {
  const [sections, setSections] = useState<ProfileSection[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async (): Promise<void> => {
    const list = await window.jarvis.profile.get();
    setSections(list);
    setDrafts(Object.fromEntries(list.map((s) => [s.id, s.body])));
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (id: string): Promise<void> => {
    try {
      const list = await window.jarvis.profile.set(id, drafts[id] ?? '');
      setSections(list);
      setMsg({ ok: true, text: 'Сохранено' });
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  const filled = sections.filter((s) => s.body).length;

  return (
    <section className="page">
      <h1>Досье</h1>
      <p className="muted">
        Здесь хранится то, что Джарвис знает о вас. Он знает <strong>только это</strong> (и «Память») — ничего не придумывает. Всё видно и редактируется вами; заполнено разделов:{' '}
        <strong>{filled}</strong> из {sections.length}.
      </p>
      {!props.enabled && <div className="banner banner-demo">Досье выключено в настройках — Джарвис его сейчас не использует.</div>}
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

      <div className="card">
        <h2>Как наполнить досье</h2>
        <div className="row">
          <button className="btn btn-primary" onClick={props.onIntroduce}>
            🎙 Познакомиться с Джарвисом
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                const f = await window.jarvis.profile.importFile();
                if (f) props.onImportedText(f.name, f.text, f.truncated);
              } catch (e) {
                setMsg({ ok: false, text: clean(e) });
              }
            }}
          >
            📄 Импорт из файла…
          </button>
          <button
            className="btn"
            disabled={filled === 0}
            onClick={async () => {
              if (!window.confirm('Стереть всё досье? Это нельзя отменить.')) return;
              setSections(await window.jarvis.profile.clear());
              await load();
              setMsg({ ok: true, text: 'Досье очищено' });
            }}
          >
            Очистить всё
          </button>
        </div>
        <ul className="muted small">
          <li>«Познакомиться»: Джарвис задаст вопросы по одному (можно отвечать голосом), в конце покажет, что собирается сохранить, — вы подтверждаете.</li>
          <li>«Импорт из файла»: текстовый файл (заметки, резюме, описание бизнеса, выгрузка памяти из любого ИИ-сервиса). Джарвис выделит важное и предложит сохранить.</li>
          <li>Можно просто писать ниже вручную.</li>
          <li>
            <strong>Приватность:</strong> досье лежит на этом компьютере и добавляется к вашим запросам к ИИ (Claude), поэтому не пишите сюда пароли, номера карт и ключи — их программа не примет.
          </li>
        </ul>
      </div>

      {sections.map((s) => (
        <div className="card" key={s.id}>
          <h2>{s.title}</h2>
          <textarea
            rows={4}
            value={drafts[s.id] ?? ''}
            maxLength={4000}
            placeholder={s.hint}
            onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
            style={{ width: '100%' }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" disabled={(drafts[s.id] ?? '') === s.body} onClick={() => void save(s.id)}>
              Сохранить
            </button>
            <span className="muted small">{s.updatedAt ? `обновлено ${formatTime(s.updatedAt)}` : 'пусто'}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
