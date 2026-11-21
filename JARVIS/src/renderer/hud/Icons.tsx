import type { ReactNode } from 'react';

const base = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const I = (children: ReactNode) => <svg {...base} aria-hidden="true">{children}</svg>;

export const IconHud = () => I(<><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" strokeDasharray="2 3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>);
export const IconChat = () => I(<path d="M4 5h16v11H9l-5 4z" />);
export const IconMemory = () => I(<><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /><rect x="9" y="9" width="6" height="6" /></>);
export const IconAudit = () => I(<><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h7M9 8h3" /></>);
export const IconSettings = () => I(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>);
export const IconMic = () => I(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const IconCam = () => I(<><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></>);
export const IconStop = () => I(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const IconSend = () => I(<path d="M4 12l16-8-6 16-3-7z" />);
export const IconProfile = () => I(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></>);
export const IconCrm = () => I(<><path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" /></>);
