import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().default('postgres://agent:agent@localhost:5432/agent_platform'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    LLM_PROVIDER: z.enum(['mock', 'anthropic', 'openai']).default('mock'),
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
    OPENAI_API_KEY: optionalString,
    OPENAI_MODEL: z.string().default('gpt-5.5'),
    /** Real delay added to every mock LLM call, to make long tasks observable in demos. */
    MOCK_DELAY_MS: z.coerce.number().int().min(0).default(0),
    /** Folder with pricing.yaml and the routing policy. */
    CONFIG_DIR: z.string().default('./config'),
    /** Routing policy file, relative to CONFIG_DIR. */
    ROUTER_POLICY: z.string().default('routing.yaml'),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.LLM_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
      });
    }
    if (cfg.LLM_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when LLM_PROVIDER=openai',
      });
    }
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parses and validates configuration from environment variables. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  return parsed.data;
}
