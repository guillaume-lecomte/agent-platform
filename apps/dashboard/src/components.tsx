import { STATE_LABEL } from './format.js';
import type { Approval, TaskState } from './types.js';

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge state-${state}`}>{STATE_LABEL[state]}</span>;
}

export function RiskBadge({ risk }: { risk: Approval['risk'] }) {
  return <span className={`badge risk-${risk}`}>{risk}</span>;
}

export function ErrorNote({ error }: { error: string | undefined }) {
  return error ? (
    <p role="alert" className="error">
      {error}
    </p>
  ) : null;
}

export function SimulatedNote({ show }: { show: boolean }) {
  return show ? (
    <p className="note">
      <strong>Simulated data.</strong> The mock LLM provider is active: token counts and latencies
      are estimates, prices are illustrative and answers come from a scripted model. Set{' '}
      <code>LLM_PROVIDER</code> and an API key to measure a real model.
    </p>
  ) : null;
}
