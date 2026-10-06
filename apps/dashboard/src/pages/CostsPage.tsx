import { ErrorNote, SimulatedNote } from '../components.js';
import { api } from '../api.js';
import { ms, usd } from '../format.js';
import { useLive } from '../useLive.js';

export function CostsPage() {
  const { data, error } = useLive(() => api.costs(), { fallbackMs: 5000 });
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  const { totals, byModel, pricing } = data;
  const maxCost = Math.max(...byModel.map((m) => m.costUsd), 0);
  const hitRate = totals.calls === 0 ? 0 : totals.cacheHits / totals.calls;

  return (
    <>
      <h1>Costs &amp; latency by model</h1>
      <SimulatedNote show={data.simulated} />
      <div className="stats">
        <div className="card stat">
          <span className="muted">Model calls</span>
          <strong>{totals.calls}</strong>
        </div>
        <div className="card stat">
          <span className="muted">Cost</span>
          <strong>{usd(totals.costUsd)}</strong>
        </div>
        <div className="card stat">
          <span className="muted">Cache hit rate</span>
          <strong>{(hitRate * 100).toFixed(0)}%</strong>
          <span className="muted">saved {usd(totals.savedUsd)}</span>
        </div>
        <div className="card stat">
          <span className="muted">Tokens in / out</span>
          <strong>
            {totals.inputTokens} / {totals.outputTokens}
          </strong>
        </div>
      </div>

      <section className="card">
        <h2>Per model</h2>
        {byModel.length === 0 ? (
          <p className="muted">No model call recorded yet. Run a task from the Tasks page.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Errors</th>
                <th className="num">Cache hits</th>
                <th className="num">Tokens in / out</th>
                <th>Cost</th>
                <th className="num">Avg latency</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={m.model}>
                  <td>
                    <code>{m.model}</code>
                    {m.simulated && <span className="badge sim">simulated</span>}
                  </td>
                  <td className="num">{m.calls}</td>
                  <td className="num">{m.errors}</td>
                  <td className="num">{m.cacheHits}</td>
                  <td className="num">
                    {m.inputTokens} / {m.outputTokens}
                  </td>
                  <td>
                    <div className="bar" aria-hidden>
                      <span style={{ width: `${maxCost ? (m.costUsd / maxCost) * 100 : 0}%` }} />
                    </div>
                    {usd(m.costUsd)}
                    {m.unpricedCalls > 0 && (
                      <span className="muted"> + {m.unpricedCalls} unpriced</span>
                    )}
                  </td>
                  <td className="num">{ms(m.avgLatencyMs)}</td>
                  <td className="num">{ms(m.p50LatencyMs)}</td>
                  <td className="num">{ms(m.p95LatencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Prices used</h2>
        <p className="muted">
          {pricing.currency} per {pricing.perTokens.toLocaleString('en-US')} tokens, from{' '}
          <code>config/pricing.yaml</code> (updated {pricing.updated}).
        </p>
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th>Source</th>
              <th>Read on</th>
            </tr>
          </thead>
          <tbody>
            {pricing.models.map((p) => (
              <tr key={p.model}>
                <td>
                  <code>{p.model}</code>
                  {p.simulated && <span className="badge sim">illustrative</span>}
                </td>
                <td className="num">{p.input}</td>
                <td className="num">{p.output}</td>
                <td className="source">{p.source}</td>
                <td>{p.retrieved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
