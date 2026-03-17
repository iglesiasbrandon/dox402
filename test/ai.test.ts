import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers (imported transitively)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import { runInference } from '../src/ai';
import { AI_MODEL, ALLOWED_MODELS, MAX_TOKENS_LIMIT } from '../src/constants';
import type { ConversationMessage, Env } from '../src/types';

function makeMockEnv(aiRunImpl?: (...args: unknown[]) => unknown): Env {
  return {
    AI: {
      run: aiRunImpl
        ? vi.fn(aiRunImpl)
        : vi.fn(async () => new ReadableStream()),
    },
    DOX402: {} as unknown as DurableObjectNamespace,
    VECTORIZE: {} as unknown as VectorizeIndex,
    PAYMENT_ADDRESS: '0x0000000000000000000000000000000000000000',
    BASE_RPC_URL: 'https://rpc.example.com',
    NETWORK: 'base-mainnet',
    SESSION_SECRET: 'test-secret',
    WALLET_REGISTRY: {} as unknown as KVNamespace,
  } as unknown as Env;
}

const sampleMessages: ConversationMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello' },
];

// ── Model selection ──────────────────────────────────────────────────────────

describe('runInference — model selection', () => {
  it('uses default AI_MODEL when no model specified', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({}),
    );
  });

  it('uses default AI_MODEL when an invalid model is specified', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages, 512, 'not-a-real-model');
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({}),
    );
  });

  it.each(Object.keys(ALLOWED_MODELS))('passes through valid model: %s', async (modelId) => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages, 512, modelId);
    expect(env.AI.run).toHaveBeenCalledWith(
      modelId,
      expect.objectContaining({}),
    );
  });
});

// ── Max tokens clamping ──────────────────────────────────────────────────────

describe('runInference — max tokens clamping', () => {
  it('clamps maxTokens to MAX_TOKENS_LIMIT when exceeding', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages, MAX_TOKENS_LIMIT + 1000);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ max_tokens: MAX_TOKENS_LIMIT }),
    );
  });

  it('clamps maxTokens of 0 to 1', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages, 0);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ max_tokens: 1 }),
    );
  });

  it('clamps negative maxTokens to 1', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages, -100);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ max_tokens: 1 }),
    );
  });

  it('defaults maxTokens to 512 when not specified', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ max_tokens: 512 }),
    );
  });

  it('passes valid maxTokens through unchanged', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages, 256);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ max_tokens: 256 }),
    );
  });
});

// ── Payload and return value ─────────────────────────────────────────────────

describe('runInference — payload and return', () => {
  it('passes messages through correctly to AI.run', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ messages: sampleMessages }),
    );
  });

  it('always sets stream: true', async () => {
    const env = makeMockEnv();
    await runInference(env, sampleMessages);
    expect(env.AI.run).toHaveBeenCalledWith(
      AI_MODEL,
      expect.objectContaining({ stream: true }),
    );
  });

  it('returns the ReadableStream from AI.run', async () => {
    const fakeStream = new ReadableStream();
    const env = makeMockEnv(async () => fakeStream);
    const result = await runInference(env, sampleMessages);
    expect(result).toBe(fakeStream);
  });
});

// ── Error propagation ────────────────────────────────────────────────────────

describe('runInference — error propagation', () => {
  it('propagates AI.run errors without swallowing', async () => {
    const env = makeMockEnv(async () => {
      throw new Error('AI backend unavailable');
    });
    await expect(runInference(env, sampleMessages)).rejects.toThrow(
      'AI backend unavailable',
    );
  });
});
