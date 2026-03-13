import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cloudflare:workers (imported transitively via dox402.ts)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { InferenceGate } from '../src/dox402';
import type { Env } from '../src/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockSSEStream(chunks: string[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function erroringSSEStream(initialChunks: string[], error: Error): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.error(error);
    },
  });
}

function makeMockStorage() {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => data.get(key) as T),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    transaction: vi.fn(async (cb: (txn: { get: typeof data.get; put: typeof data.set }) => Promise<void>) => {
      const txn = {
        get: async <T>(key: string): Promise<T | undefined> => data.get(key) as T,
        put: async (key: string, value: unknown) => { data.set(key, value); },
      };
      await cb(txn);
    }),
    _data: data,
  };
}

function makeTestDO(opts?: { aiStream?: ReadableStream }) {
  const storage = makeMockStorage();

  const mockAI = {
    run: vi.fn(async () => {
      if (opts?.aiStream) return opts.aiStream;
      return mockSSEStream([
        'data: {"response":"Hello "}\n\n',
        'data: {"response":"world"}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]);
    }),
  };

  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    storage,
    waitUntil: vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); }),
    id: { name: 'test-wallet' },
  };

  const env: Env = {
    DOX402: {} as any,
    AI: mockAI as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET: 'test-secret',
  };

  const gate = new InferenceGate(ctx as any, env as any);
  return { gate, storage, waitUntilPromises, mockAI };
}

async function drainStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  } catch { /* stream may error on purpose */ }
  return text;
}

function inferRequest(prompt = 'hello'): Request {
  return new Request('http://localhost/infer', {
    method: 'POST',
    headers: { 'X-DO-Wallet': '0xtest', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, walletAddress: '0xtest' }),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InferenceGate — credit refund on AI failure', () => {

  it('deducts credits on successful inference', async () => {
    const { gate, storage, waitUntilPromises } = makeTestDO();
    storage._data.set('balance', 1000);

    const response = await gate.fetch(inferRequest());
    expect(response.status).toBe(200);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const balance = storage._data.get('balance') as number;
    expect(balance).toBeLessThan(1000);
    expect(storage._data.get('totalSpentMicroUSDC')).toBeGreaterThan(0);
    expect(storage._data.get('totalRequests')).toBe(1);
    expect(storage._data.get('totalFailedRequests')).toBeUndefined();
  });

  it('does NOT deduct credits when AI returns empty SSE stream', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
    storage._data.set('balance', 1000);

    const response = await gate.fetch(inferRequest());
    expect(response.status).toBe(200);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(storage._data.get('balance')).toBe(1000);
    expect(storage._data.get('totalSpentMicroUSDC')).toBeUndefined();
    expect(storage._data.get('totalFailedRequests')).toBe(1);
    expect(storage._data.get('totalRequests')).toBe(1);
  });

  it('does NOT deduct credits when AI returns error JSON in SSE', async () => {
    const errorStream = mockSSEStream([
      'data: {"error":"Internal server error"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: errorStream });
    storage._data.set('balance', 500);

    const response = await gate.fetch(inferRequest());
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(storage._data.get('balance')).toBe(500);
    expect(storage._data.get('totalFailedRequests')).toBe(1);
  });

  it('does NOT deduct credits when stream errors mid-read', async () => {
    const brokenStream = erroringSSEStream(
      ['data: {"response":"Hel"}\n\n'],
      new Error('network timeout'),
    );
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: brokenStream });
    storage._data.set('balance', 500);

    const response = await gate.fetch(inferRequest());
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(storage._data.get('balance')).toBe(500);
    expect(storage._data.get('totalFailedRequests')).toBe(1);
  });

  it('does NOT append failed response to conversation history', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
    storage._data.set('balance', 1000);

    const response = await gate.fetch(inferRequest());
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(storage._data.get('history')).toBeUndefined();
  });

  it('increments totalRequests even on failure', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
    storage._data.set('balance', 1000);

    const response = await gate.fetch(inferRequest());
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(storage._data.get('totalRequests')).toBe(1);
  });

  it('still deducts credits for legitimate short responses', async () => {
    const shortStream = mockSSEStream([
      'data: {"response":"Yes"}\n\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: shortStream });
    storage._data.set('balance', 1000);

    const response = await gate.fetch(inferRequest('Is 2+2=4?'));
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(storage._data.get('balance') as number).toBeLessThan(1000);
    expect(storage._data.get('totalFailedRequests')).toBeUndefined();
  });

  it('appends successful response to conversation history', async () => {
    const { gate, storage, waitUntilPromises } = makeTestDO();
    storage._data.set('balance', 1000);

    const response = await gate.fetch(inferRequest('What is AI?'));
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const history = storage._data.get('history') as { role: string; content: string }[];
    expect(history).toBeDefined();
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('What is AI?');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Hello world');
  });

  it('exposes totalFailedRequests in /balance response', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
    storage._data.set('balance', 1000);

    // Trigger a failed inference first
    const inferRes = await gate.fetch(inferRequest());
    await drainStream(inferRes);
    await Promise.allSettled(waitUntilPromises);

    // Now check /balance
    const balanceReq = new Request('http://localhost/balance', {
      method: 'GET',
      headers: { 'X-DO-Wallet': '0xtest' },
    });
    const balanceRes = await gate.fetch(balanceReq);
    const body = await balanceRes.json() as { totalFailedRequests: number; balance: number };

    expect(body.totalFailedRequests).toBe(1);
    expect(body.balance).toBe(1000);
  });
});
