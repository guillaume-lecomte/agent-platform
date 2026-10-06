import type { AgentTask, RunnerHooks, TaskStore } from '@agent-platform/durable-runner';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics for the runner. Scraped from GET /metrics. */
export class MetricsService {
  readonly registry = new Registry();
  private readonly tasksFinished: Counter<'agent' | 'state'>;
  private readonly llmRetries: Counter<'kind'>;
  private readonly toolCalls: Counter<'tool' | 'outcome'>;

  constructor(store: TaskStore) {
    collectDefaultMetrics({ register: this.registry });
    this.tasksFinished = new Counter({
      name: 'agent_tasks_finished_total',
      help: 'Agent tasks that reached a terminal state, by final state.',
      labelNames: ['agent', 'state'],
      registers: [this.registry],
    });
    this.llmRetries = new Counter({
      name: 'agent_llm_retries_total',
      help: 'Retries of transient LLM errors, by error kind.',
      labelNames: ['kind'],
      registers: [this.registry],
    });
    this.toolCalls = new Counter({
      name: 'agent_tool_calls_total',
      help: 'Tool calls recorded, by tool and outcome (executed, replayed, denied, unknown, rejected).',
      labelNames: ['tool', 'outcome'],
      registers: [this.registry],
    });
    new Gauge({
      name: 'agent_tasks',
      help: 'Agent tasks currently stored, by state.',
      labelNames: ['state'],
      registers: [this.registry],
      async collect() {
        this.reset();
        for (const [state, n] of Object.entries(await store.countTasksByState())) {
          this.set({ state }, n);
        }
      },
    });
  }

  /** Hooks to plug into the AgentRunner. */
  get hooks(): RunnerHooks {
    return {
      onTaskFinished: (task: AgentTask, state) => {
        this.tasksFinished.inc({ agent: task.agentId, state });
      },
      onLlmRetry: ({ kind }) => {
        this.llmRetries.inc({ kind });
      },
      onToolCall: ({ tool, outcome }) => {
        this.toolCalls.inc({ tool, outcome });
      },
    };
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
