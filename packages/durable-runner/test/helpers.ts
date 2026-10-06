import {
  MockProvider,
  createLogger,
  type Logger,
  type AgentDefinition,
  type AnyTool,
  type MockReply,
} from '@agent-platform/core';
import {
  AgentRunner,
  InMemoryEventBus,
  InMemoryTaskStore,
  TaskService,
  type AgentResolver,
  type RunnerHooks,
  type TaskEvent,
  type TaskScheduler,
  type TaskStore,
} from '../src/index.js';

export const logger: Logger = createLogger({ name: 'test', level: 'silent' });

export const definition: AgentDefinition = {
  id: 't',
  version: 'v1',
  systemPrompt: 'You are a test agent.',
  tools: ['lookup', 'post'],
  tokenBudget: 1_000_000,
  maxSteps: 10,
};

export interface CountingTools {
  lookup: AnyTool;
  post: AnyTool;
  counts: { lookup: number; post: number };
  keys: string[];
}

export function countingTools(): CountingTools {
  const counts = { lookup: 0, post: 0 };
  const keys: string[] = [];
  return {
    counts,
    keys,
    lookup: {
      name: 'lookup',
      description: 'read-only lookup',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
      risk: 'read',
      async execute(input: { q: string }) {
        counts.lookup += 1;
        return { found: input.q };
      },
    },
    post: {
      name: 'post',
      description: 'effectful: posts a comment',
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string' } },
        required: ['body'],
      },
      risk: 'destructive',
      async execute(input: { body: string }, ctx) {
        counts.post += 1;
        keys.push(ctx.idempotencyKey);
        return { posted: input.body };
      },
    },
  };
}

/**
 * Scripted model: the reply is chosen by how many assistant turns the conversation
 * already contains, so a replayed request always gets the same answer.
 */
export function scripted(replies: MockReply[]): MockProvider {
  return new MockProvider({
    responder: ({ messages }) => {
      const turn = messages.filter((m) => m.role === 'assistant').length;
      return replies[Math.min(turn, replies.length - 1)];
    },
  });
}

export function setup(options: {
  store?: TaskStore;
  provider?: MockProvider;
  tools?: CountingTools;
  hooks?: RunnerHooks;
  def?: Partial<AgentDefinition>;
}) {
  const store = options.store ?? new InMemoryTaskStore();
  const provider = options.provider ?? scripted([{ content: 'done' }]);
  const tools = options.tools ?? countingTools();
  const bus = new InMemoryEventBus();
  const events: TaskEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const resolver: AgentResolver = async () => ({
    definition: { ...definition, ...options.def },
    tools: [tools.lookup, tools.post],
  });
  const runner = new AgentRunner({
    store,
    provider,
    resolver,
    bus,
    logger,
    retry: { baseDelayMs: 1, jitter: false, sleep: async () => {} },
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const queued: string[] = [];
  const scheduler: TaskScheduler = {
    async enqueue(id) {
      queued.push(id);
    },
  };
  const service = new TaskService({
    store,
    scheduler,
    bus,
    resolver,
    logger,
    activeVersion: async () => 'v1',
    runner,
  });
  return { store, provider, tools, bus, events, runner, service, queued };
}

let counter = 0;
export function newTaskInput(extra: { tokenBudget?: number } = {}) {
  counter += 1;
  return {
    idempotencyKey: `test-${Date.now()}-${counter}-${Math.random().toString(36).slice(2)}`,
    agentId: 't',
    agentVersion: 'v1',
    input: { title: 'hello' },
    tokenBudget: extra.tokenBudget ?? 1_000_000,
  };
}
