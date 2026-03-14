import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import type { Env, PendingVerification, VerifyProofResult } from '../src/types';
import * as x402Module from '../src/x402';

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
  let alarm: number | null = null;
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
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (time: number | Date) => { alarm = typeof time === 'number' ? time : time.getTime(); }),
    deleteAlarm: vi.fn(async () => { alarm = null; }),
    _data: data,
    _getAlarm: () => alarm,
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

// ── Grace mode — alarm re-verification ──────────────────────────────────────

describe('InferenceGate — alarm re-verification', () => {
  let verifyProofSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    verifyProofSpy = vi.spyOn(x402Module, 'verifyProof');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupPendingEntry(storage: ReturnType<typeof makeMockStorage>, opts?: {
    txHash?: string;
    retryCount?: number;
    creditedAmount?: number;
  }) {
    const txHash = opts?.txHash ?? '0x' + 'a'.repeat(64);
    const entry: PendingVerification = {
      proof: {
        txHash,
        from: '0xtest',
        amount: String(opts?.creditedAmount ?? 1000),
        timestamp: Math.floor(Date.now() / 1000),
        signature: '0xmocksig',
      },
      creditedAmount: opts?.creditedAmount ?? 1000,
      createdAt: Date.now(),
      retryCount: opts?.retryCount ?? 0,
      status: 'pending',
    };
    storage._data.set(`pending:${txHash}`, entry);
    storage._data.set('pendingTxHashes', [txHash]);
    storage._data.set('provisionalBalance', opts?.creditedAmount ?? 1000);
    storage._data.set('walletAddress', '0xtest');
  }

  it('confirms valid transaction on re-verification', async () => {
    const { gate, storage } = makeTestDO();
    setupPendingEntry(storage);
    storage._data.set('balance', 1000);

    verifyProofSpy.mockResolvedValue({ valid: true, amount: 1000 });

    await gate.alarm();

    const entry = storage._data.get('pending:0x' + 'a'.repeat(64)) as PendingVerification;
    expect(entry.status).toBe('confirmed');
    expect(storage._data.get('provisionalBalance')).toBe(0);
    expect(storage._data.get('balance')).toBe(1000); // balance unchanged
    expect((storage._data.get('pendingTxHashes') as string[]).length).toBe(0);
  });

  it('reverses fraudulent transaction on re-verification', async () => {
    const { gate, storage } = makeTestDO();
    setupPendingEntry(storage, { creditedAmount: 1000 });
    storage._data.set('balance', 1000);

    verifyProofSpy.mockResolvedValue({ valid: false, reason: 'transaction reverted on-chain' });

    await gate.alarm();

    const entry = storage._data.get('pending:0x' + 'a'.repeat(64)) as PendingVerification;
    expect(entry.status).toBe('reversed');
    expect(storage._data.get('provisionalBalance')).toBe(0);
    expect(storage._data.get('balance')).toBe(0); // balance reversed
  });

  it('reschedules alarm on continued RPC failure', async () => {
    const { gate, storage } = makeTestDO();
    setupPendingEntry(storage, { retryCount: 1 });

    verifyProofSpy.mockResolvedValue({ valid: true, provisional: true, reason: 'RPC timeout' });

    await gate.alarm();

    const entry = storage._data.get('pending:0x' + 'a'.repeat(64)) as PendingVerification;
    expect(entry.status).toBe('pending');
    expect(entry.retryCount).toBe(2);
    // Alarm should be rescheduled
    expect(storage.setAlarm).toHaveBeenCalled();
  });

  it('expires after max retries — keeps credit (benefit of doubt)', async () => {
    const { gate, storage } = makeTestDO();
    setupPendingEntry(storage, { retryCount: 5, creditedAmount: 1000 }); // retryCount 5, will become 6 = max

    verifyProofSpy.mockResolvedValue({ valid: true, provisional: true, reason: 'RPC timeout' });

    await gate.alarm();

    const entry = storage._data.get('pending:0x' + 'a'.repeat(64)) as PendingVerification;
    expect(entry.status).toBe('expired');
    expect(storage._data.get('balance')).toBeUndefined(); // balance NOT deducted (benefit of doubt)
    expect(storage._data.get('provisionalBalance')).toBe(0); // tracking cleared
  });

  it('processes multiple pending entries in one alarm invocation', async () => {
    const { gate, storage } = makeTestDO();
    const txHash1 = '0x' + 'a'.repeat(64);
    const txHash2 = '0x' + 'b'.repeat(64);

    const entry1: PendingVerification = {
      proof: { txHash: txHash1, from: '0xtest', amount: '1000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig1' },
      creditedAmount: 1000, createdAt: Date.now(), retryCount: 0, status: 'pending',
    };
    const entry2: PendingVerification = {
      proof: { txHash: txHash2, from: '0xtest', amount: '2000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig2' },
      creditedAmount: 2000, createdAt: Date.now(), retryCount: 0, status: 'pending',
    };
    storage._data.set(`pending:${txHash1}`, entry1);
    storage._data.set(`pending:${txHash2}`, entry2);
    storage._data.set('pendingTxHashes', [txHash1, txHash2]);
    storage._data.set('provisionalBalance', 3000);
    storage._data.set('walletAddress', '0xtest');
    storage._data.set('balance', 3000);

    // First entry confirmed, second entry reversed
    verifyProofSpy
      .mockResolvedValueOnce({ valid: true, amount: 1000 })
      .mockResolvedValueOnce({ valid: false, reason: 'no matching USDC Transfer' });

    await gate.alarm();

    expect((storage._data.get(`pending:${txHash1}`) as PendingVerification).status).toBe('confirmed');
    expect((storage._data.get(`pending:${txHash2}`) as PendingVerification).status).toBe('reversed');
    expect(storage._data.get('provisionalBalance')).toBe(0);
    expect(storage._data.get('balance')).toBe(1000); // 3000 - 2000 (reversed)
  });

  it('exposes provisionalMicroUSDC in /balance response', async () => {
    const { gate, storage } = makeTestDO();
    storage._data.set('balance', 2000);
    storage._data.set('provisionalBalance', 1000);

    const balanceReq = new Request('http://localhost/balance', {
      method: 'GET',
      headers: { 'X-DO-Wallet': '0xtest' },
    });
    const res = await gate.fetch(balanceReq);
    const body = await res.json() as { provisionalMicroUSDC: number };

    expect(body.provisionalMicroUSDC).toBe(1000);
  });
});
