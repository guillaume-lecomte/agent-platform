import type { AgentTask, Approval, CostSummary, TaskStep } from './types.js';

const BASE = '/api';

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (body as { message?: string } | undefined)?.message ?? res.statusText;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export const api = {
  tasks: () => request<AgentTask[]>('/tasks?limit=100'),
  steps: (id: string) => request<TaskStep[]>(`/tasks/${id}/steps`),
  createTask: (input: { title: string; body: string }) =>
    request<AgentTask>('/tasks', { method: 'POST', body: JSON.stringify({ input }) }),
  cancel: (id: string) => request<AgentTask>(`/tasks/${id}/cancel`, { method: 'POST' }),
  approvals: (status?: Approval['status']) =>
    request<Approval[]>(`/approvals${status ? `?status=${status}` : ''}`),
  approve: (id: string, reason?: string) =>
    request<Approval>(`/approvals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  deny: (id: string, reason: string) =>
    request<Approval>(`/approvals/${id}/deny`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  costs: () => request<CostSummary>('/costs'),
};
