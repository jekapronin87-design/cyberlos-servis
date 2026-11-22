import { useEffect, useState } from 'react';
import type { CrmDashboardDto } from '../../shared/types';
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

/** Полноэкранное «цифровое пространство»: шар сворачивается в угол, вокруг раскрываются карточки или город бизнеса. */
export function SpaceView(props: { mode: SpaceMode; onMode: (m: SpaceMode) => void; onClose: () => void; onAsk: (text: string) => void; orbState: OrbState; getLevel: () => number }) {
  const [data, setData] = useState<CrmDashboardDto | null>(null);
  const [sample, setSample] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    window.jarvis.crm
      .dashboard()
      .then((d) => alive && (setData(d), setSample(false)))
      .catch((e: unknown) => {
        if (!alive) return;
        setData(SAMPLE_DASHBOARD);
        setSample(true);
        setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : '');
      });
    return () => {
      alive = false;
    };
  }, []);

  const o = data?.overview;
  const tile = (label: string, value: number, bad = false, i = 0) => (
    <div key={label} className={`sp-card sp-tile ${bad && value > 0 ? 'sp-bad' : ''}`} style={{ animationDelay: `${0.25 + i * 0.07}s` }}>
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
      {!data && <div className="space-loading">Загружаю данные…</div>}
      {data && o && props.mode === 'city' && (
        <>
          <CityCanvas data={data} />
          <div className="space-legend">Район — воронка · здание — стадия · высота — сделок в работе · <span className="hot">красный — нарушены сроки</span></div>
        </>
      )}
      {data && o && props.mode === 'analytics' && (
        <div className="space-grid">
          <div className="sp-row">
            {tile('Новых за сутки', o.newLast24h, false, 0)}
            {tile('Без ответственного', o.unassignedOpen, true, 1)}
            {tile('Простаивают', o.stuck, true, 2)}
            {tile('Задач просрочено', o.tasksOverdue, true, 3)}
            {tile('Производство: просрочено', o.productionOverdue, true, 4)}
            {tile('Ждут предоплату', o.awaitingPrepayment, true, 5)}
          </div>
          <div className="sp-card sp-wide" style={{ animationDelay: '0.45s' }}>
            <h3>Воронки</h3>
            {o.pipelines.map((p) => {
              const max = Math.max(1, ...p.byStage.map((s) => s.open));
              return (
                <div key={p.slug} className="sp-funnel">
                  <div className="sp-fn-title">{p.name} <span>{p.open} в работе · {p.won} выиграно · {p.lost} проиграно</span></div>
                  <div className="sp-bars">
                    {p.byStage.map((s) => (
                      <div key={s.name} className="sp-bar" title={`${s.name}: ${s.open}${s.breaches ? `, просрочено: ${s.breaches}` : ''}`}>
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
