import { describe, it, expect, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// Mock cloudflare:workers (imported transitively via dox402.ts)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import worker from '../src/index';
import { buildSiweMessage } from '../src/siwe';
import { createSessionToken, buildSessionCookie, TOKEN_EXPIRY_SECS, parseCookieToken } from '../src/session';
import type { Env } from '../src/types';

const SESSION_SECRET = 'test-secret-for-integration-tests';

function makeMockKVNamespace(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async (opts?: { limit?: number; cursor?: string }) => {
      const keys = Array.from(store.keys()).map(name => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    }),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null })),
  } as unknown as KVNamespace;
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DOX402: {} as any,
    AI: {} as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET,
    WALLET_REGISTRY: makeMockKVNamespace(),
    ...overrides,
  };
}

// ── Wallet + signing helpers ──────────────────────────────────────────────────

function generateWallet() {
  const privKey = secp256k1.utils.randomSecretKey();
  const pubKey = secp256k1.getPublicKey(privKey, false);
  const addrHash = keccak_256(pubKey.slice(1));
  const address = '0x' + Array.from(addrHash.slice(12)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { privKey, address };
}

function personalSign(message: string, privateKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix);
  prefixed.set(msgBytes, prefix.length);
  const hash = keccak_256(prefixed);

  const sig64 = secp256k1.sign(hash, privateKey, { prehash: false });
  const expectedPub = secp256k1.getPublicKey(privateKey, false);

  let recoveryBit = 0;
  for (const v of [0, 1]) {
    const sigObj = secp256k1.Signature.fromBytes(sig64).addRecoveryBit(v);
    const recovered = sigObj.recoverPublicKey(hash).toBytes(false);
    if (recovered.every((b: number, i: number) => b === expectedPub[i])) {
      recoveryBit = v;
      break;
    }
  }

  const hex = Array.from(sig64).map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hex + (recoveryBit + 27).toString(16).padStart(2, '0');
}

// Build a valid SIWX header value (base64-encoded JSON)
function buildSiwxHeaderValue(wallet: { privKey: Uint8Array; address: string }, domain: string, nonce: string) {
  const now = new Date();
  const message = buildSiweMessage({
    domain,
    address: wallet.address,
    statement: 'Sign in to dox402 to access your inference balance',
    uri: `https://${domain}/infer`,
    version: '1',
    chainId: 8453,
    nonce,
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 300_000).toISOString(),
  });
  const signature = personalSign(message, wallet.privKey);
  return btoa(JSON.stringify({
    message,
    signature,
    chainId: 'eip155:8453',
    type: 'eip191',
    address: wallet.address,
  }));
}

// Create a mock DO namespace that returns a stub with RPC methods
function makeMockDONamespace(opts?: {
  nonceValue?: string;
  verifyNonceOk?: boolean;
  inferResponse?: Response;
}) {
  const nonce = opts?.nonceValue ?? 'abcdef1234567890abcdef1234567890';
  const verifyOk = opts?.verifyNonceOk ?? true;
  const inferRes = opts?.inferResponse ?? Response.json({ response: 'hello from AI' });

  const handleNonce = vi.fn(async () => Response.json({ nonce }));
  const handleVerifyNonce = vi.fn(async (_nonce: string) => {
    if (verifyOk) return Response.json({ ok: true });
    return Response.json({ error: 'Invalid or expired nonce' }, { status: 401 });
  });
  const handleInfer = vi.fn(async () => inferRes);
  const handleDeposit = vi.fn(async () => Response.json({ ok: true, credited: 1000, balance: 1000 }));
  const handleBalance = vi.fn(async () => Response.json({ balance: 0 }));
  const handleHistory = vi.fn(async () => Response.json({ history: [] }));
  const handleClearHistory = vi.fn(async () => Response.json({ ok: true }));
  const handleDocumentUpload = vi.fn(async () => Response.json({ id: 'mock-doc-id', title: 'test', charCount: 100, chunkCount: 1, createdAt: Date.now(), embeddingCostTokens: 1 }, { status: 201 }));
  const handleDocumentList = vi.fn(async () => Response.json({ documents: [] }));
  const handleDocumentDelete = vi.fn(async () => Response.json({ ok: true, deletedChunks: 3 }));

  const stub = {
    handleNonce, handleVerifyNonce, handleInfer, handleDeposit,
    handleBalance, handleHistory, handleClearHistory,
    handleDocumentUpload, handleDocumentList, handleDocumentDelete,
  };

  return {
    idFromName: vi.fn(() => ({ toString: () => 'mock-do-id' })),
    get: vi.fn(() => stub),
    _mocks: stub,
  };
}

