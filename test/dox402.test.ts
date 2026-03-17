import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

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
import { MIGRATIONS } from '../src/migrations';
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

/** Build a better-sqlite3 backed mock that matches Cloudflare's ctx.storage.sql API */
function makeMockStorage() {
  const db = new Database(':memory:');
  let alarm: number | null = null;

  const sqlMock = {
    exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
      const stmt = db.prepare(query);
      const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
      if (isRead) {
        const rows = stmt.all(...bindings) as T[];
        return {
          toArray: () => rows,
          one: () => { if (!rows.length) throw new Error('No rows'); return rows[0]; },
          [Symbol.iterator]: function* () { yield* rows; },
          columnNames: [] as string[],
          rowsRead: rows.length,
          rowsWritten: 0,
        };
      } else {
        const info = stmt.run(...bindings);
        return {
          toArray: () => [] as T[],
          one: () => { throw new Error('No rows'); },
          [Symbol.iterator]: function* () {},
          columnNames: [] as string[],
          rowsRead: 0,
          rowsWritten: info.changes,
        };
      }
    },
  };

  // Migrations are run later in makeTestDO after env is available
  // (migration 003 is async and requires R2 binding)

  return {
    sql: sqlMock,
    // KV stubs — used only by migrateFromKV (return empty for fresh test DOs)
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => false),
    list: vi.fn(async () => new Map()),
    transaction: vi.fn(async (cb: Function) => {
      await cb({ get: async () => undefined, put: async () => {} });
    }),
    transactionSync: <T>(cb: () => T): T => {
      return db.transaction(cb)();
    },
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (time: number | Date) => {
      alarm = typeof time === 'number' ? time : time.getTime();
    }),
    deleteAlarm: vi.fn(async () => { alarm = null; }),
    _db: db,
    _getAlarm: () => alarm,
  };
}

async function makeTestDO(opts?: { aiStream?: ReadableStream }) {
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
    blockConcurrencyWhile: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
  };

  const mockKV = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  };

  const mockVectorize = {
    upsert: vi.fn(async () => ({ count: 0, ids: [] })),
    query: vi.fn(async () => ({ count: 0, matches: [] })),
    deleteByIds: vi.fn(async () => ({ count: 0, ids: [] })),
    getByIds: vi.fn(async () => []),
  };

  const mockR2Store = new Map<string, string>();
  const mockR2 = {
    put: vi.fn(async (key: string, value: string) => { mockR2Store.set(key, value); }),
    get: vi.fn(async (key: string) => {
      const val = mockR2Store.get(key);
      if (!val) return null;
      return { text: async () => val };
    }),
    delete: vi.fn(async (key: string) => { mockR2Store.delete(key); }),
  };

  const env: Env = {
    DOX402: {} as any,
    AI: mockAI as any,
    VECTORIZE: mockVectorize as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET: 'test-secret',
    WALLET_REGISTRY: mockKV as any,
    RAG_STORAGE: mockR2 as any,
  };

  // Run migrations before constructor (migration 003 needs env with R2)
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  for (const [version, up] of MIGRATIONS) {
    await up(storage.sql, env, '');
    storage.sql.exec('INSERT INTO _schema_migrations (version, applied_at) VALUES (?, ?)',
      version, Date.now());
  }

  const gate = new InferenceGate(ctx as any, env as any);
  return { gate, storage, waitUntilPromises, mockAI, mockKV, mockVectorize, mockR2, mockR2Store };
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

const TEST_WALLET = '0xtest';

function inferBody(prompt = 'hello') {
  return { prompt, walletAddress: TEST_WALLET };
}

/** Call handleInfer via RPC with defaults for tests */
function callInfer(gate: InferenceGate, prompt = 'hello') {
  return gate.handleInfer(inferBody(prompt), null, 'localhost', TEST_WALLET);
}

// ── SQL helper for test setup/assertions ─────────────────────────────────────

function setBalance(storage: ReturnType<typeof makeMockStorage>, balance: number) {
  storage.sql.exec('UPDATE wallet_state SET balance = ? WHERE id = 1', balance);
}

function getBalance(storage: ReturnType<typeof makeMockStorage>): number {
  return (storage.sql.exec<{ balance: number }>('SELECT balance FROM wallet_state WHERE id = 1').toArray()[0]!).balance;
}

function getWalletState(storage: ReturnType<typeof makeMockStorage>) {
  return storage.sql.exec<{
    balance: number;
    total_deposited: number;
    total_spent: number;
    total_requests: number;
    total_failed_requests: number;
    provisional_balance: number;
    last_used_at: number | null;
  }>('SELECT * FROM wallet_state WHERE id = 1').toArray()[0]!;
}

