import type { TaskState } from './types.js';

export const STATE_LABEL: Record<TaskState, string> = {
  pending: 'Pending',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  budget_exceeded: 'Budget exceeded',
  cancelled: 'Cancelled',
};

export const isTerminal = (s: TaskState): boolean =>
  s === 'completed' || s === 'failed' || s === 'budget_exceeded' || s === 'cancelled';

export function usd(n: number): string {
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`;
}

export function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const shortId = (id: string): string => id.slice(0, 8);

export const issueTitle = (input: { title?: string }): string => input.title ?? '(no title)';
