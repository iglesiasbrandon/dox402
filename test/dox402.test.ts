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

  // Run schema migrations (same as production)
  sqlMock.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  for (const [version, up] of MIGRATIONS) {
    up(sqlMock);
    sqlMock.exec('INSERT INTO _schema_migrations (version, applied_at) VALUES (?, ?)',
      version, Date.now());
  }

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
    blockConcurrencyWhile: vi.fn(async (cb: () => Promise<void>) => { await cb(); }),
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
    const { gate, storage, waitUntilPromises } = makeTestDO();
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
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
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
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: errorStream });
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
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: brokenStream });
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
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
    setBalance(storage, 1000);

    const response = await callInfer(gate);
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const history = getHistoryRows(storage);
    expect(history.length).toBe(0);
  });

  it('increments totalRequests even on failure', async () => {
    const emptyStream = mockSSEStream(['data: [DONE]\n\n']);
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
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
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: shortStream });
    setBalance(storage, 1000);

    const response = await callInfer(gate, 'Is 2+2=4?');
    await drainStream(response);
    await Promise.allSettled(waitUntilPromises);

    const state = getWalletState(storage);
    expect(state.balance).toBeLessThan(1000);
    expect(state.total_failed_requests).toBe(0);
  });

  it('appends successful response to conversation history', async () => {
    const { gate, storage, waitUntilPromises } = makeTestDO();
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
    const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: emptyStream });
    setBalance(storage, 1000);

    // Trigger a failed inference first
    const inferRes = await callInfer(gate);
    await drainStream(inferRes);
    await Promise.allSettled(waitUntilPromises);

    // Now check /balance via RPC
    const balanceRes = await gate.handleBalance();
    const body = await balanceRes.json() as { totalFailedRequests: number; balance: number };

    expect(body.totalFailedRequests).toBe(1);
    expect(body.balance).toBe(1000);
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
      const { gate, storage } = makeTestDO({ aiStream: ctrl.stream });
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
      const { gate, storage } = makeTestDO({ aiStream: ctrl.stream });
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
      const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: ctrl.stream });
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
      const { gate, storage, waitUntilPromises } = makeTestDO({ aiStream: ctrl.stream });
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
    const { gate, storage, waitUntilPromises } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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

  it('exposes provisionalMicroUSDC in /balance response', async () => {
    const { gate, storage } = makeTestDO();
    storage.sql.exec(
      'UPDATE wallet_state SET balance = 2000, provisional_balance = 1000 WHERE id = 1',
    );

    const res = await gate.handleBalance();
    const body = await res.json() as { provisionalMicroUSDC: number };

    expect(body.provisionalMicroUSDC).toBe(1000);
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
    const { gate, storage } = makeTestDO();
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
