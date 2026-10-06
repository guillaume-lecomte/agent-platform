import { createHash } from 'node:crypto';
import type { LLMRequest } from './types.js';

/** JSON with recursively sorted object keys, so equal values always serialize equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Stable hash of the parts of a request that determine the model output.
 * Hints, abort signals and other transport details are deliberately excluded.
 */
export function hashRequest(request: LLMRequest, model: string): string {
  return sha256(
    canonicalJson({
      model,
      messages: request.messages,
      tools: request.tools ?? [],
      temperature: request.temperature ?? null,
      maxOutputTokens: request.maxOutputTokens ?? null,
    }),
  );
}
