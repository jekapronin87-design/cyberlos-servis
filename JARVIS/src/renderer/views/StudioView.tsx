import { useCallback, useEffect, useMemo, useState } from 'react';
import type { YtUploadResultDto, YtUploadStatusDto, VideoFileDto, VideoLayout, VideoPlanDto, VideoResultDto, VideoSpecDto, VideoStatusDto, VideoStepDto, VideoTrackDto } from '../../shared/types';

const clean = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка');
const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const LAYOUTS: { id: VideoLayout; title: string; text: string }[] = [
  { id: 'talk', title: 'Только вы', text: 'Ваше видео на весь экран + субтитры' },
  { id: 'reaction-split', title: 'Экран пополам', text: 'Сверху видео, которое показываете, снизу вы; потом ваш рассказ' },
  { id: 'reaction-pip', title: 'Кружок', text: 'Видео на весь экран, вы в кружке; потом ваш рассказ' },
];

function LayoutIcon({ id }: { id: VideoLayout }) {
  return (
    <span className={`lay-ic lay-${id}`} aria-hidden="true">
      <i />
      <b />
    </span>
  );
}

const STEP_ICON: Record<VideoStepDto['status'], string> = { wait: '○', run: '◌', done: '✓', error: '✕', skip: '–' };

/** Монтажный стол: дорожки, клипы, раскадровка, бегущая отметка прогресса. Всё анимировано в космическом стиле. */
export function Timeline({ plan }: { plan: VideoPlanDto }) {
  const render = plan.steps.find((s) => s.id === 'render');
  const head = plan.finished ? (plan.error ? 0 : 100) : render?.status === 'run' || render?.status === 'done' ? (render.pct ?? 0) : 0;
  return (
    <div className="tl" data-testid="timeline">
      <div className="tl-steps">
        {plan.steps.map((s) => (
          <div key={s.id} className={`tl-step st-${s.status}`} data-status={s.status}>
            <span className="tl-ic">{STEP_ICON[s.status]}</span>
            <span className="tl-sl">{s.label}</span>
            {s.status === 'run' && s.pct !== undefined && <em>{s.pct}%</em>}
          </div>
        ))}
      </div>
      <div className="tl-board">
        <div className="tl-ruler">
          {Array.from({ length: Math.min(12, Math.max(2, Math.ceil(plan.duration / 5))) + 1 }, (_, i) => i).map((i, _k, a) => (
            <span key={i} style={{ left: `${(i / (a.length - 1)) * 100}%` }}>{plan.duration ? mmss((i / (a.length - 1)) * plan.duration) : ''}</span>
          ))}
        </div>
        {plan.tracks.map((t: VideoTrackDto, ti) => (
          <div key={t.id} className="tl-row" style={{ ['--ti' as string]: ti }}>
            <div className="tl-label">{t.label}</div>
            <div className={`tl-lane kind-${t.kind}`}>
              {t.clips.map((c, ci) => (
                <div key={ci} className="tl-clip" style={{ left: `${(c.start / (plan.duration || 1)) * 100}%`, width: `${Math.max(0.6, ((c.end - c.start) / (plan.duration || 1)) * 100)}%`, ['--ci' as string]: ci }} title={`${c.label} · ${mmss(c.start)}–${mmss(c.end)}`}>
                  {c.thumbs && c.thumbs.length > 0 && (
                    <span className="tl-thumbs">{c.thumbs.map((src, k) => <img key={k} src={src} alt="" />)}</span>
                  )}
                  <span className="tl-cl">{c.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {plan.split > 0 && <div className="tl-split" style={{ left: `calc(150px + (100% - 150px) * ${plan.split / (plan.duration || 1)})` }}><span>дальше — ваш рассказ</span></div>}
        <div className={`tl-head ${plan.finished ? 'done' : ''}`} style={{ left: `calc(150px + (100% - 150px) * ${head / 100})` }} aria-hidden="true" />
      </div>
      {plan.warnings.length > 0 && <div className="banner banner-demo">{plan.warnings.join(' ')}</div>}
      {plan.error && <div className="banner banner-err">Не получилось: {plan.error}</div>}
    </div>
  );
}

/** YouTube: вход владельца канала (один раз) и загрузка готовых роликов. */
function YoutubeCard({ target, onTarget }: { target: string | null; onTarget: (n: string | null) => void }) {
  const [st, setSt] = useState<YtUploadStatusDto | null>(null);
  const [cid, setCid] = useState('');
  const [sec, setSec] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
  const [prog, setProg] = useState<{ pct: number; stage: string } | null>(null);
  const [res, setRes] = useState<YtUploadResultDto | null>(null);

  useEffect(() => {
    void window.jarvis.ytUpload.status().then((s) => { setSt(s); setCid(s.clientId); }, () => undefined);
    return window.jarvis.ytUpload.onProgress(setProg);
  }, []);
  useEffect(() => {
    if (target) {
      setTitle(target);
      setRes(null);
      setProg(null);
    }
  }, [target]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" id="yt-upload-card">
      <h2>YouTube: загрузка роликов</h2>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}
      {!st?.hasClient && (
        <>
          <p className="muted small">Один раз настройте доступ к своему каналу (бесплатно, 5 минут):</p>
          <ol className="muted small">
            <li>Откройте <code>console.cloud.google.com</code> → тот же проект, где включён «YouTube Data API v3» (или создайте новый и включите его).</li>
            <li>«API и сервисы» → «Экран согласия OAuth»: тип «Внешний», название «Системно», ваша почта. В «Тестовых пользователях» добавьте свой Gmail, затем нажмите <strong>«Опубликовать приложение»</strong> (иначе доступ будет слетать через 7 дней).</li>
            <li>«Учётные данные» → «Создать учётные данные» → «Идентификатор клиента OAuth» → тип <strong>«Приложение для ПК»</strong>. Скопируйте Client ID и Client secret сюда.</li>
          </ol>
          <div className="row">
            <input style={{ flex: 2 }} placeholder="Client ID (…apps.googleusercontent.com)" value={cid} onChange={(e) => setCid(e.target.value)} spellCheck={false} />
            <input style={{ flex: 1 }} type="password" placeholder="Client secret" value={sec} onChange={(e) => setSec(e.target.value)} autoComplete="off" />
            <button className="btn btn-primary" disabled={busy || !cid.trim() || !sec.trim()} onClick={() => void run(async () => { setSt(await window.jarvis.ytUpload.saveClient(cid, sec)); setSec(''); setMsg({ ok: true, text: 'Сохранено. Теперь нажмите «Подключить YouTube».' }); })}>Сохранить</button>
          </div>
        </>
      )}
      {st?.hasClient && !st.connected && (
        <div className="row">
          <button className="btn btn-primary" id="yt-connect" disabled={busy} onClick={() => void run(async () => { setMsg({ ok: true, text: 'Открыл окно входа Google в браузере — войдите тем аккаунтом, где ваш канал. Если Google пишет «Приложение не проверено», нажмите «Дополнительно» → «Перейти на Системно» (это ваше собственное приложение).' }); setSt(await window.jarvis.ytUpload.connect()); setMsg({ ok: true, text: 'YouTube подключён.' }); })}>Подключить YouTube</button>
          <button className="btn" onClick={() => void run(async () => setSt(await window.jarvis.ytUpload.disconnect()))}>Сбросить настройки</button>
        </div>
      )}
      {st?.connected && (
        <div className="row">
          <span>✓ Подключён{st.channel ? `: ${st.channel}` : ''}</span>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => { if (window.confirm('Отключить YouTube? Системно больше не сможет загружать ролики.')) setSt(await window.jarvis.ytUpload.disconnect()); })}>Отключить</button>
        </div>
      )}
      <p className="muted small">Ролики загружаются <strong>закрытыми</strong> — вы проверяете их в YouTube Studio и сами открываете. Google может не позволить проектам без проверки (аудита YouTube API) публиковать ролики открыто — тогда они останутся закрытыми.</p>

      {target && st?.connected && (
        <div className="studio-upload" data-testid="yt-form">
          <h3>На YouTube: {target}</h3>
          <label className="field"><span>Название (до 100 знаков)</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} /></label>
          <label className="field"><span>Описание</span><textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={4900} /></label>
          <div className="row">
            <label className="field grow"><span>Теги через запятую</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="септик, автоматизация, бизнес" /></label>
            <label className="field"><span>Доступ</span>
              <select value={privacy} onChange={(e) => setPrivacy(e.target.value as 'private')}>
                <option value="private">Закрытый (рекомендуется)</option>
                <option value="unlisted">По ссылке</option>
                <option value="public">Открытый</option>
              </select>
            </label>
          </div>
          <div className="row">
            <button className="btn btn-primary" id="yt-go" disabled={busy || !title.trim()} onClick={() => void run(async () => {
              if (!window.confirm(`Загрузить на ваш YouTube-канал?\n\n«${title.trim()}»\nДоступ: ${privacy === 'public' ? 'ОТКРЫТЫЙ (увидят все)' : privacy === 'unlisted' ? 'по ссылке' : 'закрытый'}`)) return;
              setProg({ pct: 0, stage: 'Начинаю' });
              const r = await window.jarvis.ytUpload.upload({ video: target, title: title.trim(), description: desc, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), privacy });
              setRes(r);
            })}>⬆ Загрузить</button>
            <button className="btn" onClick={() => onTarget(null)}>Закрыть</button>
          </div>
          {prog && !res && <div className="yt-prog"><div style={{ width: `${prog.pct}%` }} /><span>{prog.stage} · {prog.pct}%</span></div>}
          {res && (
            <div className="banner banner-ok" data-testid="yt-done">
              Загружено: <code>{res.url}</code> (доступ: {res.privacy === 'private' ? 'закрытый — откройте в YouTube Studio' : res.privacy}). {res.warnings.join(' ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StudioView(props: { onAsk: (text: string) => void }) {
  const [ytTarget, setYtTarget] = useState<string | null>(null);
  const [st, setSt] = useState<VideoStatusDto | null>(null);
  const [files, setFiles] = useState<VideoFileDto[]>([]);
  const [results, setResults] = useState<VideoResultDto[]>([]);
  const [plan, setPlan] = useState<VideoPlanDto | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [face, setFace] = useState('');
  const [ref, setRef] = useState('');
  const [layout, setLayout] = useState<VideoLayout>('reaction-split');
  const [title, setTitle] = useState('');
  const [subs, setSubs] = useState(true);
  const [cover, setCover] = useState(true);
  const [style, setStyle] = useState<'bold' | 'neon' | 'clean'>('bold');

  const reload = useCallback(async () => {
    try {
      const s = await window.jarvis.video.status();
      setSt(s);
      if (s.folder) {
        setFiles(await window.jarvis.video.list());
        setResults(await window.jarvis.video.results());
      }
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => window.jarvis.video.onPlan((p) => {
    setPlan(p);
    if (p.finished) void reload();
  }), [reload]);

  const names = useMemo(() => files.map((f) => f.name), [files]);
  const needRef = layout !== 'talk';
  const ready = !!face && (!needRef || !!ref) && (!needRef || face !== ref) && !busy;

  const go = async (): Promise<void> => {
    setMsg(null);
    setBusy(true);
    const spec: VideoSpecDto = { face, reference: needRef ? ref : undefined, layout, title: title.trim() || undefined, subtitles: subs, subStyle: style, cover };
    try {
      await window.jarvis.video.montage(spec);
      setMsg({ ok: true, text: 'Готово! Ролик лежит в папке «Готово» рядом с исходниками.' });
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    } finally {
      setBusy(false);
    }
  };
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: clean(e) });
    }
  };

  return (
    <div className="studio" data-testid="studio">
      <header className="studio-head">
        <h1>СТУДИЯ</h1>
        <p className="muted">Кладёте ролики в папку — ассистент монтирует: накладывает, делает субтитры и обложку.</p>
      </header>
      {msg && <div className={`banner ${msg.ok ? 'banner-ok' : 'banner-err'}`}>{msg.text}</div>}

      {st && !st.ffmpeg && <div className="banner banner-err">Не найден видеопроцессор ffmpeg. Он ставится вместе с программой (команда «npm install» в папке программы) — обновите программу или установите ffmpeg и перезапустите.</div>}

      <div className="card studio-folder">
        {st?.folder ? (
          <div className="row">
            <span>📁 <strong>{st.folder}</strong></span>
            <button className="btn" onClick={() => void run(async () => { const s = await window.jarvis.video.pickFolder(); if (s) { setSt(s); await reload(); } })}>Сменить папку</button>
            <button className="btn" onClick={() => void run(() => window.jarvis.video.open(st.folder!))}>Открыть в проводнике</button>
            <button className="btn" onClick={() => void reload()}>Обновить список</button>
          </div>
        ) : (
          <div>
            <p>Выберите папку, откуда брать исходники. Результат появится внутри неё, в папке «Готово». Исходные файлы не меняются.</p>
            <div className="row">
              {st?.suggested && (
                <button className="btn btn-primary" id="studio-suggested" onClick={() => void run(async () => { setSt(await window.jarvis.video.useSuggested()); await reload(); })}>
                  Использовать «{st.suggested.split(/[\\/]/).pop()}» на рабочем столе
                </button>
              )}
              <button className="btn" id="studio-pick" onClick={() => void run(async () => { const s = await window.jarvis.video.pickFolder(); if (s) { setSt(s); await reload(); } })}>Выбрать другую папку…</button>
            </div>
          </div>
        )}
      </div>

      {st?.folder && (
        <>
          <div className="card">
            <h2>Исходники</h2>
            {files.length === 0 && <p className="muted">В папке пока нет видео. Скиньте ролики (mp4, mov, mkv…) и нажмите «Обновить список».</p>}
            <div className="studio-files">
              {files.map((f) => (
                <div key={f.name} className={`sf ${face === f.name ? 'is-face' : ''} ${ref === f.name ? 'is-ref' : ''}`} data-testid="studio-file">
                  {f.thumb ? <img src={f.thumb} alt="" /> : <div className="sf-ph">▶</div>}
                  <div className="sf-n" title={f.name}>{f.name}</div>
                  <div className="sf-m">{f.durationSec ? mmss(f.durationSec) : '—'} · {f.sizeMb} МБ</div>
                  <div className="sf-b">
                    <button className={face === f.name ? 'on' : ''} onClick={() => setFace(face === f.name ? '' : f.name)}>Это я</button>
                    {needRef && <button className={ref === f.name ? 'on' : ''} onClick={() => setRef(ref === f.name ? '' : f.name)}>Показываю</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Что сделать</h2>
            <div className="studio-layouts">
              {LAYOUTS.map((l) => (
                <button key={l.id} className={`lay ${layout === l.id ? 'on' : ''}`} onClick={() => setLayout(l.id)} data-layout={l.id} aria-pressed={layout === l.id}>
                  <LayoutIcon id={l.id} />
                  <strong>{l.title}</strong>
                  <small>{l.text}</small>
                </button>
              ))}
            </div>
            <div className="row">
              <label className="field grow">
                <span>Заголовок в начале ролика (необязательно)</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Например: Как мы автоматизировали производство" />
              </label>
              <label className="field">
                <span>Стиль субтитров</span>
                <select value={style} onChange={(e) => setStyle(e.target.value as 'bold')}>
                  <option value="bold">Жёлтая подсветка слов</option>
                  <option value="neon">Неон</option>
                  <option value="clean">Чистый белый</option>
                </select>
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={subs} onChange={(e) => setSubs(e.target.checked)} /><span>Субтитры — звук вашего видео отправляется в OpenAI для расшифровки {st && !st.hasVoiceKey && <strong>(нужен ключ OpenAI: Настройки → Голос)</strong>}</span></label>
            <label className="check"><input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)} /><span>Сделать обложку (кадр из видео + крупный заголовок)</span></label>
            <div className="row">
              <button className="btn btn-primary rt-big" id="studio-go" disabled={!ready} onClick={() => void go()}>
                {busy ? 'Монтирую…' : '▶ Смонтировать'}
              </button>
              {busy && <button className="btn btn-danger" onClick={() => void window.jarvis.video.stop()}>Остановить</button>}
              {!ready && !busy && <span className="muted small">{!face ? 'Отметьте «Это я» на своём видео' : needRef && !ref ? 'Отметьте «Показываю» на видео, которое хотите показать' : ''}</span>}
            </div>
            <p className="muted small">Можно и голосом или текстом: «Смонтируй: на экране видео про септики, а я смотрю и комментирую, субтитры, обложка».</p>
          </div>
        </>
      )}

      {st?.folder && <YoutubeCard target={ytTarget} onTarget={setYtTarget} />}

      {plan && (
        <div className="card studio-table">
          <h2>Монтажный стол · {plan.name}</h2>
          <Timeline plan={plan} />
          {plan.output && (
            <div className="row studio-done">
              <button className="btn btn-primary" onClick={() => void run(() => window.jarvis.video.open(plan.output!.video))}>▶ Открыть ролик</button>
              {plan.output.cover && <button className="btn" onClick={() => void run(() => window.jarvis.video.open(plan.output!.cover!))}>Обложка</button>}
              <button className="btn" onClick={() => void run(() => window.jarvis.video.open(plan.output!.dir))}>Папка с результатом</button>
              <button className="btn btn-primary" onClick={() => setYtTarget(plan.name)}>⬆ На YouTube</button>
              <button className="btn" onClick={() => props.onAsk(`Подготовь тексты для публикации ролика «${plan.name}» в YouTube Shorts и Instagram Reels (заголовок, описание, хэштеги) и сохрани их через video_publish_pack.`)}>Тексты для Shorts и Reels</button>
            </div>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="card">
          <h2>Готовое</h2>
          <ul className="studio-results">
            {results.map((r) => (
              <li key={r.dir}>
                <span>🎬 {r.name}</span>
                {r.video && <button className="btn" onClick={() => void run(() => window.jarvis.video.open(r.video!))}>Открыть</button>}
                {r.video && <button className="btn" onClick={() => setYtTarget(r.name)}>⬆ На YouTube</button>}
                <button className="btn" onClick={() => void run(() => window.jarvis.video.open(r.dir))}>Папка</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
