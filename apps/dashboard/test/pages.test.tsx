import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalsPage } from '../src/pages/ApprovalsPage.js';
import { CostsPage } from '../src/pages/CostsPage.js';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  close() {}
}

const approval = {
  id: 'a1',
  taskId: 't1',
  toolName: 'post_comment',
  arguments: { issue_number: 7, body: 'Thanks!' },
  risk: 'destructive',
  status: 'pending',
  reason: null,
  requestedAt: new Date().toISOString(),
  decidedAt: null,
};

function mockApi(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200 });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ApprovalsPage', () => {
  it('shows a pending approval and requires a reason to deny', async () => {
    const calls = mockApi({
      '/approvals?status=pending': [approval],
      '/approvals': [approval],
      '/tasks?limit=100': [{ id: 't1', input: { title: 'Login 500' } }],
      '/approvals/a1/deny': { ...approval, status: 'denied' },
    });
    render(<ApprovalsPage />);
    await screen.findByText('post_comment');
    expect(document.querySelector('.risk-destructive')).toBeTruthy();
    expect(screen.getByText(/Login 500/)).toBeTruthy();

    const deny = screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' });
    expect(deny.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/tone/), { target: { value: 'too formal' } });
    expect(deny.disabled).toBe(false);
    fireEvent.click(deny);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/approvals/a1/deny'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/approvals/a1/deny'))?.body).toBe(
      '{"reason":"too formal"}',
    );
  });

  it('approves without a reason', async () => {
    const calls = mockApi({
      '/approvals?status=pending': [approval],
      '/approvals': [approval],
      '/tasks?limit=100': [],
    });
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/approvals/a1/approve'))).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/approvals/a1/approve'))?.body).toBe('{}');
  });
});

describe('CostsPage', () => {
  it('labels simulated data and shows price sources', async () => {
    mockApi({
      '/costs': {
        simulated: true,
        totals: {
          calls: 8,
          cacheHits: 2,
          costUsd: 0.0133,
          savedUsd: 0.001,
          inputTokens: 6000,
          outputTokens: 300,
        },
        byModel: [
          {
            model: 'mock-large',
            calls: 4,
            errors: 0,
            cacheHits: 0,
            inputTokens: 3000,
            outputTokens: 150,
            costUsd: 0.0123,
            unpricedCalls: 0,
            savedUsd: 0,
            avgLatencyMs: 1500,
            p50LatencyMs: 1390,
            p95LatencyMs: 2100,
            simulated: true,
          },
        ],
        pricing: {
          updated: '2026-10-06',
          currency: 'USD',
          perTokens: 1000000,
          models: [
            {
              model: 'mock-large',
              provider: 'mock',
              input: 3,
              output: 15,
              simulated: true,
              source: 'illustrative',
              retrieved: '2026-10-06',
            },
          ],
        },
      },
    });
    render(<CostsPage />);
    await screen.findByText(/Simulated data/);
    expect(screen.getAllByText('mock-large').length).toBeGreaterThan(0);
    expect(screen.getByText('25%')).toBeTruthy(); // 2 hits / 8 calls
    expect(screen.getByText('1.50 s')).toBeTruthy();
    expect(screen.getByText('illustrative', { selector: '.source' })).toBeTruthy();
  });
});
