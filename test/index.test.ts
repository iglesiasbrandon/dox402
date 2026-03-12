import { describe, it, expect, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// Mock cloudflare:workers (imported transitively via dox402.ts)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import worker from '../src/index';
import { buildSiweMessage } from '../src/siwe';
import { createSessionToken } from '../src/session';
import type { Env } from '../src/types';

const SESSION_SECRET = 'test-secret-for-integration-tests';

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DOX402: {} as any,
    AI: {} as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET,
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

// Create a mock DO namespace that returns a stub handling nonce and verify-nonce
function makeMockDONamespace(opts?: {
  nonceValue?: string;
  verifyNonceOk?: boolean;
  inferResponse?: Response;
}) {
  const nonce = opts?.nonceValue ?? 'abcdef1234567890abcdef1234567890';
  const verifyOk = opts?.verifyNonceOk ?? true;
  const inferRes = opts?.inferResponse ?? Response.json({ response: 'hello from AI' });

  const stubFetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/auth/nonce' && request.method === 'GET') {
      return Response.json({ nonce });
    }
    if (url.pathname === '/auth/verify-nonce' && request.method === 'POST') {
      if (verifyOk) return Response.json({ ok: true });
      return Response.json({ error: 'Invalid or expired nonce' }, { status: 401 });
    }
    if (url.pathname === '/infer' && request.method === 'POST') {
      return inferRes;
    }
    return new Response('Not found', { status: 404 });
  });

  return {
    idFromName: vi.fn(() => ({ toString: () => 'mock-do-id' })),
    get: vi.fn(() => ({ fetch: stubFetch })),
    _stubFetch: stubFetch,
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
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Balance');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('PAYMENT-REQUIRED');
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
    // Should include session token in response headers
    expect(res.headers.get('X-Session-Token')).toBeTruthy();
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
    const token = res.headers.get('X-Session-Token')!;
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
    // When Bearer token is used, NO X-Session-Token header (SIWX path not taken)
    expect(res.headers.get('X-Session-Token')).toBeNull();
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
