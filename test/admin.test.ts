import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers (imported transitively via dox402.ts)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import worker from '../src/index';
import type { Env, AdminWalletStatus } from '../src/types';

const ADMIN_SECRET = 'test-admin-secret-12345';
const SESSION_SECRET = 'test-session-secret';

// ── KV namespace mock ──────────────────────────────────────────────────────

interface MockKVStore {
  store: Map<string, string>;
  namespace: KVNamespace;
}

function makeMockKVNamespace(entries?: Record<string, string>): MockKVStore {
  const store = new Map<string, string>(Object.entries(entries ?? {}));

  const namespace = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async (opts?: { limit?: number; cursor?: string }) => {
      const allKeys = Array.from(store.keys()).sort();
      const limit = opts?.limit ?? 1000;

      // Simple cursor: index-based
      let startIdx = 0;
      if (opts?.cursor) {
        startIdx = parseInt(opts.cursor, 10) || 0;
      }

      const slice = allKeys.slice(startIdx, startIdx + limit);
      const keys = slice.map(name => ({ name }));
      const complete = startIdx + limit >= allKeys.length;

      return {
        keys,
        list_complete: complete,
        cursor: complete ? '' : String(startIdx + limit),
      };
    }),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;

  return { store, namespace };
}

// ── DO namespace mock ──────────────────────────────────────────────────────

function makeMockDONamespace(opts?: {
  adminStatus?: AdminWalletStatus;
}) {
  const defaultStatus: AdminWalletStatus = {
    walletAddress: '0x0000000000000000000000000000000000000000',
    balance: 0,
    totalDeposited: 0,
    totalSpent: 0,
    totalRequests: 0,
    totalFailedRequests: 0,
    provisionalBalance: 0,
    lastUsedAt: null,
    historyCount: 0,
    pendingCount: 0,
    nonceCount: 0,
    seenTxCount: 0,
  };

  const handleAdminStatus = vi.fn(async () =>
    Response.json(opts?.adminStatus ?? defaultStatus, { headers: { 'Cache-Control': 'no-store' } }),
  );

  const stub = {
    handleNonce: vi.fn(async () => Response.json({ nonce: 'test' })),
    handleVerifyNonce: vi.fn(async () => Response.json({ ok: true })),
    handleInfer: vi.fn(async () => Response.json({ response: 'ok' })),
    handleDeposit: vi.fn(async () => Response.json({ ok: true })),
    handleBalance: vi.fn(async () => Response.json({ balance: 0 })),
    handleHistory: vi.fn(async () => Response.json({ history: [] })),
    handleClearHistory: vi.fn(async () => Response.json({ ok: true })),
    handleAdminStatus,
  };

  return {
    idFromName: vi.fn(() => ({ toString: () => 'mock-do-id' })),
    get: vi.fn(() => stub),
    _mocks: stub,
  };
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DOX402: makeMockDONamespace() as any,
    AI: {} as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET,
    WALLET_REGISTRY: makeMockKVNamespace().namespace,
    ADMIN_SECRET,
    ...overrides,
  };
}