function getHistoryRows(storage: ReturnType<typeof makeMockStorage>) {
  return storage.sql.exec<{ role: string; content: string; cost: number | null; model: string | null }>(
    'SELECT role, content, cost, model FROM history ORDER BY id',
  ).toArray();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InferenceGate — credit refund on AI failure', () => {

  it('deducts credits on successful inference', async () => {
    const { gate, storage, waitUntilPromises } = await makeTestDO();
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    expect(response.status).toBe(200);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const state = getWalletState(storage);
    expect(state.balance).toBeLessThan(1000);
    expect(state.total_spent).toBeGreaterThan(0);
    expect(state.total_requests).toBe(1);
    expect(state.total_failed_requests).toBe(0);
  });

  it('does NOT deduct credits when AI returns empty SSE stream', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: emptyStream });
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    expect(response.status).toBe(200);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const state = getWalletState(storage);
    expect(state.balance).toBe(1000);
    expect(state.total_spent).toBe(0);
    expect(state.total_failed_requests).toBe(1);
    expect(state.total_requests).toBe(1);
  });

  it('does NOT deduct credits when AI returns error JSON in SSE', async () => {
    const errorStream = mockSSEStream([
      'data: {"error":"Internal server error"}\n\n',
      'data: [DONE]\n\n',
    ]);
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: errorStream });
    setBalance(storage, 500);

    const response = await callInfer(gate);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const state = getWalletState(storage);
    expect(state.balance).toBe(500);
    expect(state.total_failed_requests).toBe(1);
  });

  it('does NOT deduct credits when stream errors mid-read', async () => {
    const brokenStream = erroringSSEStream(
      ['data: {"response":"Hel"}\n\n'],
      new Error('network timeout'),
    );
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: brokenStream });
    setBalance(storage, 500);

    const response = await callInfer(gate);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const state = getWalletState(storage);
    expect(state.balance).toBe(500);
    expect(state.total_failed_requests).toBe(1);
  });

  it('does NOT append failed response to conversation history', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: emptyStream });
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const history = getHistoryRows(storage);
    expect(history.length).toBe(0);
  });

  it('increments totalRequests even on failure', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: emptyStream });
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(getWalletState(storage).total_requests).toBe(1);
  });

  it('still deducts credits for legitimate short responses', async () => {
    const shortStream = mockSSEStream([
      'data: {"response":"Yes"}\n\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: shortStream });
    setBalance(storage, 1000);

    const response = await callInfer(gate, 'Is 2+2=4?');
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const state = getWalletState(storage);
    expect(state.balance).toBeLessThan(1000);
    expect(state.total_failed_requests).toBe(0);
  });

  it('appends successful response to conversation history', async () => {
    const { gate, storage, waitUntilPromises } = await makeTestDO();
    setBalance(storage, 1000);

    const response = await callInfer(gate, 'What is AI?');
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const history = getHistoryRows(storage);
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('What is AI?');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Hello world');
  });

  it('exposes totalFailedRequests in /balance response', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: emptyStream });
    setBalance(storage, 1000);

    // Trigger a failed inference first
    const inferRes = await callInfer(gate);
    await drainStream(inferRes);
    await Promise.allSettled(waitUntilPromises);

    // Now check /balance via RPC
    const balanceRes = await gate.handleBalance();
    const body = await balanceRes.json() as { totalFailedRequests: number; tokens: number };

    expect(body.totalFailedRequests).toBe(1);
    expect(body.tokens).toBe(1000);
  });
});

// ── Streaming heartbeat and duration guard ───────────────────────────────────

