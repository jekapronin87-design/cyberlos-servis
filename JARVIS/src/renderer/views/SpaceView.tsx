import { useEffect, useRef, useState } from 'react';
import type { AquaSectionDto, CrmDashboardDto } from '../../shared/types';
import { CityCanvas } from '../hud/CityCanvas';
import { Orb, type OrbState } from '../hud/Orb';
import { SAMPLE_DASHBOARD } from '../hud/sampleData';

const ISSUE: Record<string, string> = {
  missing_required_field: 'Не заполнены поля',
  no_next_action: 'Нет следующего действия',
  no_assignee: 'Нет ответственного',
  stuck: 'Простой дольше SLA',
  lost_without_reason: 'Отказ без причины',
  status_stage_mismatch: 'Статус ≠ стадии',
  lead_without_contact: 'Нет контактов',
  production_unpaid_in_work: 'Производство без предоплаты',
  production_overdue: 'Просрочено производство',
};

export type SpaceMode = 'analytics' | 'city';
export type SectionKind = 'production' | 'tasks' | 'stuck' | 'unassigned' | 'lowstock' | 'stage';
/** Запрос открыть раздел (голосом или из интерфейса). `nonce` меняется при каждом запросе, чтобы повторная команда тоже срабатывала. */
export interface SectionRequest {
  kind: SectionKind;
  /** Часть названия воронки («монтаж», «продаж») — для kind = stage, когда точное имя неизвестно. */
  pipelineLike?: string;
  nonce: number;
}

