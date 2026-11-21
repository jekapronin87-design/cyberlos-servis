import { useState } from 'react';
import type { AppInfo, Settings } from '../../shared/types';

export function SettingsView(props: {
  settings: Settings;
  info: AppInfo | null;
  onUpdate: (patch: Partial<Settings>) => Promise<void>;
  onSetKey: (key: string) => Promise<void>;
  onClearKey: () => Promise<void>;
  onSetVoiceKey: (key: string) => Promise<void>;
  onClearVoiceKey: () => Promise<void>;
}) {
  const { settings: s, info } = props;
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [instr, setInstr] = useState(s.customInstructions);
  const [model, setModel] = useState(s.model);
  const [vkey, setVkey] = useState('');
  const [vurl, setVurl] = useState(s.voiceBaseUrl);
  const [sttModel, setSttModel] = useState(s.sttModel);
  const [ttsModel, setTtsModel] = useState(s.ttsModel);
  const [ttsVoice, setTtsVoice] = useState(s.ttsVoice);

  const run = async (fn: () => Promise<void>, okText: string): Promise<void> => {
    try {
      await fn();
      setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка' });
    }
  };

  return (
    <section className="page">
      <h1>Настройки</h1>
      {msg && (
        <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`} role="status">
          {msg.text}
        </div>
      )}

      <div className="card">
        <h2>Модель ИИ</h2>
        <p className="muted">
          Сейчас: <strong>{info?.providerName}</strong> {info?.mode === 'demo' ? '(демо — без обращения к сети)' : `· ${info?.model}`}
        </p>
        <label className="field">
          <span>Провайдер</span>
          <select value={s.provider} onChange={(e) => run(() => props.onUpdate({ provider: e.target.value as Settings['provider'] }), 'Сохранено')}>
            <option value="auto">Авто (ключ есть — Claude, иначе демо)</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="demo">Только демо-режим</option>
          </select>
        </label>
        <label className="field">
          <span>Модель</span>
          <div className="row">
            <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
            <button className="btn" disabled={model === s.model} onClick={() => run(() => props.onUpdate({ model }), 'Модель сохранена')}>
              Сохранить
            </button>
          </div>
        </label>
        <label className="field">
          <span>API-ключ Anthropic {info?.hasApiKey && <em className="ok">· задан</em>}</span>
          <div className="row">
            <input
              type="password"
              value={key}
              placeholder={info?.hasApiKey ? '•••••••• (введите новый, чтобы заменить)' : 'sk-ant-…'}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              className="btn btn-primary"
              disabled={!key.trim()}
              onClick={() =>
                run(async () => {
                  await props.onSetKey(key);
                  setKey('');
                }, 'Ключ сохранён')
              }
            >
              Сохранить
            </button>
            <button className="btn" disabled={!info?.hasApiKey} onClick={() => run(props.onClearKey, 'Ключ удалён')}>
              Удалить
            </button>
          </div>
          <small className="muted">
            {info?.secretsEncrypted
              ? 'Ключ хранится в зашифрованном виде средствами операционной системы и не передаётся в интерфейс.'
              : 'Шифрование ОС недоступно: ключ будет жить только до закрытия приложения и не сохраняется на диск.'}
          </small>
        </label>
      </div>

      <div className="card">
        <h2>Голос</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={s.micEnabled}
            onChange={(e) => run(() => props.onUpdate({ micEnabled: e.target.checked }), e.target.checked ? 'Микрофон разрешён' : 'Микрофон выключен')}
          />
          <span>
            <strong>Разрешить использование микрофона</strong> (главный выключатель; после запуска приложения прослушивание всегда выключено)
          </span>
        </label>
        <label className="field">
          <span>Режим микрофона</span>
          <select value={s.voiceMode} onChange={(e) => run(() => props.onUpdate({ voiceMode: e.target.value as Settings['voiceMode'] }), 'Сохранено')}>
            <option value="push">По кнопке: нажали «Микрофон», сказали фразу</option>
            <option value="wake">Постоянно слушать слово «Джарвис» (каждая фраза отправляется на распознавание)</option>
          </select>
          <small className="muted">Голосом можно сказать «стоп», чтобы остановить задачу. Опасные действия голосом не подтверждаются — только кнопкой в окне.</small>
        </label>
        <label className="field">
          <span>Озвучка ответов (на голосовые команды)</span>
          <select value={s.ttsMode} onChange={(e) => run(() => props.onUpdate({ ttsMode: e.target.value as Settings['ttsMode'] }), 'Сохранено')}>
            <option value="system">Голоса Windows (бесплатно, без ключа)</option>
            <option value="api">Облачный синтез речи (качественнее, нужен ключ)</option>
            <option value="off">Выключена</option>
          </select>
        </label>
        <label className="field">
          <span>Ключ API распознавания/синтеза речи {info?.hasVoiceKey && <em className="ok">· задан</em>}</span>
          <div className="row">
            <input type="password" value={vkey} placeholder={info?.hasVoiceKey ? '•••••••• (введите новый, чтобы заменить)' : 'sk-…'} onChange={(e) => setVkey(e.target.value)} autoComplete="off" spellCheck={false} />
            <button
              className="btn btn-primary"
              disabled={!vkey.trim()}
              onClick={() =>
                run(async () => {
                  await props.onSetVoiceKey(vkey);
                  setVkey('');
                }, 'Ключ голоса сохранён')
              }
            >
              Сохранить
            </button>
            <button className="btn" disabled={!info?.hasVoiceKey} onClick={() => run(props.onClearVoiceKey, 'Ключ голоса удалён')}>
              Удалить
            </button>
          </div>
          <small className="muted">Звук и текст отправляются на указанный ниже адрес. Ключ хранится так же, как ключ Claude, — зашифрованно.</small>
        </label>
        <label className="field">
          <span>Адрес API (OpenAI-совместимый)</span>
          <div className="row">
            <input value={vurl} onChange={(e) => setVurl(e.target.value)} spellCheck={false} />
            <button className="btn" disabled={vurl === s.voiceBaseUrl} onClick={() => run(() => props.onUpdate({ voiceBaseUrl: vurl }), 'Адрес сохранён')}>
              Сохранить
            </button>
          </div>
        </label>
        <div className="row">
          <label className="field grow">
            <span>Модель распознавания</span>
            <input value={sttModel} onChange={(e) => setSttModel(e.target.value)} spellCheck={false} />
          </label>
          <label className="field grow">
            <span>Модель синтеза</span>
            <input value={ttsModel} onChange={(e) => setTtsModel(e.target.value)} spellCheck={false} />
          </label>
          <label className="field grow">
            <span>Голос</span>
            <input value={ttsVoice} onChange={(e) => setTtsVoice(e.target.value)} spellCheck={false} />
          </label>
        </div>
        <button
          className="btn"
          disabled={sttModel === s.sttModel && ttsModel === s.ttsModel && ttsVoice === s.ttsVoice}
          onClick={() => run(() => props.onUpdate({ sttModel, ttsModel, ttsVoice }), 'Модели сохранены')}
        >
          Сохранить модели
        </button>
      </div>

      <div className="card">
        <h2>Поведение</h2>
        <label className="field">
          <span>Тема</span>
          <select value={s.theme} onChange={(e) => run(() => props.onUpdate({ theme: e.target.value as Settings['theme'] }), 'Сохранено')}>
            <option value="dark">Тёмная</option>
            <option value="light">Светлая</option>
            <option value="system">Как в системе</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.memoryEnabled} onChange={(e) => run(() => props.onUpdate({ memoryEnabled: e.target.checked }), 'Сохранено')} />
          <span>Использовать долговременную память в ответах</span>
        </label>
        <label className="field">
          <span>Свои инструкции к стилю ответов</span>
          <textarea value={instr} rows={3} maxLength={4000} onChange={(e) => setInstr(e.target.value)} placeholder="Например: обращайся на «вы», отвечай кратко" />
          <div className="row">
            <button className="btn" disabled={instr === s.customInstructions} onClick={() => run(() => props.onUpdate({ customInstructions: instr }), 'Инструкции сохранены')}>
              Сохранить инструкции
            </button>
          </div>
        </label>
      </div>

      <div className="card">
        <h2>Безопасность</h2>
        <label className="field">
          <span>Запрашивать подтверждение для действий</span>
          <select value={s.confirmFrom} onChange={(e) => run(() => props.onUpdate({ confirmFrom: e.target.value as Settings['confirmFrom'] }), 'Сохранено')}>
            <option value="medium">среднего риска и выше (рекомендуется)</option>
            <option value="low">низкого риска и выше (строго)</option>
          </select>
          <small className="muted">Опасные (high) действия всегда требуют подтверждения; критические запрещены.</small>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.allowProductionWrites}
            onChange={(e) => {
              if (e.target.checked && !window.confirm('Разрешить ассистенту ИЗМЕНЯТЬ производственные данные CRM (с подтверждением каждого действия)? Рекомендуется оставить выключенным.')) return;
              void run(() => props.onUpdate({ allowProductionWrites: e.target.checked }), 'Сохранено');
            }}
          />
          <span>Разрешить изменение производственных данных CRM (по умолчанию выключено)</span>
        </label>
        <dl className="kv">
          <dt>Роль</dt>
          <dd>{info?.role}</dd>
          <dt>Данные хранятся</dt>
          <dd>
            <code>{info?.dataDir}</code>
          </dd>
        </dl>
      </div>
    </section>
  );
}
