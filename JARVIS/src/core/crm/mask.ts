/** Маскирование персональных данных клиентов и сотрудников в том, что уходит ИИ. */

export function maskPhone(p: string | null | undefined): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (d.length < 7) return '***';
  return `+${d.slice(0, d.length - 10 > 0 ? d.length - 10 : 1)} *** *** ${d.slice(-4, -2)}-${d.slice(-2)}`.replace('+ ', '+');
}

export function maskEmail(e: string | null | undefined): string {
  if (!e) return '';
  const [name, domain] = e.split('@');
  if (!domain) return '***';
  return `${(name ?? '').slice(0, 1)}***@${domain}`;
}

/** «Иван Петров» → «Иван П.»; одно слово → первая буква и точки. */
export function maskName(n: string | null | undefined): string {
  if (!n) return '';
  const parts = n.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.length > 1 ? `${parts[0]![0]}***` : parts[0]!;
  return `${parts[0]} ${parts.slice(1).map((p) => p[0] + '.').join('')}`;
}

/** Любые телефоны и адреса почты внутри свободного текста. */
export function maskFreeText(t: string): string {
  return t
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => maskEmail(m))
    .replace(/(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g, (m) => maskPhone(m));
}

/**
 * Вырезает из текста имя клиента, известное из карточки (leadName): полное имя → «Иван П.», отдельная фамилия/отчество → «П.».
 * Названия сделок и комментарии часто содержат фамилию клиента, а карточка называет её — этим пользуемся.
 */
export function maskKnownNames(text: string, leadName: string | null | undefined): string {
  if (!text || !leadName) return text;
  const parts = leadName.trim().split(/\s+/).filter((p) => p.length >= 2);
  if (parts.length === 0) return text;
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text.replace(new RegExp(esc(leadName.trim()), 'giu'), maskName(leadName));
  // Первое слово (имя) оставляем, как в maskName; остальные (фамилия, отчество) заменяем инициалами
  for (const p of parts.slice(1)) out = out.replace(new RegExp(`(?<![\\p{L}])${esc(p)}(?![\\p{L}])`, 'giu'), `${p[0]!.toUpperCase()}.`);
  if (parts.length === 1) out = out.replace(new RegExp(`(?<![\\p{L}])${esc(parts[0]!)}(?![\\p{L}])`, 'giu'), maskName(parts[0]));
  return out;
}