/** Полноэкранное «цифровое пространство»: шар сворачивается в угол, вокруг раскрываются карточки или город бизнеса. */
export function SpaceView(props: { mode: SpaceMode; onMode: (m: SpaceMode) => void; onClose: () => void; onAsk: (text: string) => void; orbState: OrbState; getLevel: () => number; request?: SectionRequest | null; onNarrate?: (text: string) => void }) {
  const [data, setData] = useState<CrmDashboardDto | null>(null);
  const [sample, setSample] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    const clean = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '');
    const load = async (): Promise<void> => {
      let liveError = '';
      // 1) живая CRM «Аквамастер» (по ключу), 2) CRM «Сайберлос», 3) пример
      const a = await window.jarvis.aqua.get().catch(() => null);
      if (a?.hasKey) {
        try {
          const d = await window.jarvis.aqua.dashboard();
          if (alive) (setData(d), setSample(false), setNote(''));
          return;
        } catch (e) {
          liveError = clean(e);
        }
      }
      try {
        const d = await window.jarvis.crm.dashboard();
        if (alive) (setData(d), setSample(false), setNote(liveError ? `Живая CRM «Аквамастер» не ответила: ${liveError}` : ''));
      } catch (e) {
        if (!alive) return;
        setData(SAMPLE_DASHBOARD);
        setSample(true);
        setNote(liveError ? `живая CRM «Аквамастер» не ответила: ${liveError}` : clean(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), 90_000); // живые данные обновляются сами
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const live = data?.source === 'aqua';

  // ---- раздел «по нажатию»: таблица за плиткой или зданием ----
  const [sec, setSec] = useState<{ title: string; state: 'loading' | 'ok' | 'error'; data?: AquaSectionDto; error?: string } | null>(null);
  const openSection = (kind: SectionKind, arg: { pipeline?: string; stage?: string } = {}, title = 'Загружаю…'): void => {
    setSec({ title, state: 'loading' });
    window.jarvis.aqua
      .section(kind, arg)
      .then((d) => setSec({ title: d.title, state: 'ok', data: d }))
      .catch((e: unknown) => setSec({ title, state: 'error', error: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Ошибка' }));
  };
  const lastReq = useRef(0);
  useEffect(() => {
    const r = props.request;
    if (!r || r.nonce === lastReq.current || !data) return;
    lastReq.current = r.nonce;
    if (!live) return;
    if (r.kind === 'stage') {
      const stem = (r.pipelineLike ?? '').toLowerCase();
      const p = data.overview.pipelines.find((x) => x.name.toLowerCase().includes(stem));
      if (!p) return setSec({ title: 'Не нашёл такую воронку', state: 'error', error: `Воронки «${r.pipelineLike}» нет. Есть: ${data.overview.pipelines.map((x) => x.name).join(', ')}.` });
      return openSection('stage', { pipeline: p.name }, p.name);
    }
    openSection(r.kind);
  }, [props.request, data, live]);
  useEffect(() => {
    if (!sec) return;
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSec(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [sec]);

  const o = data?.overview;
  const tile = (label: string, value: number, bad = false, i = 0, kind?: SectionKind) => (
    <div
      key={label}
      className={`sp-card sp-tile ${bad && value > 0 ? 'sp-bad' : ''} ${live && kind ? 'sp-click' : ''}`}
      style={{ animationDelay: `${0.25 + i * 0.07}s` }}
      role={live && kind ? 'button' : undefined}
      tabIndex={live && kind ? 0 : undefined}
      title={live && kind ? 'Нажмите, чтобы увидеть список' : undefined}
      onClick={live && kind ? () => openSection(kind, {}, label) : undefined}
      onKeyDown={live && kind ? (e) => e.key === 'Enter' && openSection(kind, {}, label) : undefined}
    >
      <div className="sp-v">{value}</div>
      <div className="sp-l">{label}</div>
    </div>
  );

  const issueGroups = (() => {
    const m = new Map<string, number>();
    for (const i of data?.issues ?? []) m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  })();

  return (
    <section className="space" data-testid="space">
      <div className="space-orb" aria-hidden="true">
        <Orb state={props.orbState} getLevel={props.getLevel} />
      </div>
      <header className="space-head">
        <h1>{props.mode === 'city' ? 'ГОРОД БИЗНЕСА' : 'АНАЛИТИКА'}</h1>
        <div className="space-tabs" role="tablist">
          <button role="tab" aria-selected={props.mode === 'analytics'} className={props.mode === 'analytics' ? 'on' : ''} onClick={() => props.onMode('analytics')}>Карточки</button>
          <button role="tab" aria-selected={props.mode === 'city'} className={props.mode === 'city' ? 'on' : ''} onClick={() => props.onMode('city')}>Город</button>
          <button className="space-close" onClick={props.onClose} title="Вернуться (или скажите «вернись»)">✕</button>
        </div>
      </header>
      {sample && (
        <div className="space-banner" role="status">
          ПРИМЕР ДАННЫХ — CRM не подключена{note ? ` (${note})` : ''}. Подключите её в «Настройки → CRM», и здесь появятся ваши цифры.
        </div>
      )}
      {live && data && (
        <div className="space-banner space-live" role="status" data-testid="space-live">
          ЖИВЫЕ ДАННЫЕ · CRM «Аквамастер» · обновлено {new Date(data.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
          {data.truncated ? ' · показаны не все сделки (лимит 1000)' : ''}
          {data.missing.length ? ` · ключу не открыто: ${data.missing.join('; ')}` : ''}
        </div>
      )}
      {!live && !sample && note && <div className="space-banner" role="status">{note}</div>}
      {!data && <div className="space-loading">Загружаю данные…</div>}
      {data && o && props.mode === 'city' && (
        <>
          <CityCanvas data={data} onPick={live ? (b) => openSection('stage', b, `${b.pipeline} · ${b.stage}`) : undefined} />
          <div className="space-legend">Район — воронка · здание — стадия · высота — сделок в работе · <span className="hot">красный — {live ? `не менялись дольше ${7} дней` : 'нарушены сроки'}</span></div>
        </>
      )}
      {sec && (
        <aside className="sp-drawer" data-testid="space-drawer" role="dialog" aria-label={sec.title}>
          <header>
            <h2>{sec.title}</h2>
            <button className="space-close" onClick={() => setSec(null)} title="Закрыть (Esc)">✕</button>
          </header>
          {sec.state === 'loading' && <p className="muted">Читаю из CRM…</p>}
          {sec.state === 'error' && <div className="banner banner-err">{sec.error}</div>}
          {sec.state === 'ok' && sec.data && (
            <>
              <p className="muted small">Всего: {sec.data.total}{sec.data.note ? ` · ${sec.data.note}` : ''} · только чтение</p>
              {sec.data.rows.length === 0 ? (
                <p>Пусто — здесь ничего нет.</p>
              ) : (
                <div className="sp-table-wrap">
                  <table className="sp-table">
                    <thead><tr>{sec.data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>{sec.data.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={/просрочен/.test(v) ? 'hot' : ''}>{v}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              )}
              <div className="row">
                <button className="btn" onClick={() => (props.onNarrate ?? props.onAsk)(`Проанализируй этот список CRM «${sec.title}»: что важно, где проблемы и что сделать в первую очередь. Прочитай данные через crm_live_get.`)}>Спросить ассистента про это</button>
              </div>
            </>
          )}
        </aside>
      )}
      {data && o && props.mode === 'analytics' && (
        <div className="space-grid">
          <div className="sp-row">
            {tile('Новых за сутки', o.newLast24h, false, 0)}
            {tile('Без ответственного', o.unassignedOpen, true, 1, 'unassigned')}
            {tile(live ? 'Без движения 7+ дней' : 'Простаивают', o.stuck, true, 2, 'stuck')}
            {tile('Задач просрочено', o.tasksOverdue, true, 3, 'tasks')}
            {tile('Производство: просрочено', o.productionOverdue, true, 4, 'production')}
            {!live && tile('Ждут предоплату', o.awaitingPrepayment, true, 5)}
            {live && tile('Низкий остаток материалов', o.lowStock, true, 5, 'lowstock')}
          </div>
          <div className="sp-card sp-wide" style={{ animationDelay: '0.45s' }}>
            <h3>Воронки</h3>
            {o.pipelines.map((p) => {
              const max = Math.max(1, ...p.byStage.map((s) => s.open));
              return (
                <div key={p.slug} className="sp-funnel">
                  <div className={`sp-fn-title ${live ? 'sp-click' : ''}`} onClick={live ? () => openSection('stage', { pipeline: p.name }, p.name) : undefined}>{p.name} <span>{p.open} в работе · {p.won} выиграно · {p.lost} проиграно</span></div>
                  <div className="sp-bars">
                    {p.byStage.map((s) => (
                      <div key={s.name} className={`sp-bar ${live ? 'sp-click' : ''}`} onClick={live ? () => openSection('stage', { pipeline: p.name, stage: s.name }, `${p.name} · ${s.name}`) : undefined} title={`${s.name}: ${s.open}${s.breaches ? `, просрочено: ${s.breaches}` : ''}`}>
                        <div className={`sp-bar-fill ${s.breaches ? 'hot' : ''}`} style={{ height: `${Math.max(6, (s.open / max) * 100)}%` }} />
                        <small>{s.name}</small>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="sp-card" style={{ animationDelay: '0.6s' }}>
            <h3>Менеджеры</h3>
            {data.managers.slice(0, 6).map((m) => (
              <div key={m.name} className="sp-mgr">
                <span>{m.name}</span>
                <div className="sp-track"><div style={{ width: `${Math.min(100, m.openDeals * 3)}%` }} /><i style={{ width: `${Math.min(100, m.tasksOverdue * 12)}%` }} /></div>
                <small>{m.openDeals} сделок · просрочено {m.tasksOverdue}</small>
              </div>
            ))}
          </div>
          <div className="sp-card" style={{ animationDelay: '0.75s' }}>
            <h3>Что не так</h3>
            {issueGroups.length === 0 && <p className="muted">Замечаний нет.</p>}
            {issueGroups.map(([k, n]) => (
              <div key={k} className="sp-issue"><b>{n}</b> {ISSUE[k] ?? k}</div>
            ))}
          </div>
          <div className="sp-card" style={{ animationDelay: '0.9s' }}>
            <h3>Спросить ассистента</h3>
            <div className="sp-actions">
              <button className="btn" onClick={() => props.onAsk('Сделай выводы по текущей аналитике CRM: узкие места, риски и 3 конкретных шага, что исправить в первую очередь.')}>Выводы и что исправить</button>
              <button className="btn" onClick={() => props.onAsk('Кому из сотрудников нужно обучение и по каким темам?')}>Кому нужно обучение</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
