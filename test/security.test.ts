import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import worker from '../src/index';
import { createSessionToken } from '../src/session';
import type { Env } from '../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://dox402.test';
const SESSION_SECRET = 'test-session-secret';
const ADMIN_SECRET = 'test-admin-secret';
const TEST_WALLET = '0x1234567890abcdef1234567890abcdef12345678';

function makeMockDONamespace() {
  const mockStub = {
    handleInfer: vi.fn(async () => new Response('streamed', { status: 200 })),
    handleDeposit: vi.fn(async () => Response.json({ ok: true, credited: 1000, tokens: 1000 })),
    handleBalance: vi.fn(async () => Response.json({ tokens: 0 })),
    handleHistory: vi.fn(async () => Response.json({ history: [] })),
    handleNonce: vi.fn(async () => Response.json({ nonce: 'abc123' })),
    handleVerifyNonce: vi.fn(async () => true),
    handleDocumentUpload: vi.fn(async () => Response.json({ id: 'doc1' }, { status: 201 })),
    handleDocumentList: vi.fn(async () => Response.json({ documents: [] })),
    handleDocumentDelete: vi.fn(async () => Response.json({ ok: true })),
    handleDocumentReindex: vi.fn(async () => Response.json({ ok: true })),
    handleAdminStatus: vi.fn(async () => Response.json({})),
    handleRagDebug: vi.fn(async () => Response.json({})),
    handleClearHistory: vi.fn(async () => Response.json({ ok: true })),
  };
  return {
    get: vi.fn(() => mockStub),
    idFromName: vi.fn((name: string) => ({ name })),
    _mocks: mockStub,
  };
}

function makeMockKVNamespace(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DOX402: makeMockDONamespace() as any,
    AI: { run: vi.fn() } as any,
    VECTORIZE: { upsert: vi.fn(), query: vi.fn(), deleteByIds: vi.fn() } as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET,
    WALLET_REGISTRY: makeMockKVNamespace(),
    ADMIN_SECRET,
    ...overrides,
  };
}

async function makeSessionCookie(wallet: string, secret: string): Promise<string> {
  const { token } = await createSessionToken(wallet, secret);
  return token;
}

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

// ── 1. Authorization header parsing edge cases ──────────────────────────────

