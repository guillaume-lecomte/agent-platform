/**
 * Runs the issue-triage suite under three strategies (always the large model, always the small one,
 * the routing policy) and compares cost, latency and eval score. A fourth row repeats the routing
 * run with a warm response cache.
 *
 *   pnpm benchmark                                 mock provider: deterministic, free
 *   pnpm benchmark --out docs/benchmark-routing.md
 *   LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... ROUTER_POLICY=routing.anthropic.yaml \
 *     pnpm benchmark --large claude-sonnet-5-5 --small claude-haiku-4-5-20251001
 *
 * With the mock provider, costs use illustrative prices, latencies are simulated and the score
 * comes from a scripted model; the output says so.
 */
import { MockProvider, createProvider, loadConfig, readActiveFile } from '@agent-platform/core';
import {
  CostRouter,
  InMemoryCallTracker,
  InMemoryResponseCache,
  loadPolicy,
  loadPricing,
  mockLatencyFromPricing,
  pricingAgeDays,
  type RoutingPolicy,
} from '@agent-platform/cost-router';
import {
  createInProcessExecutor,
  findRepoRoot,
  getAgent,
  loadSuite,
  runSuite,
  type EvalReport,
} from '@agent-platform/evals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  // pnpm forwards a literal `--` when the user types one; ignore it.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    out: { type: 'string' },
    large: { type: 'string', default: 'mock-large' },
    small: { type: 'string', default: 'mock-small' },
    agent: { type: 'string', default: 'issue-triage' },
  },
});

const root = findRepoRoot();
const config = loadConfig(process.env);
const mode = config.LLM_PROVIDER === 'mock' ? 'mock' : 'real';
const pricing = await loadPricing(join(root, config.CONFIG_DIR, 'pricing.yaml'));
const routingPolicy = await loadPolicy(join(root, config.CONFIG_DIR, config.ROUTER_POLICY));
const agent = getAgent(values.agent);
const version = (await readActiveFile(agent.dir)).active;
const suite = await loadSuite(join(root, 'evals', agent.id, 'suite.yaml'));

const fixed = (model: string): RoutingPolicy => ({
  version: 1,
  default: { model },
  timeout_ms: routingPolicy.timeout_ms,
  cache: { enabled: false, ttl_seconds: 1 },
  complexity: {},
  rules: [],
});

interface Row {
  name: string;
  report: EvalReport;
  calls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  savedUsd: number;
  avgTaskLatencyMs: number;
  mix: string;
  simulated: boolean;
}

function makeRouter(policy: RoutingPolicy, cache?: InMemoryResponseCache) {
  const tracker = new InMemoryCallTracker();
  const base =
    mode === 'mock'
      ? new MockProvider({
          responder: agent.mockResponder,
          simulatedLatencyMs: mockLatencyFromPricing(pricing),
        })
      : createProvider(config);
  const router = new CostRouter({
    providers: { [config.LLM_PROVIDER]: base },
    pricing,
    policy,
    ...(cache ? { cache } : {}),
    tracker,
  });
  return { router, tracker };
}

async function measure(
  name: string,
  router: CostRouter,
  tracker: InMemoryCallTracker,
): Promise<Row> {
  const before = tracker.records.length;
  const report = await runSuite({
    suite,
    version,
    executor: createInProcessExecutor({ agent, version, provider: router }),
    mode,
    provider: router.name,
    concurrency: 1, // sequential, so every strategy sees the cache in the same state
  });
  const records = tracker.records.slice(before);
  const byModel = new Map<string, number>();
  for (const r of records) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
  return {
    name,
    report,
    calls: records.length,
    cacheHits: records.filter((r) => r.cacheHit).length,
    inputTokens: records.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: records.reduce((n, r) => n + r.outputTokens, 0),
    costUsd: records.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    savedUsd: records.reduce((n, r) => n + r.savedUsd, 0),
    avgTaskLatencyMs: report.usage.latencyMs / report.suite.cases,
    mix: [...byModel].map(([m, n]) => `${m} ×${n}`).join(', '),
    simulated: records.some((r) => r.simulated),
  };
}

const rows: Row[] = [];
for (const [name, policy] of [
  [`always large (${values.large})`, fixed(values.large)],
  [`always small (${values.small})`, fixed(values.small)],
] as const) {
  const { router, tracker } = makeRouter(policy);
  rows.push(await measure(name, router, tracker));
}
{
  const cache = new InMemoryResponseCache();
  const { router, tracker } = makeRouter(routingPolicy, cache);
  rows.push(await measure('routing (policy file)', router, tracker));
  rows.push(await measure('routing, 2nd run (warm response cache)', router, tracker));
}

const simulated = rows.some((r) => r.simulated);
const usd = (n: number): string => `$${n.toFixed(n < 0.1 ? 4 : 3)}`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;
const large = rows[0]!;
const rel = (a: number, b: number): string =>
  b === 0 ? '' : ` (${a <= b ? '' : '+'}${(((a - b) / b) * 100).toFixed(0)}%)`;

const lines: string[] = [];
lines.push('# Routing benchmark', '');
lines.push(
  `- Date: ${new Date().toISOString().slice(0, 10)}`,
  `- Command: \`${mode === 'mock' ? 'pnpm benchmark' : 'LLM_PROVIDER=' + config.LLM_PROVIDER + ' pnpm benchmark'}\``,
  `- Mode: **${mode}**${simulated ? ' (costs, latencies and scores are SIMULATED, see below)' : ' (measured)'}`,
  `- Agent: \`${agent.id}@${version}\`; suite \`${suite.name}\` v${suite.suite_version}, ${suite.cases.length} cases, run sequentially`,
  `- Prices: \`${config.CONFIG_DIR}/pricing.yaml\` (updated ${pricing.updated}, oldest entry read ${pricingAgeDays(pricing)} days ago)`,
  `- Routing policy: \`${config.CONFIG_DIR}/${config.ROUTER_POLICY}\``,
  '',
);
if (simulated) {
  lines.push(
    '> **Simulated.** The mock provider reports estimated token counts and latencies computed from a',
    '> formula in `config/pricing.yaml`; prices are illustrative; scores come from a scripted model',
    '> ([ADR 0007](decisions/0007-mock-model-is-a-test-double.md)). This shows how the router behaves,',
    '> not what it would save with real models.',
    '',
  );
}
lines.push(
  '| Strategy | Eval score | Model calls | Input tokens | Output tokens | Cost | Avg latency / task | Cache hits | Calls per model |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
);
for (const r of rows) {
  lines.push(
    `| ${r.name} | ${pct(r.report.scores.overall)} | ${r.calls} | ${r.inputTokens} | ${r.outputTokens} | ` +
      `${usd(r.costUsd)}${r === large ? '' : rel(r.costUsd, large.costUsd)} | ${secs(r.avgTaskLatencyMs)}${r === large ? '' : rel(r.avgTaskLatencyMs, large.avgTaskLatencyMs)} | ` +
      `${r.cacheHits} | ${r.mix} |`,
  );
}
lines.push(
  '',
  'Percentages in parentheses compare with "always large". Cost = tokens × price per million tokens from the pricing file; the warm-cache row shows only what exact-match caching does on a repeated run (hits cost nothing).',
  '',
);
const text = lines.join('\n') + '\n';
console.log(text);
if (values.out) {
  await writeFile(join(root, values.out), text);
  console.log(`Written to ${values.out}`);
}
