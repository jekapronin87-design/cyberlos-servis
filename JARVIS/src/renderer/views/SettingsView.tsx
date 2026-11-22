import { useEffect, useState } from 'react';
import { MODULES, type AppInfo, type ModuleId, type Settings } from '../../shared/types';
import { ComputerAccessCard } from '../components/ComputerAccessCard';
import { uiSounds } from '../audio/uiSounds';
import { CrmCard } from '../components/CrmCard';
import { GatewayCard } from '../components/GatewayCard';
import { ModelsCard } from '../components/ModelsCard';
import { YoutubeCard } from '../components/YoutubeCard';
import { UpdateCard } from '../components/UpdateCard';
import { listSystemVoices, speak } from '../voice/speech';

const OPENAI_VOICES = ['onyx', 'ash', 'echo', 'fable', 'sage', 'verse', 'ballad', 'alloy', 'coral', 'nova', 'shimmer'];

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
  const [userName, setUserName] = useState(s.userName);
  const [aName, setAName] = useState(s.assistantName);
  const [ttsInstr, setTtsInstr] = useState(s.ttsInstructions);
  const [sysVoices, setSysVoices] = useState<{ name: string; lang: string }[]>([]);
  useEffect(() => {
    void listSystemVoices().then(setSysVoices);
  }, []);

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
        <h2>Личность</h2>
        <label className="field">
          <span>Имя ассистента (на него он откликается голосом; «Джарвис» тоже работает)</span>
          <div className="row">
            <input id="assistant-name" value={aName} onChange={(e) => setAName(e.target.value)} maxLength={30} />
            <button className="btn" disabled={aName.trim() === s.assistantName} onClick={() => run(() => props.onUpdate({ assistantName: aName.trim() }), 'Имя сохранено')}>
              Сохранить
            </button>
          </div>
        </label>
        <label className="check">
          <input id="ui-sounds" type="checkbox" checked={s.uiSounds} onChange={(e) => run(() => props.onUpdate({ uiSounds: e.target.checked }), 'Сохранено')} />
          <span>Звуки интерфейса <span className="muted small">(клики, переключатели, «пробуждение» на имя, начало ответа)</span></span>
        </label>
        <label className="field">
          <span>Громкость звуков интерфейса: {s.uiVolume}%</span>
          <div className="row">
            <input id="ui-volume" type="range" min={0} max={100} step={5} defaultValue={s.uiVolume} disabled={!s.uiSounds} onChange={(e) => { uiSounds.volume = Number(e.target.value) / 100; }} onMouseUp={(e) => void run(() => props.onUpdate({ uiVolume: Number((e.target as HTMLInputElement).value) }), 'Сохранено')} style={{ flex: 1 }} />
            <button className="btn" disabled={!s.uiSounds} onClick={() => void uiSounds.demo()}>Проверить звук</button>
          </div>
        </label>
        <label className="check">
          <input id="ui-ambient" type="checkbox" checked={s.uiAmbient} disabled={!s.uiSounds} onChange={(e) => run(() => props.onUpdate({ uiAmbient: e.target.checked }), 'Сохранено')} />
          <span>Тихий фон — «гул космоса»</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.fullscreen} onChange={(e) => run(() => props.onUpdate({ fullscreen: e.target.checked }), 'Сохранено')} />
          <span>Открывать на весь экран <span className="muted small">(F11 — переключить в любой момент)</span></span>
        </label>
        <label className="field">
          <span>Как к вам обращаться</span>
          <div className="row">
            <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Например: Евгений" maxLength={40} />
            <button className="btn" disabled={userName.trim() === s.userName} onClick={() => run(() => props.onUpdate({ userName: userName.trim() }), 'Имя сохранено')}>
              Сохранить
            </button>
          </div>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.profileEnabled} onChange={(e) => run(() => props.onUpdate({ profileEnabled: e.target.checked }), e.target.checked ? 'Досье используется в ответах' : 'Досье не используется')} />
          <span>
            Использовать <strong>досье</strong> о вас в ответах <span className="muted small">(раздел «Досье»; его текст уходит в запросы к ИИ)</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.launchAtLogin} onChange={(e) => run(() => props.onUpdate({ launchAtLogin: e.target.checked }), e.target.checked ? 'Системно будет запускаться вместе с Windows' : 'Автозапуск выключен')} />
          <span>Запускать Системно вместе с Windows</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoListen} onChange={(e) => run(() => props.onUpdate({ autoListen: e.target.checked }), e.target.checked ? 'При запуске Системно сразу начнёт слушать слово «Системно»' : 'Автопрослушивание выключено')} />
          <span>
            Сразу слушать своё имя при запуске <span className="muted small">(нужны разрешённый микрофон, режим «Системно» и ключ голоса; он поприветствует вас голосом)</span>
          </span>
        </label>
      </div>

      <div className="card">
        <h2>Камера</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={s.cameraEnabled}
            onChange={(e) => run(() => props.onUpdate({ cameraEnabled: e.target.checked }), e.target.checked ? 'Камера разрешена. Включайте её кнопкой «Камера» на главном экране' : 'Камера выключена')}
          />
          <span>
            <strong>Разрешить использование камеры</strong> (главный выключатель)
          </span>
        </label>
        <p className="muted small">
          Системно видит вас, только когда вы включили кнопку «Камера» (виден индикатор и превью) и попросили посмотреть: «Системно, что я сейчас делаю?».
          Кадр отправляется ИИ (Claude) один раз по запросу и хранится только до перезапуска приложения. Постоянного наблюдения нет.
        </p>
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
          <span>Беседа: сколько секунд слушать без слова-имени после обращения</span>
          <input id="voice-session" type="number" min={10} max={900} defaultValue={s.voiceSessionSec} onBlur={(e) => { const n = Number(e.target.value); if (n !== s.voiceSessionSec) void run(() => props.onUpdate({ voiceSessionSec: n }), 'Сохранено'); }} style={{ maxWidth: 140 }} />
        </label>
        <label className="field">
          <span>Режим микрофона</span>
          <select value={s.voiceMode} onChange={(e) => run(() => props.onUpdate({ voiceMode: e.target.value as Settings['voiceMode'] }), 'Сохранено')}>
            <option value="push">По кнопке: нажали «Микрофон», сказали фразу</option>
            <option value="wake">Постоянно слушать имя ассистента (каждая фраза отправляется на распознавание)</option>
          </select>
          <small className="muted">Скажите имя один раз («{s.assistantName}, доброе утро») — дальше можно разговаривать без него; фраза «пока» или «отбой» заканчивает беседу. Голосом можно сказать «стоп», чтобы остановить задачу. Опасные действия голосом не подтверждаются — только кнопкой в окне.</small>
        </label>
        <label className="field">
          <span>Озвучка ответов (на голосовые команды)</span>
          <select value={s.ttsMode} onChange={(e) => run(() => props.onUpdate({ ttsMode: e.target.value as Settings['ttsMode'] }), 'Сохранено')}>
            <option value="api">Облачный синтез речи — естественный голос (нужен ключ, рекомендуется)</option>
            <option value="system">Голоса Windows (бесплатно, звучат роботизированно)</option>
            <option value="off">Выключена</option>
          </select>
        </label>
        <label className="field">
          <span>Голос Системно (облачный)</span>
          <div className="row">
            <select value={OPENAI_VOICES.includes(s.ttsVoice) ? s.ttsVoice : 'onyx'} onChange={(e) => { setTtsVoice(e.target.value); void run(() => props.onUpdate({ ttsVoice: e.target.value }), 'Голос сохранён'); }}>
              {OPENAI_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}{v === 'onyx' ? ' — глубокий мужской (рекомендуется)' : v === 'ash' || v === 'echo' || v === 'fable' || v === 'sage' ? ' — мужской' : ''}
                </option>
              ))}
            </select>
            <button className="btn" onClick={async () => {
                setMsg({ ok: true, text: 'Проверяю голос…' });
                let failure = '';
                await speak('Добрый день. Это мой голос. Все системы работают в штатном режиме.', s.ttsMode, { systemVoice: s.systemVoice, speed: s.ttsSpeed, onError: (m) => (failure = m) });
                setMsg(failure ? { ok: false, text: failure } : { ok: true, text: 'Голос проигран. Если вы ничего не слышали, проверьте громкость и устройство вывода звука Windows.' });
              }}>
              ▶ Проверить голос
            </button>
          </div>
        </label>
        <label className="field">
          <span>Скорость речи: ×{s.ttsSpeed.toFixed(2)} {s.ttsSpeed >= 1.1 && s.ttsSpeed <= 1.25 ? '(живо, рекомендуется)' : ''}</span>
          <input type="range" min="0.8" max="1.5" step="0.05" value={s.ttsSpeed} onChange={(e) => void run(() => props.onUpdate({ ttsSpeed: Number(e.target.value) }), 'Скорость сохранена')} />
          <small className="muted">Если голос кажется медленным — сдвиньте вправо и нажмите «▶ Проверить голос».</small>
        </label>
        <label className="field">
          <span>Манера речи (для облачного голоса)</span>
          <textarea rows={2} value={ttsInstr} maxLength={500} onChange={(e) => setTtsInstr(e.target.value)} />
          <div className="row">
            <button className="btn" disabled={ttsInstr === s.ttsInstructions} onClick={() => run(() => props.onUpdate({ ttsInstructions: ttsInstr }), 'Манера речи сохранена')}>
              Сохранить манеру
            </button>
          </div>
        </label>
        <label className="field">
          <span>Голос Windows (если выбрана озвучка «голоса Windows»)</span>
          <select value={s.systemVoice} onChange={(e) => run(() => props.onUpdate({ systemVoice: e.target.value }), 'Голос сохранён')}>
            <option value="">Подобрать лучший русский автоматически</option>
            {sysVoices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
          {sysVoices.length === 0 && <small className="muted">Русские голоса Windows не найдены. Установите их: Параметры → Время и язык → Речь → Добавить голоса.</small>}
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
            {sttModel !== 'gpt-4o-transcribe' && <small className="muted">Точнее по-русски: <button type="button" className="link" onClick={() => setSttModel('gpt-4o-transcribe')}>gpt-4o-transcribe</button> (нажмите «Сохранить» ниже)</small>}
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

      <div className="card" id="modules-card">
        <h2>Модули</h2>
        <p className="muted small">Отключённый модуль полностью убирается: у ассистента пропадают его инструменты, а вкладки скрываются. Удобно, когда Системно ставится в другой компании или нужно убрать лишнее.</p>
        {MODULES.map((m) => (
          <label key={m.id} className="check">
            <input
              type="checkbox"
              checked={!s.disabledModules.includes(m.id)}
              onChange={(e) =>
                void run(() => props.onUpdate({ disabledModules: e.target.checked ? s.disabledModules.filter((x: ModuleId) => x !== m.id) : [...s.disabledModules, m.id] }), 'Сохранено')
              }
            />
            <span>
              <strong>{m.title}</strong> <span className="muted small">— {m.description}</span>
            </span>
          </label>
        ))}
      </div>

      <ModelsCard settings={s} onUpdate={async (p) => { await props.onUpdate(p); }} />

      {!s.disabledModules.includes('youtube') && <YoutubeCard settings={s} onUpdate={async (p) => { await props.onUpdate(p); }} />}

      <UpdateCard branch={s.updateBranch} onBranch={(b) => run(() => props.onUpdate({ updateBranch: b }), 'Ветка сохранена')} />

      <CrmCard />

      {!s.disabledModules.includes('gateway') && <GatewayCard settings={s} onUpdate={async (p) => { await props.onUpdate(p); }} />}

      <ComputerAccessCard />

      <div className="card" id="browser-card">
        <h2>Браузер ассистента</h2>
        <p className="muted small">
          Ассистент работает в отдельном окне браузера со своим профилем: один раз войдите там в нужные сайты сами (пароли Системно не вводит) — вход сохранится. Он умеет искать, открывать страницы, читать, прокручивать, нажимать, вводить текст и делать снимок страницы.
        </p>
        <label className="check">
          <input id="browser-auto" type="checkbox" checked={s.browserAutoApprove} onChange={(e) => run(() => props.onUpdate({ browserAutoApprove: e.target.checked }), 'Сохранено')} />
          <span>
            <strong>Не спрашивать подтверждение на обычные клики и ввод</strong>{' '}
            <span className="muted small">— быстрее, без окон на каждый шаг. Всё равно спрашивает: открытие нового сайта и поиск, нажатие Enter, кнопки «оплатить / отправить / удалить / подтвердить / опубликовать», банки и платёжные сайты. Пароли, карты и коды он не вводит никогда.</span>
          </span>
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