// ── CORS ──────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const req = new Request('https://dox402.example.com/infer', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('PAYMENT-SIGNATURE');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('OPTIONS on any path returns 204', async () => {
    const req = new Request('https://dox402.example.com/nonexistent', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
  });

  it('GET /health includes CORS headers', async () => {
    const req = new Request('https://dox402.example.com/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('PAYMENT-REQUIRED');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Session-Expires');
  });

  it('Access-Control-Allow-Origin reflects the request URL origin', async () => {
    const req = new Request('http://localhost:8787/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8787');
  });

  it('404 responses also include CORS headers', async () => {
    const req = new Request('https://dox402.example.com/nonexistent', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
  });

  it('preserves original response headers alongside CORS headers', async () => {
    const req = new Request('https://dox402.example.com/payment-info', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
  });

  it('SIGN-IN-WITH-X is in Access-Control-Allow-Headers', async () => {
    const req = new Request('https://dox402.example.com/infer', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('SIGN-IN-WITH-X');
  });
});

// ── Security Headers ──────────────────────────────────────────────────────────

describe('Security headers', () => {
  it('GET /health includes X-Content-Type-Options: nosniff', async () => {
    const req = new Request('https://dox402.example.com/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('GET /health includes X-Frame-Options: DENY', async () => {
    const req = new Request('https://dox402.example.com/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('GET /health includes Referrer-Policy', async () => {
    const req = new Request('https://dox402.example.com/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('OPTIONS preflight includes security headers', async () => {
    const req = new Request('https://dox402.example.com/infer', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('404 responses include security headers', async () => {
    const req = new Request('https://dox402.example.com/nonexistent', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('GET /payment-info includes security headers alongside Cache-Control', async () => {
    const req = new Request('https://dox402.example.com/payment-info', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

// ── SIWX Integration ──────────────────────────────────────────────────────────

describe('SIWX on /infer', () => {
  const domain = 'dox402.example.com';
  const nonce = 'abcdef1234567890abcdef1234567890';

  it('authenticates via SIGN-IN-WITH-X header when no Bearer token', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    const siwxHeader = buildSiwxHeaderValue(wallet, domain, nonce);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'SIGN-IN-WITH-X': siwxHeader },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    // Should include session cookie in Set-Cookie header
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('ig_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(res.headers.get('X-Session-Expires')).toBeTruthy();
  });

  it('returns session token that is valid JWT with chain claim', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    const siwxHeader = buildSiwxHeaderValue(wallet, domain, nonce);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'SIGN-IN-WITH-X': siwxHeader },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    // Extract token from Set-Cookie header
    const setCookie = res.headers.get('Set-Cookie')!;
    const token = parseCookieToken(setCookie)!;
    expect(token).toBeTruthy();
    // Verify the token is valid and contains chain
    const { verifySessionToken } = await import('../src/session');
    const payload = await verifySessionToken(token, SESSION_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(wallet.address.toLowerCase());
    expect(payload!.chain).toBe('eip155:8453');
  });

  it('rejects SIWX with invalid nonce (DO returns 401)', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace({ nonceValue: nonce, verifyNonceOk: false });
    const env = makeEnv({ DOX402: doNS as any });

    const siwxHeader = buildSiwxHeaderValue(wallet, domain, nonce);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'SIGN-IN-WITH-X': siwxHeader },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects SIWX with wrong domain', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    // Sign for evil.com but send to dox402.example.com
    const siwxHeader = buildSiwxHeaderValue(wallet, 'evil.com', nonce);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'SIGN-IN-WITH-X': siwxHeader },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects SIWX with malformed header value', async () => {
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'SIGN-IN-WITH-X': 'garbage!!!' },
      body: JSON.stringify({ prompt: 'hello', walletAddress: '0x1234567890abcdef1234567890abcdef12345678' }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('prefers Bearer token over SIWX header', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    // Create a valid Bearer token
    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);
    const siwxHeader = buildSiwxHeaderValue(wallet, domain, nonce);

    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'SIGN-IN-WITH-X': siwxHeader,
      },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    // When Bearer token is used, NO Set-Cookie header (SIWX path not taken)
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('rejects walletAddress mismatch with SIWX-authenticated wallet', async () => {
    const wallet = generateWallet();
    const otherWallet = generateWallet();
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    const siwxHeader = buildSiwxHeaderValue(wallet, domain, nonce);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'SIGN-IN-WITH-X': siwxHeader },
      body: JSON.stringify({ prompt: 'hello', walletAddress: otherWallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(403);
  });
});

// ── 402 SIWX Augmentation ────────────────────────────────────────────────────

describe('402 SIWX augmentation on /infer', () => {
  const domain = 'dox402.example.com';
  const nonce = 'abcdef1234567890abcdef1234567890';

  it('augments 402 response with SIWX extension', async () => {
    const wallet = generateWallet();
    // DO returns 402 for /infer (no balance)
    const do402Body = { error: 'insufficient balance', balance: 0 };
    const do402Response = new Response(JSON.stringify(do402Body), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });
    const doNS = makeMockDONamespace({ nonceValue: nonce, inferResponse: do402Response });
    const env = makeEnv({ DOX402: doNS as any });

    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(402);

    const body = await res.json() as Record<string, any>;
    expect(body.extensions).toBeDefined();
    expect(body.extensions['sign-in-with-x']).toBeDefined();
    expect(body.extensions['sign-in-with-x'].supportedChains).toHaveLength(1);
    expect(body.extensions['sign-in-with-x'].supportedChains[0].chainId).toBe('eip155:8453');
    expect(body.extensions['sign-in-with-x'].info.nonce).toBe(nonce);
    expect(body.extensions['sign-in-with-x'].info.domain).toBe(domain);
  });

  it('402 PAYMENT-REQUIRED header includes SIWX extension', async () => {
    const wallet = generateWallet();
    const do402Response = new Response(JSON.stringify({ error: 'insufficient balance' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });
    const doNS = makeMockDONamespace({ nonceValue: nonce, inferResponse: do402Response });
    const env = makeEnv({ DOX402: doNS as any });

    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);
    const req = new Request(`https://${domain}/infer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).toBeTruthy();
    const decoded = JSON.parse(atob(header!)) as Record<string, any>;
    expect(decoded.extensions['sign-in-with-x'].info.nonce).toBe(nonce);
  });
});

// ── Cookie-based Auth ──────────────────────────────────────────────────────

describe('Cookie-based authentication', () => {
  it('authenticates /balance via Cookie header', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);
    const req = new Request('https://dox402.example.com/balance', {
      method: 'GET',
      headers: { 'Cookie': `ig_session=${token}` },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
  });

  it('authenticates /infer via Cookie header', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);
    const req = new Request('https://dox402.example.com/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `ig_session=${token}` },
      body: JSON.stringify({ prompt: 'hello', walletAddress: wallet.address }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
  });

  it('rejects invalid cookie token with 401', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const req = new Request('https://dox402.example.com/balance', {
      method: 'GET',
      headers: { 'Cookie': 'ig_session=invalid.token.here' },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('prefers Cookie over Bearer token', async () => {
    const wallet1 = generateWallet();
    const wallet2 = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const { token: cookieToken } = await createSessionToken(wallet1.address, SESSION_SECRET);
    const { token: bearerToken } = await createSessionToken(wallet2.address, SESSION_SECRET);

    const req = new Request('https://dox402.example.com/balance', {
      method: 'GET',
      headers: {
        'Cookie': `ig_session=${cookieToken}`,
        'Authorization': `Bearer ${bearerToken}`,
      },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    // The DO stub should be accessed with wallet1's address (from cookie)
    const calledName = doNS.idFromName.mock.calls[0][0];
    expect(calledName).toBe(wallet1.address.slice(2).toLowerCase());
  });
});

// ── DO Location Hint ─────────────────────────────────────────────────────────

describe('DO location hint', () => {
  it('passes locationHint: enam when creating DO stubs', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);
    const req = new Request('https://dox402.example.com/balance', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    await worker.fetch(req, env);
    expect(doNS.get).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationHint: 'enam' }),
    );
  });
});

// ── Auth Login Cookie ───────────────────────────────────────────────────────

describe('/auth/login cookie', () => {
  const domain = 'dox402.example.com';

  it('sets HttpOnly session cookie on login', async () => {
    const wallet = generateWallet();
    const nonce = 'abcdef1234567890abcdef1234567890';
    const doNS = makeMockDONamespace({ nonceValue: nonce });
    const env = makeEnv({ DOX402: doNS as any });

    const now = new Date();
    const message = buildSiweMessage({
      domain,
      address: wallet.address,
      statement: 'Sign in to dox402 inference gateway',
      uri: `https://${domain}`,
      version: '1',
      chainId: 8453,
      nonce,
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + 300_000).toISOString(),
    });
    const signature = personalSign(message, wallet.privKey);

    const req = new Request(`https://${domain}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    // Check Set-Cookie header
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('ig_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/');

    // Response body should NOT contain token
    const body = await res.json() as Record<string, any>;
    expect(body.token).toBeUndefined();
    expect(body.expiresAt).toBeDefined();
  });
});

// ── Auth Logout ──────────────────────────────────────────────────────────────

describe('/auth/logout', () => {
  it('clears session cookie', async () => {
    const req = new Request('https://dox402.example.com/auth/logout', { method: 'POST' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('ig_session=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const body = await res.json() as Record<string, any>;
    expect(body.ok).toBe(true);
  });

  it('omits Secure flag on http', async () => {
    const req = new Request('http://localhost:8787/auth/logout', { method: 'POST' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);

    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).not.toContain('Secure');
  });
});

// ── Document routes ─────────────────────────────────────────────────────────

describe('Document routes (/documents)', () => {
  it('POST /documents requires auth and routes to DO', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);

    const req = new Request('https://dox402.example.com/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ title: 'My Doc', content: 'Hello world' }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(201);
    expect(doNS._mocks.handleDocumentUpload).toHaveBeenCalledOnce();
  });

  it('GET /documents requires auth and routes to DO', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);

    const req = new Request('https://dox402.example.com/documents', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(doNS._mocks.handleDocumentList).toHaveBeenCalledOnce();
  });

  it('DELETE /documents/:id requires auth and routes to DO', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);

    const req = new Request('https://dox402.example.com/documents/abc-123', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(doNS._mocks.handleDocumentDelete).toHaveBeenCalledWith('abc-123');
  });

  it('POST /documents rejects missing title (400)', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);

    const req = new Request('https://dox402.example.com/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: 'Hello world' }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    expect(doNS._mocks.handleDocumentUpload).not.toHaveBeenCalled();
  });

  it('POST /documents rejects missing content (400)', async () => {
    const wallet = generateWallet();
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });
    const { token } = await createSessionToken(wallet.address, SESSION_SECRET);

    const req = new Request('https://dox402.example.com/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ title: 'My Doc' }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('POST /documents rejects unauthenticated request (401)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const req = new Request('https://dox402.example.com/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Doc', content: 'Hello' }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('GET /documents rejects unauthenticated request (401)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const req = new Request('https://dox402.example.com/documents', { method: 'GET' });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('DELETE /documents/:id rejects unauthenticated request (401)', async () => {
    const doNS = makeMockDONamespace();
    const env = makeEnv({ DOX402: doNS as any });

    const req = new Request('https://dox402.example.com/documents/abc-123', { method: 'DELETE' });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });
});
