# Architecture Decision Records

Short records of decisions that were not dictated by the brief. Each one states the
context, the choice and its consequences, so a reader can disagree with specifics.

| #                                             | Decision                                                     |
| --------------------------------------------- | ------------------------------------------------------------ |
| [0001](0001-typescript-6.md)                  | TypeScript 6.0 instead of 7.0                                |
| [0002](0002-drizzle-orm.md)                   | Drizzle instead of Prisma                                    |
| [0003](0003-explicit-llm-provider.md)         | The LLM provider is selected explicitly                      |
| [0004](0004-build-to-dist-and-explicit-di.md) | Packages build to `dist`; Nest uses explicit `@Inject`       |
| [0005](0005-durable-execution-semantics.md)   | Durable execution: guarantees and mechanisms                 |
| [0006](0006-static-agent-registry.md)         | Agents are registered statically                             |
| [0007](0007-mock-model-is-a-test-double.md)   | The mock model follows the prompt; not a quality measurement |
| [0008](0008-eval-gate-and-baseline.md)        | How the eval gate decides                                    |