describe('InferenceGate — streaming heartbeat and duration guard', () => {

  /** Create a stream where we control when data arrives */
  function controllableStream() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });
    const enc = new TextEncoder();
    return {
      stream,
      push: (chunk: string) => controller.enqueue(enc.encode(chunk)),
      end: () => controller.close(),
    };
  }

  it('sends :keepalive comment when AI stream is idle', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = controllableStream();
      const { gate, storage } = await makeTestDO({ aiStream: ctrl.stream });
      setBalance(storage, 1000);

      const response = await callInfer(gate);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();

      // No data from AI yet — advance past heartbeat interval (15s)
      await vi.advanceTimersByTimeAsync(16_000);

      // Read the heartbeat comment
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(new TextDecoder().decode(value)).toBe(':keepalive\n\n');

      // Now send actual data and close the AI stream
      ctrl.push('data: {"response":"Hi"}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
      ctrl.end();

      // Drain remaining output
      while (!(await reader.read()).done) {}
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends multiple heartbeats over an extended idle period', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = controllableStream();
      const { gate, storage } = await makeTestDO({ aiStream: ctrl.stream });
      setBalance(storage, 1000);

      const response = await callInfer(gate);
      const reader = response.body!.getReader();

      // Advance through two heartbeat intervals
      await vi.advanceTimersByTimeAsync(16_000);
      const read1 = await reader.read();
      expect(new TextDecoder().decode(read1.value)).toBe(':keepalive\n\n');

      await vi.advanceTimersByTimeAsync(16_000);
      const read2 = await reader.read();
      expect(new TextDecoder().decode(read2.value)).toBe(':keepalive\n\n');

      // Clean up
      ctrl.push('data: {"response":"OK"}\n\ndata: [DONE]\n\n');
      ctrl.end();
      while (!(await reader.read()).done) {}
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes stream gracefully when max duration exceeded', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = controllableStream();
      const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: ctrl.stream });
      setBalance(storage, 1000);

      const response = await callInfer(gate);
      const reader = response.body!.getReader();

      // Advance through 9 heartbeat intervals (9 × 16s = 144s > 120s max duration)
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(16_000);
      }

      // Drain all output — should contain heartbeats and a graceful [DONE]
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }

      expect(output).toContain(':keepalive\n\n');
      expect(output).toContain('data: [DONE]\n\n');

      reader.releaseLock();
      await Promise.allSettled(waitUntilPromises);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT bill when stream is closed by max duration guard', async () => {
    vi.useFakeTimers();
    try {
      const ctrl = controllableStream();
      const { gate, storage, waitUntilPromises } = await makeTestDO({ aiStream: ctrl.stream });
      setBalance(storage, 1000);

      const response = await callInfer(gate);

      // Exceed max duration without any data from AI
      for (let i = 0; i < 9; i++) {
        await vi.advanceTimersByTimeAsync(16_000);
      }

      // Drain the output to unblock writer (prevents backpressure deadlock)
      await drainStream(response);
      await Promise.allSettled(waitUntilPromises);

      // Balance should be unchanged — no successful inference to bill
      const state = getWalletState(storage);
      expect(state.balance).toBe(1000);
      expect(state.total_spent).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send heartbeat when data flows continuously', async () => {
    // Default mock stream delivers chunks instantly — no idle period
    const { gate, storage, waitUntilPromises } = await makeTestDO();
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    const output = await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(output).not.toContain(':keepalive');
    expect(output).toContain('data:');
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
    const proof = {
      txHash,
      from: '0xtest',
      amount: String(opts?.creditedAmount ?? 1000),
      timestamp: Math.floor(Date.now() / 1000),
      signature: '0xmocksig',
    };

    storage.sql.exec(
      `INSERT INTO pending_verifications
       (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      txHash, JSON.stringify(proof), opts?.creditedAmount ?? 1000,
      Date.now(), opts?.retryCount ?? 0,
    );
    storage.sql.exec(
      'UPDATE wallet_state SET provisional_balance = ?, wallet_address = ? WHERE id = 1',
      opts?.creditedAmount ?? 1000, '0xtest',
    );
  }

  it('confirms valid transaction on re-verification', async () => {
    const { gate, storage } = await makeTestDO();
    setupPendingEntry(storage);
    setBalance(storage, 1000);

    verifyProofSpy.mockResolvedValue({ valid: true, amount: 1000 });

    await gate.alarm();

    const entry = storage.sql.exec<{ status: string }>(
      'SELECT status FROM pending_verifications WHERE tx_hash = ?', '0x' + 'a'.repeat(64),
    ).toArray()[0]!;
    expect(entry.status).toBe('confirmed');
    expect(getWalletState(storage).provisional_balance).toBe(0);
    expect(getBalance(storage)).toBe(1000); // balance unchanged
  });

  it('reverses fraudulent transaction on re-verification', async () => {
    const { gate, storage } = await makeTestDO();
    setupPendingEntry(storage, { creditedAmount: 1000 });
    setBalance(storage, 1000);

    verifyProofSpy.mockResolvedValue({ valid: false, reason: 'transaction reverted on-chain' });

    await gate.alarm();

    const entry = storage.sql.exec<{ status: string }>(
      'SELECT status FROM pending_verifications WHERE tx_hash = ?', '0x' + 'a'.repeat(64),
    ).toArray()[0]!;
    expect(entry.status).toBe('reversed');
    expect(getWalletState(storage).provisional_balance).toBe(0);
    expect(getBalance(storage)).toBe(0); // balance reversed
  });

  it('reschedules alarm on continued RPC failure', async () => {
    const { gate, storage } = await makeTestDO();
    setupPendingEntry(storage, { retryCount: 1 });

    verifyProofSpy.mockResolvedValue({ valid: true, provisional: true, reason: 'RPC timeout' });

    await gate.alarm();

    const entry = storage.sql.exec<{ status: string; retry_count: number }>(
      'SELECT status, retry_count FROM pending_verifications WHERE tx_hash = ?', '0x' + 'a'.repeat(64),
    ).toArray()[0]!;
    expect(entry.status).toBe('pending');
    expect(entry.retry_count).toBe(2);
    // Alarm should be rescheduled
    expect(storage.setAlarm).toHaveBeenCalled();
  });

  it('expires after max retries — keeps credit (benefit of doubt)', async () => {
    const { gate, storage } = await makeTestDO();
    setupPendingEntry(storage, { retryCount: 5, creditedAmount: 1000 }); // retryCount 5, will become 6 = max

    verifyProofSpy.mockResolvedValue({ valid: true, provisional: true, reason: 'RPC timeout' });

    await gate.alarm();

    const entry = storage.sql.exec<{ status: string }>(
      'SELECT status FROM pending_verifications WHERE tx_hash = ?', '0x' + 'a'.repeat(64),
    ).toArray()[0]!;
    expect(entry.status).toBe('expired');
    expect(getBalance(storage)).toBe(0); // balance NOT deducted (benefit of doubt), starts at 0
    expect(getWalletState(storage).provisional_balance).toBe(0); // tracking cleared
  });

  it('processes multiple pending entries in one alarm invocation', async () => {
    const { gate, storage } = await makeTestDO();
    const txHash1 = '0x' + 'a'.repeat(64);
    const txHash2 = '0x' + 'b'.repeat(64);

    const proof1 = { txHash: txHash1, from: '0xtest', amount: '1000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig1' };
    const proof2 = { txHash: txHash2, from: '0xtest', amount: '2000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig2' };

    storage.sql.exec(
      `INSERT INTO pending_verifications (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, ?, ?, 0, 'pending')`,
      txHash1, JSON.stringify(proof1), 1000, Date.now(),
    );
    storage.sql.exec(
      `INSERT INTO pending_verifications (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, ?, ?, 0, 'pending')`,
      txHash2, JSON.stringify(proof2), 2000, Date.now(),
    );
    storage.sql.exec(
      'UPDATE wallet_state SET provisional_balance = 3000, wallet_address = ?, balance = 3000 WHERE id = 1',
      '0xtest',
    );

    // First entry confirmed, second entry reversed
    verifyProofSpy
      .mockResolvedValueOnce({ valid: true, amount: 1000 })
      .mockResolvedValueOnce({ valid: false, reason: 'no matching USDC Transfer' });

    await gate.alarm();

    const e1 = storage.sql.exec<{ status: string }>(
      'SELECT status FROM pending_verifications WHERE tx_hash = ?', txHash1,
    ).toArray()[0]!;
    const e2 = storage.sql.exec<{ status: string }>(
      'SELECT status FROM pending_verifications WHERE tx_hash = ?', txHash2,
    ).toArray()[0]!;
    expect(e1.status).toBe('confirmed');
    expect(e2.status).toBe('reversed');
    expect(getWalletState(storage).provisional_balance).toBe(0);
    expect(getBalance(storage)).toBe(1000); // 3000 - 2000 (reversed)
  });

  it('exposes provisionalTokens in /balance response', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec(
      'UPDATE wallet_state SET balance = 2000, provisional_balance = 1000 WHERE id = 1',
    );

    const res = await gate.handleBalance();
    const body = await res.json() as { provisionalTokens: number };

    expect(body.provisionalTokens).toBe(1000);
  });
});

// ── Storage cleanup — seen transactions and terminal pending entries ─────────

describe('InferenceGate — storage cleanup', () => {
  let verifyProofSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    verifyProofSpy = vi.spyOn(x402Module, 'verifyProof');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ONE_HOUR_MS = 3_600_000;
  const TWENTY_FOUR_HOURS_MS = 86_400_000;

  it('deletes seen keys older than retention period', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Old seen key (2 hours ago) — should be cleaned up
    storage.sql.exec(
      'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
      '0x' + 'a'.repeat(64), Date.now() - 2 * ONE_HOUR_MS,
    );
    // Recent seen key (5 minutes ago) — should be kept
    storage.sql.exec(
      'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
      '0x' + 'b'.repeat(64), Date.now() - 5 * 60 * 1000,
    );

    await gate.alarm();

    const remaining = storage.sql.exec<{ tx_hash: string }>(
      'SELECT tx_hash FROM seen_transactions',
    ).toArray();
    expect(remaining.length).toBe(1);
    expect(remaining[0].tx_hash).toBe('0x' + 'b'.repeat(64));
  });

  it('deletes terminal pending entries older than 24 hours', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Old confirmed entry (48h ago) — should be cleaned up
    const proof = { txHash: '0x' + 'c'.repeat(64), from: '0xtest', amount: '1000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig' };
    storage.sql.exec(
      `INSERT INTO pending_verifications (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, 1000, ?, 1, 'confirmed')`,
      '0x' + 'c'.repeat(64), JSON.stringify(proof), Date.now() - 2 * TWENTY_FOUR_HOURS_MS,
    );

    await gate.alarm();

    const remaining = storage.sql.exec<{ tx_hash: string }>(
      'SELECT tx_hash FROM pending_verifications',
    ).toArray();
    expect(remaining.length).toBe(0);
  });

  it('keeps active pending entries regardless of age', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ?, provisional_balance = 1000 WHERE id = 1', '0xtest');

    // Old but still-pending entry — cleanup must NOT delete it
    const proof = { txHash: '0x' + 'd'.repeat(64), from: '0xtest', amount: '1000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig' };
    storage.sql.exec(
      `INSERT INTO pending_verifications (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, 1000, ?, 3, 'pending')`,
      '0x' + 'd'.repeat(64), JSON.stringify(proof), Date.now() - 2 * TWENTY_FOUR_HOURS_MS,
    );

    // Grace mode will attempt re-verification — mock as still-provisional (RPC unreachable)
    verifyProofSpy.mockResolvedValue({ valid: true, provisional: true, reason: 'RPC timeout' });

    await gate.alarm();

    // Entry should still exist and remain pending (not deleted by cleanup, kept by grace mode)
    const remaining = storage.sql.exec<{ status: string }>(
      'SELECT status FROM pending_verifications WHERE tx_hash = ?', '0x' + 'd'.repeat(64),
    ).toArray();
    expect(remaining.length).toBe(1);
    expect(remaining[0].status).toBe('pending');
  });

  it('reschedules alarm for remaining seen keys when no grace entries', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Recent seen key — not yet expired, should trigger cleanup alarm reschedule
    storage.sql.exec(
      'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
      '0x' + 'e'.repeat(64), Date.now() - 5 * 60 * 1000,
    );

    await gate.alarm();

    // setAlarm should be called to schedule future cleanup
    expect(storage.setAlarm).toHaveBeenCalled();
    const alarmTime = storage._getAlarm();
    expect(alarmTime).not.toBeNull();
    // Alarm should be in the future (~1 hour from now)
    expect(alarmTime!).toBeGreaterThan(Date.now());
  });

  it('does not reschedule alarm when all seen keys are cleaned up', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Only old seen key — will be cleaned up, no remaining keys
    storage.sql.exec(
      'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
      '0x' + 'f'.repeat(64), Date.now() - 2 * ONE_HOUR_MS,
    );

    storage.setAlarm.mockClear();
    await gate.alarm();

    // Old key should be deleted
    const remaining = storage.sql.exec<{ tx_hash: string }>(
      'SELECT tx_hash FROM seen_transactions',
    ).toArray();
    expect(remaining.length).toBe(0);
    // No alarm should be rescheduled (no remaining keys)
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it('keeps reversed/expired pending entries younger than 24h for audit', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Recent reversed entry (1h ago) — should be kept for audit
    const proof = { txHash: '0x' + 'a'.repeat(64), from: '0xtest', amount: '1000', timestamp: Math.floor(Date.now() / 1000), signature: '0xsig' };
    storage.sql.exec(
      `INSERT INTO pending_verifications (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, 1000, ?, 1, 'reversed')`,
      '0x' + 'a'.repeat(64), JSON.stringify(proof), Date.now() - ONE_HOUR_MS,
    );

    await gate.alarm();

    const remaining = storage.sql.exec<{ tx_hash: string }>(
      'SELECT tx_hash FROM pending_verifications',
    ).toArray();
    expect(remaining.length).toBe(1);
  });
});

// ── Admin status ──────────────────────────────────────────────────────────────

describe('InferenceGate — handleAdminStatus', () => {

  it('returns all wallet status fields', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec(
      `UPDATE wallet_state SET
        wallet_address = '0xtest', balance = 5000, total_deposited = 10000,
        total_spent = 5000, total_requests = 42, total_failed_requests = 3,
        provisional_balance = 1000, last_used_at = 1700000000000
      WHERE id = 1`,
    );

    const res = await gate.handleAdminStatus();
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.walletAddress).toBe('0xtest');
    expect(body.balance).toBe(5000);
    expect(body.totalDeposited).toBe(10000);
    expect(body.totalSpent).toBe(5000);
    expect(body.totalRequests).toBe(42);
    expect(body.totalFailedRequests).toBe(3);
    expect(body.provisionalBalance).toBe(1000);
    expect(body.lastUsedAt).toBe(1700000000000);
    expect(body.historyCount).toBe(0);
    expect(body.pendingCount).toBe(0);
    expect(body.nonceCount).toBe(0);
    expect(body.seenTxCount).toBe(0);
  });

  it('counts history, pending, nonce, and seen_tx rows', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Insert some history rows
    storage.sql.exec(
      'INSERT INTO history (role, content, created_at) VALUES (?, ?, ?)',
      'user', 'hello', Date.now(),
    );
    storage.sql.exec(
      'INSERT INTO history (role, content, cost, model, created_at) VALUES (?, ?, ?, ?, ?)',
      'assistant', 'world', 100, 'test-model', Date.now() + 1,
    );

    // Insert a pending verification
    const proof = { txHash: '0x' + 'a'.repeat(64), from: '0xtest', amount: '1000', timestamp: 0, signature: '0xsig' };
    storage.sql.exec(
      `INSERT INTO pending_verifications (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
       VALUES (?, ?, 1000, ?, 0, 'pending')`,
      '0x' + 'a'.repeat(64), JSON.stringify(proof), Date.now(),
    );

    // Insert a nonce
    storage.sql.exec('INSERT INTO nonces (nonce, created_at) VALUES (?, ?)', 'testnonce', Date.now());

    // Insert a seen transaction
    storage.sql.exec(
      'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
      '0x' + 'b'.repeat(64), Date.now(),
    );

    const res = await gate.handleAdminStatus();
    const body = await res.json() as Record<string, unknown>;

    expect(body.historyCount).toBe(2);
    expect(body.pendingCount).toBe(1);
    expect(body.nonceCount).toBe(1);
    expect(body.seenTxCount).toBe(1);
  });

  it('is not rate-limited (admin bypass)', async () => {
    const { gate, storage } = await makeTestDO();
    storage.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', '0xtest');

    // Fill up the rate limit window
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 60);
    storage.sql.exec(
      'INSERT INTO rate_limits (window_start, count) VALUES (?, 999)',
      windowStart,
    );

    // handleAdminStatus should still work (no rate limit check)
    const res = await gate.handleAdminStatus();
    expect(res.status).toBe(200);
  });
});

// ── KV registration ──────────────────────────────────────────────────────────

describe('InferenceGate — KV wallet registration', () => {

  it('registers wallet in KV on first handleInfer call', async () => {
    const { gate, storage, waitUntilPromises, mockKV } = await makeTestDO();
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    expect(mockKV.put).toHaveBeenCalledOnce();
    expect(mockKV.put).toHaveBeenCalledWith(
      TEST_WALLET,
      expect.stringContaining('"registeredAt"'),
    );
  });

  it('does NOT re-register on subsequent handleInfer calls', async () => {
    const { gate, storage, waitUntilPromises, mockKV } = await makeTestDO();
    setBalance(storage, 2000);

    // First call — should register
    const res1 = await callInfer(gate);
    await drainStream(res1);
    await Promise.allSettled(waitUntilPromises);
    expect(mockKV.put).toHaveBeenCalledOnce();

    mockKV.put.mockClear();

    // Second call — wallet already set, should NOT register again
    const res2 = await callInfer(gate, 'second prompt');
    await drainStream(res2);
    await Promise.allSettled(waitUntilPromises);
    expect(mockKV.put).not.toHaveBeenCalled();
  });
});

// ── Document CRUD ────────────────────────────────────────────────────────────

describe('InferenceGate — document CRUD', () => {

  /** Override mockAI.run to handle both embedding and inference models */
  function setupAIForDocuments(mockAI: { run: ReturnType<typeof vi.fn> }) {
    mockAI.run.mockImplementation(async (model: string) => {
      if (model === '@cf/baai/bge-base-en-v1.5') {
        return { data: [new Array(768).fill(0.1)] };
      }
      return mockSSEStream([
        'data: {"response":"Hello "}\n\n',
        'data: {"response":"world"}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
  }

  it('handleDocumentUpload returns 201 with DocumentMeta', async () => {
    const { gate, storage, mockAI } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 10000);

    const res = await gate.handleDocumentUpload(
      { title: 'test doc', content: 'Hello world content for testing RAG upload' },
      TEST_WALLET,
    );
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe('string');
    expect(body.title).toBe('test doc');
    expect(body.charCount).toBe(42);
    expect(body.chunkCount).toBeGreaterThanOrEqual(1);
    expect(body.createdAt).toBeDefined();
    expect(body.embeddingCostTokens).toBeGreaterThan(0);
  });

  it('handleDocumentUpload deducts embedding cost from balance', async () => {
    const { gate, storage, mockAI } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 10000);

    await gate.handleDocumentUpload(
      { title: 'cost test', content: 'Some content to embed and charge for' },
      TEST_WALLET,
    );

    const state = getWalletState(storage);
    expect(state.balance).toBeLessThan(10000);
    expect(state.total_spent).toBeGreaterThan(0);
  });

  it('handleDocumentUpload inserts into documents and document_chunks tables', async () => {
    const { gate, storage, mockAI } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 10000);

    await gate.handleDocumentUpload(
      { title: 'sql test', content: 'Document content to verify SQL insertion' },
      TEST_WALLET,
    );

    const docs = storage.sql.exec<{ id: string }>('SELECT * FROM documents').toArray();
    expect(docs.length).toBe(1);

    const chunks = storage.sql.exec<{ chunk_id: string }>('SELECT * FROM document_chunks').toArray();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('handleDocumentUpload calls VECTORIZE.upsert', async () => {
    const { gate, storage, mockAI, mockVectorize } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 10000);

    await gate.handleDocumentUpload(
      { title: 'vectorize test', content: 'Content to test vectorize upsert call' },
      TEST_WALLET,
    );

    expect(mockVectorize.upsert).toHaveBeenCalled();
    const firstArg = mockVectorize.upsert.mock.calls[0][0] as Array<{ id: string; metadata: Record<string, unknown> }>;
    expect(Array.isArray(firstArg)).toBe(true);
    expect(firstArg[0].metadata.wallet).toBe(TEST_WALLET);
  });

  it('handleDocumentUpload rejects content > 100KB', async () => {
    const { gate, storage, mockAI } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 10000);

    const res = await gate.handleDocumentUpload(
      { title: 'too big', content: 'x'.repeat(102_401) },
      TEST_WALLET,
    );
    expect(res.status).toBe(400);
  });

  it('handleDocumentUpload rejects when at document limit', async () => {
    const { gate, storage, mockAI } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 10000);

    // Insert 50 dummy documents directly via SQL
    for (let i = 0; i < 50; i++) {
      storage.sql.exec(
        `INSERT INTO documents (id, title, char_count, chunk_count, embedding_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        `doc-${i}`, `title-${i}`, 7, 1, 1, Date.now(),
      );
    }

    const res = await gate.handleDocumentUpload(
      { title: 'one too many', content: 'should be rejected' },
      TEST_WALLET,
    );
    expect(res.status).toBe(409);
  });

  it('handleDocumentUpload rejects insufficient balance', async () => {
    const { gate, storage, mockAI } = await makeTestDO();
    setupAIForDocuments(mockAI);
    setBalance(storage, 0);

    const res = await gate.handleDocumentUpload(
      { title: 'no funds', content: 'should fail due to zero balance' },
      TEST_WALLET,
    );
    expect(res.status).toBe(402);
  });

  it('handleDocumentList returns documents in descending order', async () => {
    const { gate, storage } = await makeTestDO();

    // Insert 2 documents directly via SQL with different timestamps
    storage.sql.exec(
      `INSERT INTO documents (id, title, char_count, chunk_count, embedding_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'doc-older', 'Older Doc', 11, 1, 1, 1000,
    );
    storage.sql.exec(
      `INSERT INTO documents (id, title, char_count, chunk_count, embedding_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'doc-newer', 'Newer Doc', 11, 1, 1, 2000,
    );

    const res = await gate.handleDocumentList();
    expect(res.status).toBe(200);

    const body = await res.json() as { documents: Array<{ id: string; title: string }> };
    expect(body.documents.length).toBe(2);
    expect(body.documents[0].title).toBe('Newer Doc');
    expect(body.documents[1].title).toBe('Older Doc');
  });

  it('handleDocumentDelete removes from SQL and calls VECTORIZE.deleteByIds', async () => {
    const { gate, storage, mockVectorize } = await makeTestDO();

    const docId = 'doc-to-delete';

    // Insert a document and chunks directly
    storage.sql.exec(
      `INSERT INTO documents (id, title, char_count, chunk_count, embedding_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      docId, 'Delete Me', 12, 2, 1, Date.now(),
    );
    storage.sql.exec(
      'INSERT INTO document_chunks (chunk_id, document_id, chunk_index) VALUES (?, ?, ?)',
      `${docId}:0`, docId, 0,
    );
    storage.sql.exec(
      'INSERT INTO document_chunks (chunk_id, document_id, chunk_index) VALUES (?, ?, ?)',
      `${docId}:1`, docId, 1,
    );

    const res = await gate.handleDocumentDelete(docId);
    expect(res.status).toBe(200);

    // Verify SQL deletion
    const docsLeft = storage.sql.exec<{ id: string }>('SELECT * FROM documents WHERE id = ?', docId).toArray();
    expect(docsLeft.length).toBe(0);

    const chunksLeft = storage.sql.exec<{ chunk_id: string }>('SELECT * FROM document_chunks WHERE document_id = ?', docId).toArray();
    expect(chunksLeft.length).toBe(0);

    // Verify Vectorize deleteByIds was called
    expect(mockVectorize.deleteByIds).toHaveBeenCalledWith([`${docId}:0`, `${docId}:1`]);
  });

  it('handleDocumentDelete returns 404 for unknown ID', async () => {
    const { gate } = await makeTestDO();

    const res = await gate.handleDocumentDelete('nonexistent');
    expect(res.status).toBe(404);
  });
});

// ── RAG-augmented inference ──────────────────────────────────────────────────

describe('InferenceGate — RAG-augmented inference', () => {

  /** Override mockAI.run to handle both embedding and inference models */
  function setupAIForRAG(mockAI: { run: ReturnType<typeof vi.fn> }) {
    mockAI.run.mockImplementation(async (model: string) => {
      if (model === '@cf/baai/bge-base-en-v1.5') {
        return { data: [new Array(768).fill(0.1)] };
      }
      return mockSSEStream([
        'data: {"response":"Hello "}\n\n',
        'data: {"response":"world"}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
  }

  it('useRag=true with matching chunks prepends system message', async () => {
    const { gate, storage, waitUntilPromises, mockAI, mockVectorize } = await makeTestDO();
    setupAIForRAG(mockAI);
    setBalance(storage, 10000);

    mockVectorize.query.mockResolvedValue({
      count: 1,
      matches: [{ id: 'doc:0', score: 0.8, metadata: { text: 'Some relevant context' } }],
    });

    const res = await gate.handleInfer(
      { prompt: 'hello', walletAddress: TEST_WALLET, useRag: true },
      null, 'localhost', TEST_WALLET,
    );
    expect(res.status).toBe(200);
    await drainStream(res);
    await Promise.allSettled(waitUntilPromises);

    // Find the inference AI.run call (not the embedding call)
    const inferenceCalls = mockAI.run.mock.calls.filter(
      (call: unknown[]) => call[0] !== '@cf/baai/bge-base-en-v1.5',
    );
    expect(inferenceCalls.length).toBeGreaterThanOrEqual(1);

    const messages = (inferenceCalls[0][1] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Some relevant context');
  });

  it('useRag=true with no matches does not prepend system message', async () => {
    const { gate, storage, waitUntilPromises, mockAI, mockVectorize } = await makeTestDO();
    setupAIForRAG(mockAI);
    setBalance(storage, 10000);

    mockVectorize.query.mockResolvedValue({ count: 0, matches: [] });

    const res = await gate.handleInfer(
      { prompt: 'hello', walletAddress: TEST_WALLET, useRag: true },
      null, 'localhost', TEST_WALLET,
    );
    expect(res.status).toBe(200);
    await drainStream(res);
    await Promise.allSettled(waitUntilPromises);

    // Find the inference AI.run call
    const inferenceCalls = mockAI.run.mock.calls.filter(
      (call: unknown[]) => call[0] !== '@cf/baai/bge-base-en-v1.5',
    );
    expect(inferenceCalls.length).toBeGreaterThanOrEqual(1);

    const messages = (inferenceCalls[0][1] as { messages: Array<{ role: string }> }).messages;
    const hasSystem = messages.some((m: { role: string }) => m.role === 'system');
    expect(hasSystem).toBe(false);
  });

  it('useRag=false (default) does not query Vectorize', async () => {
    const { gate, storage, waitUntilPromises, mockVectorize } = await makeTestDO();
    setBalance(storage, 10000);

    const res = await callInfer(gate);
    await drainStream(res);
    await Promise.allSettled(waitUntilPromises);

    expect(mockVectorize.query).not.toHaveBeenCalled();
  });

  it('RAG query cost added to billing', async () => {
    const { gate, storage, waitUntilPromises, mockAI, mockVectorize } = await makeTestDO();
    setupAIForRAG(mockAI);
    setBalance(storage, 10000);

    mockVectorize.query.mockResolvedValue({
      count: 1,
      matches: [{ id: 'doc:0', score: 0.8, metadata: { text: 'Context chunk' } }],
    });

    const res = await gate.handleInfer(
      { prompt: 'hello', walletAddress: TEST_WALLET, useRag: true },
      null, 'localhost', TEST_WALLET,
    );
    await drainStream(res);
    await Promise.allSettled(waitUntilPromises);

    // Also run a non-RAG inference for comparison
    const { gate: gate2, storage: storage2, waitUntilPromises: wup2 } = await makeTestDO();
    setBalance(storage2, 10000);

    const res2 = await callInfer(gate2);
    await drainStream(res2);
    await Promise.allSettled(wup2);

    const ragState = getWalletState(storage);
    const noRagState = getWalletState(storage2);

    // RAG inference should cost more than non-RAG (inference cost + RAG query cost)
    expect(ragState.total_spent).toBeGreaterThan(noRagState.total_spent);
  });

  it('RAG failure is non-fatal (inference proceeds)', async () => {
    const { gate, storage, waitUntilPromises, mockAI, mockVectorize } = await makeTestDO();
    setupAIForRAG(mockAI);
    setBalance(storage, 10000);

    // Make Vectorize.query throw
    mockVectorize.query.mockRejectedValue(new Error('Vectorize unavailable'));

    const res = await gate.handleInfer(
      { prompt: 'hello', walletAddress: TEST_WALLET, useRag: true },
      null, 'localhost', TEST_WALLET,
    );
    expect(res.status).toBe(200);
    await drainStream(res);
    await Promise.allSettled(waitUntilPromises);

    // Inference should still succeed
    const state = getWalletState(storage);
    expect(state.total_requests).toBe(1);
  });

  it('useRag=undefined is backward compatible (Vectorize not queried)', async () => {
    const { gate, storage, waitUntilPromises, mockVectorize } = await makeTestDO();
    setBalance(storage, 10000);

    const res = await gate.handleInfer(
      { prompt: 'hello', walletAddress: TEST_WALLET },
      null, 'localhost', TEST_WALLET,
    );
    await drainStream(res);
    await Promise.allSettled(waitUntilPromises);

    expect(mockVectorize.query).not.toHaveBeenCalled();
  });
});