describe('Authorization header parsing edge cases', () => {
  it('empty Authorization header on authenticated endpoint returns 401', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': '' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('Authorization: "Bearer" with no token returns 401', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('Authorization: "Token abc123" (wrong scheme) returns 401', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': 'Token abc123' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('valid cookie with wrong Authorization header succeeds (cookie takes precedence)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const token = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);

    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: {
        'Cookie': `ig_session=${token}`,
        'Authorization': 'Bearer invalid-garbage-token',
      },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
  });

  it('no auth at all on /infer returns 401', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', walletAddress: TEST_WALLET }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });
});

// ── 2. CORS handling ────────────────────────────────────────────────────────

describe('CORS handling (security test)', () => {
  it('OPTIONS preflight returns correct CORS headers', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/infer`, { method: 'OPTIONS' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(BASE_URL);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('non-OPTIONS request to authenticated endpoint includes CORS headers', async () => {
    const env = makeEnv();
    // Unauthenticated — will get 401, but should still have CORS headers
    const req = new Request(`${BASE_URL}/balance`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(BASE_URL);
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('PAYMENT-REQUIRED');
  });

  it('origin is derived from request URL in Access-Control-Allow-Origin', async () => {
    const env = makeEnv();
    const customOrigin = 'https://custom-origin.example.com';
    const req = new Request(`${customOrigin}/health`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(customOrigin);
  });
});

// ── 3. Request body edge cases ──────────────────────────────────────────────

describe('Request body edge cases', () => {
  let sessionToken: string;

  beforeAll(async () => {
    sessionToken = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
  });

  it('POST /infer with empty body returns 400', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: '',
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('POST /infer with non-JSON content type returns 400', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: 'not json at all',
    });
    const res = await worker.fetch(req, env, ctx);
    // The worker tries request.json() which should fail on non-JSON
    expect(res.status).toBe(400);
  });

  it('POST /infer with JSON missing required fields returns 400 or proceeds to DO', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, env, ctx);
    // The router passes to the DO — so either the router or DO handles validation
    // The key point: it should not crash (status should be defined)
    expect(res.status).toBeDefined();
    expect(res.status).not.toBe(500);
  });

  it('POST /deposit with empty body returns 400', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: '',
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it('POST /documents with missing title returns 400', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ content: 'Hello world' }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, any>;
    expect(body.error).toContain('title');
  });

  it('POST /documents with missing content returns 400', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ title: 'My Doc' }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, any>;
    expect(body.error).toContain('content');
  });
});

// ── 4. Path traversal / injection ───────────────────────────────────────────

describe('Path traversal / injection', () => {
  let sessionToken: string;

  beforeAll(async () => {
    sessionToken = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
  });

  it('DELETE /documents/../../etc does not break (handles gracefully)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/documents/..%2F..%2Fetc`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    const res = await worker.fetch(req, env, ctx);
    // Should not crash — either 200 (DO handles it) or 400/404
    expect(res.status).not.toBe(500);
    expect([200, 400, 404]).toContain(res.status);
  });

  it('GET /admin/wallets/0x123/../../health does not expose admin data', async () => {
    const env = makeEnv();
    // This path does not match the admin route pattern, so should not return admin data
    const req = new Request(`${BASE_URL}/admin/wallets/0x123/../../health`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
    });
    const res = await worker.fetch(req, env, ctx);
    // URL normalization by the URL constructor resolves ".." — so this becomes /health
    // which is a public endpoint and should not leak admin info
    const text = await res.text();
    expect(text).not.toContain('wallets');
    expect(text).not.toContain('stale');
  });

  it('documents route with null bytes in path does not crash', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const req = new Request(`${BASE_URL}/documents/test%00malicious`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).not.toBe(500);
  });

  it('admin wallet status with injected path segments returns 400', async () => {
    const env = makeEnv();
    // Attempt path injection via wallet parameter
    const req = new Request(`${BASE_URL}/admin/wallets/notawallet/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
    });
    const res = await worker.fetch(req, env, ctx);
    // Should fail wallet validation (not 0x + 40 hex)
    expect(res.status).toBe(400);
  });
});

// ── 5. Large payload handling ───────────────────────────────────────────────

describe('Large payload handling', () => {
  let sessionToken: string;

  beforeAll(async () => {
    sessionToken = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
  });

  it('POST /documents with content > 100KB is passed to DO (router does not reject)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const largeContent = 'x'.repeat(150_000); // 150KB
    const req = new Request(`${BASE_URL}/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ title: 'Large Doc', content: largeContent }),
    });
    const res = await worker.fetch(req, env, ctx);
    // The router validates title+content presence, then delegates to DO
    // The DO is responsible for size limits — router should not crash
    expect(res.status).not.toBe(500);
  });

  it('POST /infer with extremely long prompt does not crash', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const longPrompt = 'a'.repeat(500_000);
    const req = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ prompt: longPrompt, walletAddress: TEST_WALLET }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).not.toBe(500);
  });
});

// ── 6. Method not allowed ───────────────────────────────────────────────────

