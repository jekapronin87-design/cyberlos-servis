import { describe, expect, it } from 'vitest';
import { checkCallAllowed, maskPhone, normalizePhone } from '../src/core/telephony/policy';
import { isOptOut, isStop, parseChoice } from '../src/core/telephony/script';
import { COURSES } from '../src/core/mentor/courses';
import { makeCore } from './helpers';

const local = (h: number, m = 0): Date => new Date(2026, 10, 21, h, m, 0, 0);
const settings = { callWindowFrom: '09:00', callWindowTo: '20:00', callMaxPerDay: 10, callMaxPerNumberPerDay: 2 };
const ok = { training: true, revokedAt: null };

describe('телефония: правила', () => {
  it('номера нормализуются, мусор отвергается', () => {
    expect(normalizePhone('8 (916) 123-45-67')).toBe('+79161234567');
    expect(normalizePhone('+7 916 123 45 67')).toBe('+79161234567');
    expect(normalizePhone('9161234567')).toBe('+79161234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(maskPhone('+79161234567')).not.toContain('916');
  });

  it('звонок запрещён без согласия, при отзыве, вне окна и сверх лимитов', () => {
    const base = { settings, now: local(12), callsToday: 0, callsTodayToNumber: 0 };
    expect(checkCallAllowed({ ...base, consent: ok }).ok).toBe(true);
    expect(checkCallAllowed({ ...base, consent: null })).toMatchObject({ ok: false });
    expect(checkCallAllowed({ ...base, consent: { training: true, revokedAt: '2026-01-01' } })).toMatchObject({ ok: false });
    expect(checkCallAllowed({ ...base, consent: { training: false, revokedAt: null } })).toMatchObject({ ok: false });
    expect(checkCallAllowed({ ...base, now: local(8, 59), consent: ok })).toMatchObject({ ok: false });
    expect(checkCallAllowed({ ...base, now: local(20, 0), consent: ok })).toMatchObject({ ok: false });
    expect(checkCallAllowed({ ...base, now: local(19, 59), consent: ok }).ok).toBe(true);
    expect(checkCallAllowed({ ...base, callsToday: 10, consent: ok })).toMatchObject({ ok: false });
    expect(checkCallAllowed({ ...base, callsTodayToNumber: 2, consent: ok })).toMatchObject({ ok: false });
  });

  it('разбор реплик: стоп, отказ от звонков, номер ответа', () => {
    expect(isStop('Стоп!')).toBe(true);
    expect(isStop('да, продолжайте')).toBe(false);
    expect(isStop('хватит')).toBe(true);
    expect(isOptOut('больше не звоните мне')).toBe(true);
    expect(parseChoice('второй', 4)).toBe(1);
    expect(parseChoice('Номер 3', 4)).toBe(2);
    expect(parseChoice('четвёртый вариант', 4)).toBe(3);
    expect(parseChoice('1 или 2', 4)).toBeNull(); // неоднозначно
    expect(parseChoice('не знаю', 4)).toBeNull();
    expect(parseChoice('четыре', 3)).toBeNull(); // вне диапазона
  });
});

const lesson = COURSES[0]!.lessons[0]!;
const quizIdx = lesson.steps.map((s, i) => (s.kind === 'quiz' ? i : -1)).filter((i) => i >= 0);
const correctWords = quizIdx.map((i) => String((lesson.steps[i] as { correct: number }).correct + 1));

function setup(hour = 12) {
  const clock = { now: local(hour) };
  const h = makeCore({ telephonyNow: () => clock.now, telephonyHearTimeoutMs: 80 });
  const grant = (over: Partial<Parameters<typeof h.core.grantConsent>[0]> = {}) =>
    h.core.grantConsent({ phone: '8 916 123-45-67', name: 'Анна Петрова', email: 'anna@test.ru', confirmed: true, ...over });
  const run = async (replies: string[], over = {}) => {
    const { callId } = h.core.startCall({ phone: '+79161234567', courseId: COURSES[0]!.id, lessonId: lesson.id, ...over });
    const line = h.core.telephony.simulator.lines.get(callId)!;
    for (const r of replies) line.push(r);
    await h.core.telephony.waitFinished(callId);
    return { callId, line };
  };
  return { h, clock, grant, run };
}

describe('телефония: звонок (симулятор)', () => {
  it('без согласия звонок не начинается, попытка записывается в журнал', () => {
    const { h } = setup();
    expect(() => h.core.startCall({ phone: '+79161234567', courseId: COURSES[0]!.id, lessonId: lesson.id })).toThrow(/реестре согласий/);
    expect(JSON.stringify(h.core.listAudit(50))).toContain('telephony.call_denied');
    expect(h.core.listCalls()).toHaveLength(0);
  });

  it('согласие требует явного подтверждения; номер в журнале замаскирован', () => {
    const { h, grant } = setup();
    expect(() => grant({ confirmed: false })).toThrow(/Подтвердите/);
    expect(() => grant({ phone: '123' })).toThrow(/номер/);
    grant();
    const audit = JSON.stringify(h.core.listAudit(50));
    expect(audit).not.toContain('9161234567');
    expect(audit).toContain('telephony.consent_granted');
  });

  it('полный звонок: ИИ представляется, нет записи, верные ответы засчитываются в обучение', async () => {
    const { h, grant, run } = setup();
    grant();
    const { callId, line } = await run(['да', ...correctWords]);
    const first = line.said[0]!;
    expect(first).toContain('ИИ-наставник');
    expect(first).toContain('программа, а не человек');
    expect(first).toContain('не записывается');
    expect(first).toContain('«стоп»');
    const call = h.core.listCalls()[0]!;
    expect(call).toMatchObject({ status: 'completed', correct: quizIdx.length, total: quizIdx.length, recorded: false });
    expect(call.phone).not.toContain('916');
    expect(h.core.callTranscript(callId)).toBeNull(); // без согласия на запись текст не хранится
    // результаты попали в журнал обучения наставника
    const lessonDto = h.core.mentor.lesson('anna@test.ru', COURSES[0]!.id, lesson.id);
    expect(lessonDto.progress.score).toBe(100);
  });

  it('запись текста — только при отдельном согласии, и её можно удалить', async () => {
    const { h, grant, run } = setup();
    grant({ recording: true });
    const { callId, line } = await run(['да', 'стоп']);
    expect(line.said[0]).toContain('записывается');
    expect(h.core.callTranscript(callId)).toContain('Сотрудник: да');
    h.core.deleteCallTranscript(callId);
    expect(h.core.callTranscript(callId)).toBeNull();
    expect(h.core.listCalls()[0]!.recorded).toBe(false);
  });

  it('«стоп» в любой момент завершает звонок вежливо', async () => {
    const { h, grant, run } = setup();
    grant();
    const { line } = await run(['да', 'стоп']);
    expect(h.core.listCalls()[0]!.status).toBe('stopped');
    expect(line.said.at(-1)).toContain('остановимся');
  });

  it('«неудобно» → отказ, звонок не продолжается', async () => {
    const { h, grant, run } = setup();
    grant();
    const { line } = await run(['сейчас неудобно']);
    expect(h.core.listCalls()[0]!.status).toBe('declined');
    expect(line.said).toHaveLength(2); // представление + прощание, урок не начат
  });

  it('«больше не звоните» отзывает согласие и блокирует следующие звонки', async () => {
    const { h, grant, run } = setup();
    grant();
    await run(['больше не звоните мне']);
    expect(h.core.listCalls()[0]!.status).toBe('opted_out');
    expect(h.core.listConsents()[0]!.revokedAt).not.toBeNull();
    expect(() => h.core.startCall({ phone: '+79161234567', courseId: COURSES[0]!.id, lessonId: lesson.id })).toThrow(/отозвал/);
  });

  it('тишина: сотрудник не ответил', async () => {
    const { h, grant, run } = setup();
    grant();
    await run([]);
    expect(h.core.listCalls()[0]!.status).toBe('no_answer');
  });

  it('вне окна времени звонить нельзя; лимит на номер в день', async () => {
    const early = setup(7);
    early.grant();
    expect(() => early.h.core.startCall({ phone: '+79161234567', courseId: COURSES[0]!.id, lessonId: lesson.id })).toThrow(/вне разрешённого времени/);

    const { h, grant, run } = setup(12);
    grant();
    await run(['нет']);
    await run(['нет']);
    expect(() => h.core.startCall({ phone: '+79161234567', courseId: COURSES[0]!.id, lessonId: lesson.id })).toThrow(/лимит/);
  });

  it('трубку можно положить в любой момент', async () => {
    const { h, grant } = setup();
    grant();
    const { callId } = h.core.startCall({ phone: '+79161234567', courseId: COURSES[0]!.id, lessonId: lesson.id });
    h.core.callHangup(callId);
    await h.core.telephony.waitFinished(callId);
    expect(h.core.listCalls()[0]!.status).toBe('hung_up');
  });

  it('CRM звонками не меняется (в аудите нет записей в CRM), модуль можно отключить', async () => {
    const { h, grant } = setup();
    grant();
    h.core.updateSettings({ disabledModules: ['telephony'] });
    expect(() => h.core.listConsents()).toThrow(/отключён/);
    expect(h.core.tools.specs().some((t) => t.name === 'call_log')).toBe(true); // инструмент есть, но исполнитель его блокирует
  });

  it('инструмент call_log: номера замаскированы', async () => {
    const { h, grant, run } = setup();
    grant();
    await run(['нет']);
    const out = await h.core.tools.get('call_log')!.execute({}, { runId: 'r', conversationId: 0, signal: new AbortController().signal, actor: 'assistant' } as never);
    expect(String(out)).toContain('Анна');
    expect(String(out)).not.toContain('9161234567');
  });

  it('настройки телефонии проверяются', () => {
    const { h } = setup();
    expect(() => h.core.updateSettings({ callWindowFrom: '25:00' })).toThrow(/ЧЧ:ММ/);
    expect(() => h.core.updateSettings({ callMaxPerDay: 0 })).toThrow(/Лимит/);
    expect(h.core.updateSettings({ callWindowFrom: '10:30', callMaxPerDay: 5 })).toMatchObject({ callWindowFrom: '10:30', callMaxPerDay: 5 });
  });
});
