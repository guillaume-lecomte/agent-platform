import { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, RiskBadge } from '../components.js';
import { ago, issueTitle, shortId } from '../format.js';
import type { Approval } from '../types.js';
import { useLive } from '../useLive.js';

function ApprovalCard({
  approval,
  title,
  onDone,
}: {
  approval: Approval;
  title: string;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    try {
      if (decision === 'approve') await api.approve(approval.id, reason.trim() || undefined);
      else await api.deny(approval.id, reason.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <article className="card approval">
      <div className="row between">
        <h3>
          <code>{approval.toolName}</code> <RiskBadge risk={approval.risk} />
        </h3>
        <span className="muted">{ago(approval.requestedAt)}</span>
      </div>
      <p className="muted">
        Requested by the agent while triaging “{title}” ({shortId(approval.taskId)})
      </p>
      <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
      <label>
        Reason <span className="muted">(required to deny; the agent receives it)</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. tone is too formal"
        />
      </label>
      <div className="row">
        <button disabled={busy} onClick={() => void decide('approve')}>
          Approve
        </button>
        <button
          className="danger"
          disabled={busy || reason.trim() === ''}
          onClick={() => void decide('deny')}
        >
          Deny
        </button>
      </div>
      <ErrorNote error={error} />
    </article>
  );
}

export function ApprovalsPage() {
  const pending = useLive(() => api.approvals('pending'));
  const all = useLive(() => api.approvals());
  const tasks = useLive(() => api.tasks());
  const titleOf = (id: string): string => {
    const t = tasks.data?.find((x) => x.id === id);
    return t ? issueTitle(t.input) : shortId(id);
  };
  const decided = (all.data ?? [])
    .filter((a) => a.status !== 'pending')
    .slice(-8)
    .reverse();

  return (
    <>
      <h1>Approvals</h1>
      <p className="muted">
        Tools that change something (<code>reversible</code>, <code>destructive</code>) wait here
        until a human decides.
      </p>
      <ErrorNote error={pending.error} />
      {pending.data === undefined && !pending.error && <p className="muted">Loading…</p>}
      {pending.data?.length === 0 && (
        <p className="card muted">Nothing is waiting. Start a task from the Tasks page.</p>
      )}
      {pending.data?.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          title={titleOf(a.taskId)}
          onDone={() => {
            pending.reload();
            all.reload();
          }}
        />
      ))}
      {decided.length > 0 && (
        <section className="card">
          <h2>Recent decisions</h2>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((a) => (
                <tr key={a.id}>
                  <td>
                    <code>{a.toolName}</code> <span className="muted">{titleOf(a.taskId)}</span>
                  </td>
                  <td>
                    <span className={`badge decision-${a.status}`}>{a.status}</span>
                  </td>
                  <td>{a.reason ?? ''}</td>
                  <td>{a.decidedAt ? ago(a.decidedAt) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
