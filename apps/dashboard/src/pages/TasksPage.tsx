import { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, StateBadge } from '../components.js';
import { ago, isTerminal, issueTitle, ms, shortId } from '../format.js';
import type { AgentTask, TaskStep } from '../types.js';
import { useLive } from '../useLive.js';

const SAMPLES = [
  {
    label: 'Bug: server crashes on startup',
    title: 'Server crashes on startup after upgrading to 2.4.0',
    body: 'After the upgrade the process exits immediately and all users are locked out. Steps to reproduce: start the 2.4.0 image. Version 2.4.0.',
  },
  {
    label: 'Duplicate: login 500 after reset',
    title: 'HTTP 500 on the login page right after I reset my password',
    body: 'I used the reset link from the email, set a new password and now the login form answers with an HTTP 500 error.',
  },
  {
    label: 'Feature: Helm chart',
    title: 'Provide an official Helm chart',
    body: 'We deploy on Kubernetes and maintain our own chart. An official Helm chart would make upgrades easier for everyone.',
  },
  {
    label: 'Question: reverse proxy',
    title: 'Is it possible to run Tasklane behind a reverse proxy under a sub-path?',
    body: 'I would like to serve it at https://example.org/tasks/ using nginx. Is there a base path setting?',
  },
];

function NewTask({ onCreated }: { onCreated: (t: AgentTask) => void }) {
  const [title, setTitle] = useState(SAMPLES[0]!.title);
  const [body, setBody] = useState(SAMPLES[0]!.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onCreated(await api.createTask({ title, body }));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card new-task" onSubmit={(e) => void submit(e)}>
      <h2>Triage an issue</h2>
      <label>
        Sample
        <select
          onChange={(e) => {
            const s = SAMPLES[Number(e.target.value)]!;
            setTitle(s.title);
            setBody(s.body);
          }}
        >
          {SAMPLES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Body
        <textarea value={body} rows={3} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" disabled={busy || title.trim() === ''}>
          Run the agent
        </button>
        <span className="muted">
          The agent will ask for approval before adding labels and before commenting.
        </span>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}

function StepList({ taskId }: { taskId: string }) {
  const { data, error } = useLive(() => api.steps(taskId));
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading steps…</p>;
  return (
    <ol className="steps">
      {data.map((s: TaskStep) => (
        <li key={s.seq} className={`step ${s.kind}`}>
          <span className="seq">{s.seq}</span>
          {s.kind === 'llm' ? (
            <span>
              <strong>model</strong> <code>{s.payload.model}</code>
              {s.payload.cached ? ' (cached)' : ''} →{' '}
              {s.payload.toolCalls?.length
                ? `calls ${s.payload.toolCalls.map((c) => c.name).join(', ')}`
                : 'final answer'}{' '}
              <span className="muted">
                {s.inputTokens + s.outputTokens} tokens · {ms(s.payload.latencyMs ?? 0)}
                {s.payload.simulated ? ' (simulated)' : ''}
              </span>
            </span>
          ) : (
            <span>
              <strong>tool</strong> <code>{s.payload.name}</code> →{' '}
              <span className={`outcome ${s.payload.outcome}`}>{s.payload.outcome}</span>
              {s.payload.isError ? ' (error result sent to the agent)' : ''}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function TaskDetail({ task, onChanged }: { task: AgentTask; onChanged: () => void }) {
  const cancel = async () => {
    await api.cancel(task.id).catch(() => undefined);
    onChanged();
  };
  const answer = task.result?.json;
  return (
    <section className="card detail" aria-label="Task detail">
      <div className="row between">
        <h2>
          {issueTitle(task.input)} <StateBadge state={task.state} />
        </h2>
        {!isTerminal(task.state) && (
          <button className="secondary" onClick={() => void cancel()}>
            Cancel task
          </button>
        )}
      </div>
      <p className="muted">
        {task.id} · {task.agentId}@{task.agentVersion} · {task.tokensUsed}/{task.tokenBudget} tokens
      </p>
      {task.state === 'awaiting_approval' && (
        <p className="note">
          Waiting for a human: open <a href="#/approvals">Approvals</a>.
        </p>
      )}
      {task.error && <p className="error">{task.error}</p>}
      <StepList taskId={task.id} />
      {answer && (
        <>
          <h3>Agent answer</h3>
          <pre>{JSON.stringify(answer, null, 2)}</pre>
        </>
      )}
    </section>
  );
}

export function TasksPage() {
  const { data: tasks, error, reload } = useLive(() => api.tasks());
  const [selected, setSelected] = useState<string>();
  const current = tasks?.find((t) => t.id === selected);

  return (
    <>
      <NewTask
        onCreated={(t) => {
          setSelected(t.id);
          reload();
        }}
      />
      <ErrorNote error={error} />
      <section className="card">
        <h2>Tasks</h2>
        {!tasks ? (
          <p className="muted">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="muted">No task yet. Run the agent on a sample issue above.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Issue</th>
                <th>State</th>
                <th>Agent</th>
                <th className="num">Tokens</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr
                  key={t.id}
                  className={t.id === selected ? 'selected' : undefined}
                  onClick={() => setSelected(t.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(t.id)}
                >
                  <td>
                    {issueTitle(t.input)} <span className="muted">{shortId(t.id)}</span>
                  </td>
                  <td>
                    <StateBadge state={t.state} />
                  </td>
                  <td>
                    {t.agentId}@{t.agentVersion}
                  </td>
                  <td className="num">
                    {t.tokensUsed}/{t.tokenBudget}
                  </td>
                  <td>{ago(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {current && <TaskDetail task={current} onChanged={reload} />}
    </>
  );
}