function adminGet(path: string, env: Env): Promise<Response> {
  return worker.fetch(
    new Request(`https://dox402.example.com${path}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
    }),
    env,
  );
}

// ── Admin auth ────────────────────────────────────────────────────────────────

describe('Admin auth', () => {
  it('returns 503 when ADMIN_SECRET is not configured', async () => {
    const env = makeEnv({ ADMIN_SECRET: undefined });
    const res = await adminGet('/admin/wallets', env);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('ADMIN_SECRET');
  });

  it('returns 401 when Authorization header is missing', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://dox402.example.com/admin/wallets', { method: 'GET' }),
      env,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Admin');
  });

  it('returns 401 on wrong admin token', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request('https://dox402.example.com/admin/wallets', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer wrong-token' },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 on correct admin token', async () => {
    const env = makeEnv();
    const res = await adminGet('/admin/wallets', env);
    expect(res.status).toBe(200);
  });
});

// ── GET /admin/wallets ────────────────────────────────────────────────────────

describe('GET /admin/wallets', () => {
  it('returns empty list when no wallets are registered', async () => {
    const env = makeEnv();
    const res = await adminGet('/admin/wallets', env);
    expect(res.status).toBe(200);
    const body = await res.json() as { wallets: unknown[]; hasMore: boolean; cursor: string | null };
    expect(body.wallets).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.cursor).toBeNull();
  });

  it('returns registered wallets', async () => {
    const { namespace } = makeMockKVNamespace({
      '0x1111111111111111111111111111111111111111': JSON.stringify({ registeredAt: 1000 }),
      '0x2222222222222222222222222222222222222222': JSON.stringify({ registeredAt: 2000 }),
    });
    const env = makeEnv({ WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/wallets', env);
    const body = await res.json() as { wallets: { wallet: string }[] };
    expect(body.wallets.length).toBe(2);
    expect(body.wallets[0].wallet).toMatch(/^0x/);
  });

  it('respects limit parameter', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const addr = `0x${String(i).padStart(40, '0')}`;
      entries[addr] = JSON.stringify({ registeredAt: i * 1000 });
    }
    const { namespace } = makeMockKVNamespace(entries);
    const env = makeEnv({ WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/wallets?limit=2', env);
    const body = await res.json() as { wallets: unknown[]; hasMore: boolean; cursor: string | null };
    expect(body.wallets.length).toBe(2);
    expect(body.hasMore).toBe(true);
    expect(body.cursor).toBeTruthy();
  });

  it('caps limit at 1000', async () => {
    const env = makeEnv();
    const res = await adminGet('/admin/wallets?limit=5000', env);
    expect(res.status).toBe(200);
    // Should not error — the limit is capped internally
  });
});

// ── GET /admin/wallets/:wallet/status ─────────────────────────────────────────

describe('GET /admin/wallets/:wallet/status', () => {
  it('returns detailed DO status for a valid wallet', async () => {
    const status: AdminWalletStatus = {
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      balance: 5000,
      totalDeposited: 10000,
      totalSpent: 5000,
      totalRequests: 42,
      totalFailedRequests: 3,
      provisionalBalance: 0,
      lastUsedAt: 1700000000000,
      historyCount: 10,
      pendingCount: 0,
      nonceCount: 1,
      seenTxCount: 5,
    };
    const doNS = makeMockDONamespace({ adminStatus: status });
    const env = makeEnv({ DOX402: doNS as any });

    const res = await adminGet('/admin/wallets/0x1234567890abcdef1234567890abcdef12345678/status', env);
    expect(res.status).toBe(200);
    const body = await res.json() as AdminWalletStatus;
    expect(body.walletAddress).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(body.balance).toBe(5000);
    expect(body.totalRequests).toBe(42);
    expect(body.historyCount).toBe(10);
  });

  it('routes to the correct DO based on wallet address', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    await adminGet('/admin/wallets/0xabcdef1234567890abcdef1234567890abcdef12/status', env);

    // idFromName should be called with lowercase wallet sans 0x prefix
    expect(doNS.idFromName).toHaveBeenCalledWith('abcdef1234567890abcdef1234567890abcdef12');
  });

  it('rejects invalid wallet address format', async () => {
    const env = makeEnv();
    const res = await adminGet('/admin/wallets/not-a-wallet/status', env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('wallet');
  });
});

// ── GET /admin/stats ──────────────────────────────────────────────────────────

describe('GET /admin/stats', () => {
  it('returns total wallet count of zero when empty', async () => {
    const env = makeEnv();
    const res = await adminGet('/admin/stats', env);
    expect(res.status).toBe(200);
    const body = await res.json() as { totalWallets: number };
    expect(body.totalWallets).toBe(0);
  });

  it('counts all registered wallets', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      const addr = `0x${String(i).padStart(40, '0')}`;
      entries[addr] = JSON.stringify({ registeredAt: i * 1000 });
    }
    const { namespace } = makeMockKVNamespace(entries);
    const env = makeEnv({ WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/stats', env);
    const body = await res.json() as { totalWallets: number };
    expect(body.totalWallets).toBe(3);
  });
});

// ── GET /admin/stale ──────────────────────────────────────────────────────────

describe('GET /admin/stale', () => {
  it('identifies zero-balance inactive wallets', async () => {
    const staleStatus: AdminWalletStatus = {
      walletAddress: '0x1111111111111111111111111111111111111111',
      balance: 0,
      totalDeposited: 1000,
      totalSpent: 1000,
      totalRequests: 5,
      totalFailedRequests: 0,
      provisionalBalance: 0,
      lastUsedAt: Date.now() - 60 * 86_400_000, // 60 days ago
      historyCount: 2,
      pendingCount: 0,
      nonceCount: 0,
      seenTxCount: 0,
    };
    const doNS = makeMockDONamespace({ adminStatus: staleStatus });
    const { namespace } = makeMockKVNamespace({
      '0x1111111111111111111111111111111111111111': JSON.stringify({ registeredAt: 1000 }),
    });
    const env = makeEnv({ DOX402: doNS as any, WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/stale?inactive_days=30', env);
    expect(res.status).toBe(200);
    const body = await res.json() as { stale: AdminWalletStatus[]; count: number };
    expect(body.count).toBe(1);
    expect(body.stale[0].walletAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('excludes wallets with balance above max_balance', async () => {
    const activeStatus: AdminWalletStatus = {
      walletAddress: '0x2222222222222222222222222222222222222222',
      balance: 5000,
      totalDeposited: 5000,
      totalSpent: 0,
      totalRequests: 1,
      totalFailedRequests: 0,
      provisionalBalance: 0,
      lastUsedAt: Date.now() - 60 * 86_400_000,
      historyCount: 0,
      pendingCount: 0,
      nonceCount: 0,
      seenTxCount: 0,
    };
    const doNS = makeMockDONamespace({ adminStatus: activeStatus });
    const { namespace } = makeMockKVNamespace({
      '0x2222222222222222222222222222222222222222': JSON.stringify({ registeredAt: 1000 }),
    });
    const env = makeEnv({ DOX402: doNS as any, WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/stale?inactive_days=30&max_balance=0', env);
    const body = await res.json() as { stale: AdminWalletStatus[]; count: number };
    expect(body.count).toBe(0);
  });

  it('excludes recently active wallets', async () => {
    const recentStatus: AdminWalletStatus = {
      walletAddress: '0x3333333333333333333333333333333333333333',
      balance: 0,
      totalDeposited: 1000,
      totalSpent: 1000,
      totalRequests: 10,
      totalFailedRequests: 0,
      provisionalBalance: 0,
      lastUsedAt: Date.now() - 5 * 86_400_000, // 5 days ago — within 30-day window
      historyCount: 0,
      pendingCount: 0,
      nonceCount: 0,
      seenTxCount: 0,
    };
    const doNS = makeMockDONamespace({ adminStatus: recentStatus });
    const { namespace } = makeMockKVNamespace({
      '0x3333333333333333333333333333333333333333': JSON.stringify({ registeredAt: 1000 }),
    });
    const env = makeEnv({ DOX402: doNS as any, WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/stale?inactive_days=30', env);
    const body = await res.json() as { stale: AdminWalletStatus[]; count: number };
    expect(body.count).toBe(0);
  });

  it('includes wallets with null lastUsedAt as stale', async () => {
    const neverUsedStatus: AdminWalletStatus = {
      walletAddress: '0x4444444444444444444444444444444444444444',
      balance: 0,
      totalDeposited: 0,
      totalSpent: 0,
      totalRequests: 0,
      totalFailedRequests: 0,
      provisionalBalance: 0,
      lastUsedAt: null,
      historyCount: 0,
      pendingCount: 0,
      nonceCount: 0,
      seenTxCount: 0,
    };
    const doNS = makeMockDONamespace({ adminStatus: neverUsedStatus });
    const { namespace } = makeMockKVNamespace({
      '0x4444444444444444444444444444444444444444': JSON.stringify({ registeredAt: 1000 }),
    });
    const env = makeEnv({ DOX402: doNS as any, WALLET_REGISTRY: namespace });

    const res = await adminGet('/admin/stale?inactive_days=30', env);
    const body = await res.json() as { stale: AdminWalletStatus[]; count: number };
    expect(body.count).toBe(1);
  });

  it('returns criteria in response', async () => {
    const env = makeEnv();
    const res = await adminGet('/admin/stale?inactive_days=45&max_balance=100&limit=10', env);
    const body = await res.json() as { criteria: { inactiveDays: number; maxBalance: number; limit: number } };
    expect(body.criteria.inactiveDays).toBe(45);
    expect(body.criteria.maxBalance).toBe(100);
    expect(body.criteria.limit).toBe(10);
  });
});
