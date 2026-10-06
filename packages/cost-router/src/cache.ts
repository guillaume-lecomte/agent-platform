import { Redis } from 'ioredis';
import type { LLMResponse } from '@agent-platform/core';

export interface CacheEntry {
  response: LLMResponse;
  /** What the original call cost, so a hit can report what it saved. */
  costUsd: number | null;
}

export interface ResponseCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<string, { entry: CacheEntry; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): Promise<CacheEntry | undefined> {
    const hit = this.entries.get(key);
    if (!hit) return Promise.resolve(undefined);
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(structuredClone(hit.entry));
  }

  set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    this.entries.set(key, {
      entry: structuredClone(entry),
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }

  close(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}

/** Redis-backed exact-match cache. Keys are request hashes; entries expire with the TTL. */
export class RedisResponseCache implements ResponseCache {
  private readonly redis: Redis;

  constructor(
    redisUrl: string,
    private readonly prefix = 'agent-platform:llm-cache:',
  ) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(entry), 'EX', ttlSeconds);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
