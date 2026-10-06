import type { Config } from './config.js';
import { AnthropicProvider } from './llm/anthropic.js';
import { MockProvider, type MockProviderOptions, type MockResponder } from './llm/mock.js';
import { OpenAIProvider } from './llm/openai.js';
import type { LLMProvider } from './llm/types.js';

export interface CreateProviderOptions {
  /** Scripted behaviour for the mock provider (agents supply their own). */
  mockResponder?: MockResponder;
  mockRecordingsDir?: string;
  /** Simulated latency model for the mock provider (see MockProviderOptions). */
  mockSimulatedLatency?: MockProviderOptions['simulatedLatencyMs'];
}

/**
 * Builds the provider selected by configuration. The mock provider is the default;
 * real providers are only created when selected AND their API key is present
 * (enforced by `loadConfig`).
 */
export function createProvider(config: Config, options: CreateProviderOptions = {}): LLMProvider {
  switch (config.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        defaultModel: config.ANTHROPIC_MODEL,
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY,
        defaultModel: config.OPENAI_MODEL,
      });
    case 'mock':
      return new MockProvider({
        responder: options.mockResponder,
        recordingsDir: options.mockRecordingsDir,
        ...(options.mockSimulatedLatency
          ? { simulatedLatencyMs: options.mockSimulatedLatency }
          : {}),
        realDelayMs: config.MOCK_DELAY_MS,
      });
  }
}