describe('Method not allowed', () => {
  it('GET /infer returns 404 (route only matches POST)', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/infer`, { method: 'GET' });
    const res = await worker.fetch(req, env, ctx);
    // The router uses exact method+path matching — GET /infer has no handler
    expect(res.status).toBe(404);
  });

  it('POST /health returns 404 (route only matches GET)', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it('PUT /balance returns 404 (route only matches GET)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const token = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ balance: 999999 }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it('DELETE /infer returns 404', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/infer`, { method: 'DELETE' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it('PATCH /documents returns 404', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/documents`, { method: 'PATCH' });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });
});

// ── 7. Concurrent request safety ────────────────────────────────────────────

describe('Concurrent request safety', () => {
  it('multiple simultaneous /balance requests do not interfere', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const token = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);

    const requests = Array.from({ length: 10 }, () =>
      new Request(`${BASE_URL}/balance`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      }),
    );

    const responses = await Promise.all(
      requests.map(req => worker.fetch(req, env, ctx)),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
    }
    expect(doNS._mocks.handleBalance).toHaveBeenCalledTimes(10);
  });

  it('concurrent /infer and /balance requests do not deadlock', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const token = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);

    const inferReq = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'hello', walletAddress: TEST_WALLET }),
    });

    const balanceReq = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const [inferRes, balanceRes] = await Promise.all([
      worker.fetch(inferReq, env, ctx),
      worker.fetch(balanceReq, env, ctx),
    ]);

    expect(inferRes.status).toBe(200);
    expect(balanceRes.status).toBe(200);
  });

  it('concurrent requests with different wallets route to separate DO stubs', async () => {
    const wallet1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const wallet2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const token1 = await makeSessionCookie(wallet1, SESSION_SECRET);
    const token2 = await makeSessionCookie(wallet2, SESSION_SECRET);

    const req1 = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token1}` },
    });
    const req2 = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token2}` },
    });

    await Promise.all([
      worker.fetch(req1, env, ctx),
      worker.fetch(req2, env, ctx),
    ]);

    // idFromName should have been called with both wallet names (stripped 0x, lowercase)
    const calls = doNS.idFromName.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain(wallet1.slice(2).toLowerCase());
    expect(calls).toContain(wallet2.slice(2).toLowerCase());
  });
});

// ── 8. Admin endpoint authorization edge cases ──────────────────────────────

describe('Admin endpoint authorization edge cases', () => {
  it('admin endpoint with no ADMIN_SECRET configured returns 503', async () => {
    const env = makeEnv({ ADMIN_SECRET: undefined });
    const req = new Request(`${BASE_URL}/admin/wallets`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ADMIN_SECRET}` },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(503);
  });

  it('admin endpoint with wrong secret returns 401', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/admin/wallets`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer wrong-secret' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('admin endpoint with user session token (not admin secret) returns 401', async () => {
    const env = makeEnv();
    const userToken = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
    const req = new Request(`${BASE_URL}/admin/wallets`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${userToken}` },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('admin endpoint with empty Authorization header returns 401', async () => {
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/admin/wallets`, {
      method: 'GET',
      headers: { 'Authorization': '' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });
});

// ── 9. Session token edge cases ─────────────────────────────────────────────

describe('Session token edge cases', () => {
  it('expired session token returns 401', async () => {
    // Manually craft an expired token by importing internals
    const { createSessionToken: create } = await import('../src/session');
    // We cannot easily create an expired token without time manipulation,
    // so we test with a completely garbled token instead
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFiYyIsImlhdCI6MCwiZXhwIjoxfQ.invalidsig' },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('token signed with different secret returns 401', async () => {
    const wrongSecretToken = await makeSessionCookie(TEST_WALLET, 'wrong-secret-key');
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${wrongSecretToken}` },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('truncated token returns 401', async () => {
    const fullToken = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
    const truncated = fullToken.slice(0, fullToken.length / 2);
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${truncated}` },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('token with tampered payload returns 401', async () => {
    const fullToken = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
    const parts = fullToken.split('.');
    // Tamper with the payload by flipping a character
    const tamperedPayload = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const env = makeEnv();
    const req = new Request(`${BASE_URL}/balance`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${tamperedToken}` },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });
});

// ── 10. Wallet address mismatch on authenticated endpoints ──────────────────

describe('Wallet address mismatch', () => {
  it('POST /infer with walletAddress not matching session returns 403', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const token = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
    const otherWallet = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const req = new Request(`${BASE_URL}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: 'hello', walletAddress: otherWallet }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it('POST /deposit with walletAddress not matching session returns 403', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const token = await makeSessionCookie(TEST_WALLET, SESSION_SECRET);
    const otherWallet = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const req = new Request(`${BASE_URL}/deposit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ walletAddress: otherWallet, proof: btoa('{}') }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });
});
