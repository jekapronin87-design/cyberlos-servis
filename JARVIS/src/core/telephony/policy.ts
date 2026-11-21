import type { Settings } from '../../shared/types';

/** +7XXXXXXXXXX. Допускаются форматы 8…, +7…, с пробелами и скобками; иначе null. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  const only = digits.replace(/\D/g, '');
  if (only.length === 11 && (only.startsWith('7') || only.startsWith('8'))) return '+7' + only.slice(1);
  if (only.length === 10 && !digits.startsWith('+')) return '+7' + only;
  if (digits.startsWith('+') && only.length >= 10 && only.length <= 15) return '+' + only;
  return null;
}

/** Для журналов и подсказок: +7 *** ***-12-34. */
export const maskPhone = (p: string): string => (p.length > 6 ? `${p.slice(0, 2)} *** ***-${p.slice(-4, -2)}-${p.slice(-2)}` : '***');

const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface CallCheckInput {
  consent: { training: boolean; revokedAt: string | null } | null;
  settings: Pick<Settings, 'callWindowFrom' | 'callWindowTo' | 'callMaxPerDay' | 'callMaxPerNumberPerDay'>;
  now: Date;
  callsToday: number;
  callsTodayToNumber: number;
}

/** Все условия, без которых звонить нельзя. ok=false → reason объясняет человеку, что не так. */
export function checkCallAllowed(i: CallCheckInput): { ok: true } | { ok: false; reason: string } {
  if (!i.consent) return { ok: false, reason: 'Этого номера нет в реестре согласий. Сначала внесите согласие сотрудника на учебные звонки.' };
  if (i.consent.revokedAt) return { ok: false, reason: 'Сотрудник отозвал согласие. Звонки невозможны.' };
  if (!i.consent.training) return { ok: false, reason: 'Нет согласия именно на учебные звонки.' };
  const mins = i.now.getHours() * 60 + i.now.getMinutes();
  const from = toMin(i.settings.callWindowFrom);
  const to = toMin(i.settings.callWindowTo);
  if (mins < from || mins >= to) return { ok: false, reason: `Сейчас вне разрешённого времени звонков (${i.settings.callWindowFrom}–${i.settings.callWindowTo}).` };
  if (i.callsToday >= i.settings.callMaxPerDay) return { ok: false, reason: `Достигнут дневной лимит звонков (${i.settings.callMaxPerDay}).` };
  if (i.callsTodayToNumber >= i.settings.callMaxPerNumberPerDay) return { ok: false, reason: `На этот номер сегодня уже звонили ${i.callsTodayToNumber} раз — лимит ${i.settings.callMaxPerNumberPerDay}.` };
  return { ok: true };
}
