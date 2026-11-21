import type { Lesson } from '../mentor/courses';
import type { Line } from './provider';

const w = (words: string): RegExp => new RegExp(`(?<![а-яё])(?:${words})(?![а-яё])`, 'i');
const STOP = w('стоп|хватит|прекрати\\w*|отстань|заканчива\\w+|не надо');
const NO_MORE = /не\s+звони|больше\s+не\s+звон|отпиши|удали\w*\s+мо[йи]\s+номер/i;
const NO = w('нет|неудобно|занят\\w*|позже|не могу|не сейчас');
const YES = w('да|удобно|давайте|давай|ага|угу|конечно|можно|говорите|продолжайте|продолжай|слушаю|окей|ок');
const ORD: [RegExp, number][] = [
  [w('1|один|первый|первое|первая'), 0],
  [w('2|два|второй|второе|вторая'), 1],
  [w('3|три|третий|третье|третья'), 2],
  [w('4|четыре|четвёртый|четвертый|четвёртое|четвертое|четвёртая|четвертая'), 3],
];

export const isStop = (t: string): boolean => STOP.test(t) && !YES.test(t);
export const isOptOut = (t: string): boolean => NO_MORE.test(t);

/** Номер варианта (0-based) из реплики: «второй», «2», «вариант три». null — не понял. */
export function parseChoice(t: string, optionCount: number): number | null {
  const hits = ORD.filter(([re]) => re.test(t)).map(([, i]) => i).filter((i) => i < optionCount);
  return hits.length === 1 ? hits[0]! : null;
}

export type CallOutcome = 'completed' | 'declined' | 'opted_out' | 'no_answer' | 'stopped' | 'hung_up';

export interface ScriptResult {
  outcome: CallOutcome;
  correct: number;
  total: number;
  /** Ответы на тесты: индексы шага и выбранный вариант (для записи в журнал обучения). */
  answers: { stepIdx: number; choice: number }[];
}

export interface ScriptDeps {
  line: Line;
  signal: AbortSignal;
  lesson: Lesson;
  name: string;
  recording: boolean;
  hearTimeoutMs: number;
  log: (who: 'jarvis' | 'employee' | 'system', text: string) => void;
}

const short = (t: string, n = 420): string => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t);

/**
 * Сценарий учебного звонка. Это детерминированный сценарий, а не свободный диалог с моделью:
 * представление ИИ, спрос согласия и выход по «стоп» нельзя «заболтать».
 */
export async function runScript(d: ScriptDeps): Promise<ScriptResult> {
  const res: ScriptResult = { outcome: 'completed', correct: 0, total: 0, answers: [] };
  const say = async (t: string): Promise<void> => {
    d.log('jarvis', t);
    await d.line.say(t);
  };
  const hear = async (): Promise<string | null> => {
    const r = await d.line.hear(d.hearTimeoutMs, d.signal);
    if (r !== null) d.log('employee', r);
    return r;
  };
  const end = async (outcome: CallOutcome, farewell?: string): Promise<ScriptResult> => {
    if (farewell && !d.signal.aborted) await say(farewell);
    res.outcome = d.signal.aborted && outcome !== 'opted_out' ? 'hung_up' : outcome;
    return res;
  };
  /** Слушать с одним повтором при тишине. */
  const listen = async (reprompt: string): Promise<string | null> => {
    let r = await hear();
    if (r === null && !d.signal.aborted) {
      await say(reprompt);
      r = await hear();
    }
    return r;
  };

  // 1. Представление: это ИИ, цель, запись, право отказаться.
  const who = d.name ? `, ${d.name}` : '';
  await say(
    `Здравствуйте${who}! Это ИИ-наставник вашей компании — я программа, а не человек. Звоню с учебной целью: коротко разобрать урок «${d.lesson.title}». ` +
      (d.recording ? 'Разговор записывается — вы дали на это отдельное согласие. ' : 'Разговор не записывается. ') +
      'Вы можете сказать «стоп» в любой момент. Вам сейчас удобно говорить?',
  );
  let ans = await listen('Алло? Вы меня слышите? Вам удобно говорить?');
  if (ans === null) return end(d.signal.aborted ? 'hung_up' : 'no_answer');
  if (isOptOut(ans)) return end('opted_out', 'Поняла вас. Больше звонить не буду. Всего доброго.');
  if (isStop(ans) || (NO.test(ans) && !YES.test(ans))) return end('declined', 'Хорошо, не буду отвлекать. Всего доброго!');
  if (!YES.test(ans)) {
    await say('Простите, не поняла. Вам удобно говорить сейчас? Ответьте «да» или «нет».');
    ans = await hear();
    if (ans === null || !YES.test(ans) || NO.test(ans)) return end(ans === null && d.signal.aborted ? 'hung_up' : 'declined', 'Хорошо, не буду отвлекать. Всего доброго!');
  }

  // 2. Урок.
  const steps = d.lesson.steps;
  for (let i = 0; i < steps.length; i++) {
    if (d.signal.aborted) return end('hung_up');
    const s = steps[i]!;
    if (s.kind === 'explain') {
      await say(short(s.text));
    } else if (s.kind === 'quiz') {
      res.total += 1;
      const opts = s.options.map((o, k) => `${k + 1}. ${o}`).join('. ');
      await say(`Вопрос. ${s.question} Варианты: ${opts}. Назовите номер ответа.`);
      let a = await listen('Вы на связи? Назовите номер ответа.');
      if (a === null) return end(d.signal.aborted ? 'hung_up' : 'no_answer');
      if (isOptOut(a)) return end('opted_out', 'Поняла вас. Больше звонить не буду. Всего доброго.');
      if (isStop(a)) return end('stopped', 'Хорошо, остановимся. Продолжим в другой раз. Спасибо!');
      let choice = parseChoice(a, s.options.length);
      if (choice === null) {
        await say('Не расслышала номер. Повторите, пожалуйста, одним числом.');
        a = await hear();
        if (a === null) return end(d.signal.aborted ? 'hung_up' : 'no_answer');
        if (isStop(a)) return end('stopped', 'Хорошо, остановимся. Продолжим в другой раз. Спасибо!');
        choice = parseChoice(a, s.options.length);
      }
      if (choice === null) {
        await say(`Пропустим вопрос. Правильный ответ — номер ${s.correct + 1}. ${s.explain}`);
        continue;
      }
      res.answers.push({ stepIdx: i, choice });
      if (choice === s.correct) {
        res.correct += 1;
        await say(`Верно. ${s.explain}`);
      } else {
        await say(`Не совсем. Правильный ответ — номер ${s.correct + 1}. ${s.explain}`);
      }
    }
    // Практические задания (task) по телефону не проверяются — это делается в CRM.
  }

  const score = res.total ? ` Правильных ответов: ${res.correct} из ${res.total}.` : '';
  return end('completed', `Урок разобрали.${score} Практическую часть выполните в CRM, я проверю её в приложении. Спасибо за время, до свидания!`);
}
