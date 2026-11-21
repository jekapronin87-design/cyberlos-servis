import type { ContentBlock, RiskLevel } from '../shared/types';

export const RISK_LABEL: Record<RiskLevel, string> = {
  safe: 'безопасно',
  low: 'низкий риск',
  medium: 'средний риск',
  high: 'высокий риск',
  critical: 'запрещено',
};

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
}

export function blocksText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

export function prettyInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s === '{}' ? '' : s;
}
