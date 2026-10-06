# Routing benchmark

- Date: 2026-10-06
- Command: `pnpm benchmark`
- Mode: **mock** (costs, latencies and scores are SIMULATED, see below)
- Agent: `issue-triage@v1`; suite `issue-triage` v1, 40 cases, run sequentially
- Prices: `./config/pricing.yaml` (updated 2026-10-06, oldest entry read 0 days ago)
- Routing policy: `./config/routing.yaml`

> **Simulated.** The mock provider reports estimated token counts and latencies computed from a
> formula in `config/pricing.yaml`; prices are illustrative; scores come from a scripted model
> ([ADR 0007](decisions/0007-mock-model-is-a-test-double.md)). This shows how the router behaves,
> not what it would save with real models.

| Strategy | Eval score | Model calls | Input tokens | Output tokens | Cost | Avg latency / task | Cache hits | Calls per model |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| always large (mock-large) | 96.9% | 160 | 130785 | 6957 | $0.497 | 5.88 s | 0 | mock-large ×160 |
| always small (mock-small) | 95.3% | 160 | 130513 | 6833 | $0.0412 (-92%) | 1.45 s (-75%) | 0 | mock-small ×160 |
| routing (policy file) | 96.5% | 160 | 130616 | 6879 | $0.182 (-63%) | 2.79 s (-53%) | 0 | mock-large ×48, mock-small ×112 |
| routing, 2nd run (warm response cache) | 96.5% | 160 | 130616 | 6879 | $0.0000 (-100%) | 0.00 s (-100%) | 160 | mock-large ×48, mock-small ×112 |

Percentages in parentheses compare with "always large". Cost = tokens × price per million tokens from the pricing file; the warm-cache row shows only what exact-match caching does on a repeated run (hits cost nothing).

