import { InferenceGate } from './dox402';
import { Env, InferRequest, DepositRequest } from './types';
import { USDC_CONTRACT } from './constants';
import { verifySiweLogin } from './siwe';
import { createSessionToken, verifySessionToken } from './session';
import { parseSiwxHeader, verifySiwxPayload, buildSiwxExtension } from './siwx';

// Re-export the DO class so Cloudflare can find it
export { InferenceGate };

const WALLET_REGEX = /^0x[0-9a-fA-F]{40}$/;

// ── CORS ──────────────────────────────────────────────────────────────────

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE, SIGN-IN-WITH-X',
    'Access-Control-Expose-Headers': 'X-Balance, PAYMENT-REQUIRED',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function invalidWallet(): Response {
  return new Response(JSON.stringify({ error: 'Invalid wallet address format — expected 0x + 40 hex chars' }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(reason = 'Missing or invalid session token'): Response {
  return Response.json({ error: reason }, { status: 401 });
}

function getDoStub(env: Env, walletAddress: string): DurableObjectStub {
  const doName = walletAddress.slice(2).toLowerCase(); // strip 0x, lowercase
  const id = env.DOX402.idFromName(doName);
  return env.DOX402.get(id);
}

// Extract verified wallet from Authorization: Bearer <token>
async function extractAuthWallet(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const payload = await verifySessionToken(token, env.SESSION_SECRET);
  if (!payload) return null;
  return payload.sub; // lowercase 0x-prefixed wallet address
}

// Extract wallet from SIGN-IN-WITH-X header, verify nonce via DO, issue session token
async function extractSiwxWallet(
  request: Request, env: Env, url: URL,
): Promise<{ wallet: string; token: string; expiresAt: number } | null> {
  const siwxHeader = request.headers.get('SIGN-IN-WITH-X');
  if (!siwxHeader) return null;

  const payload = parseSiwxHeader(siwxHeader);
  if (!payload) return null;

  const result = verifySiwxPayload(payload, url.host);
  if (!result.valid) return null;

  const wallet = result.address.toLowerCase();
  if (!WALLET_REGEX.test(wallet)) return null;

  // Verify nonce via DO (one-time use)
  const stub = getDoStub(env, wallet);
  // Extract nonce from the SIWE message
  const nonceMatch = payload.message.match(/^Nonce: (.+)$/m);
  if (!nonceMatch) return null;

  const nonceRes = await stub.fetch(new Request(`${url.origin}/auth/verify-nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: nonceMatch[1] }),
  }));
  if (!nonceRes.ok) return null;

  // Issue session token with chain info
  const { token, expiresAt } = await createSessionToken(wallet, env.SESSION_SECRET, payload.chainId);
  return { wallet, token, expiresAt };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const response = await handleRequest(request, env, url);
    return withCors(response, origin);
  },
};

async function handleRequest(request: Request, env: Env, url: URL): Promise<Response> {
    // ── Public endpoints ─────────────────────────────────────────────────

    // GET /health — liveness probe
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /payment-info — payment address + network details for client top-up UI
    if (url.pathname === '/payment-info' && request.method === 'GET') {
      return Response.json({
        paymentAddress: env.PAYMENT_ADDRESS,
        network:        env.NETWORK,
        asset:          'USDC',
        usdcContract:   USDC_CONTRACT,
        minimumMicroUSDC: 1000,  // 0.001 USDC minimum top-up
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // ── SIWE auth endpoints ──────────────────────────────────────────────

    // GET /auth/nonce?wallet= — generate a one-time nonce for SIWE signing
    if (url.pathname === '/auth/nonce' && request.method === 'GET') {
      const wallet = url.searchParams.get('wallet') ?? '';
      if (!WALLET_REGEX.test(wallet)) return invalidWallet();
      const stub = getDoStub(env, wallet);
      return stub.fetch(new Request(`${url.origin}/auth/nonce`, { method: 'GET' }));
    }

    // POST /auth/login — verify signed SIWE message and issue session token
    if (url.pathname === '/auth/login' && request.method === 'POST') {
      let body: { message: string; signature: string };
      try {
        body = await request.json<{ message: string; signature: string }>();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      if (!body.message || !body.signature) {
        return Response.json({ error: 'Missing message or signature' }, { status: 400 });
      }

      // Verify SIWE signature and message structure
      const domain = url.host;
      const result = verifySiweLogin(body.message, body.signature, domain);
      if (!result.valid) {
        return Response.json({ error: result.reason }, { status: 401 });
      }

      const wallet = result.parsed.address.toLowerCase();
      if (!WALLET_REGEX.test(wallet)) return invalidWallet();

      // Verify nonce via DO (one-time use, prevents replay)
      const stub = getDoStub(env, wallet);
      const nonceRes = await stub.fetch(new Request(`${url.origin}/auth/verify-nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: result.parsed.nonce }),
      }));
      if (!nonceRes.ok) {
        const err = await nonceRes.json<{ error: string }>();
        return Response.json({ error: err.error || 'Nonce verification failed' }, { status: 401 });
      }

      // Issue session token
      const { token, expiresAt } = await createSessionToken(wallet, env.SESSION_SECRET);
      return Response.json({ token, expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // ── Authenticated endpoints ──────────────────────────────────────────

    // POST /deposit — top-up balance without inference
    if (url.pathname === '/deposit' && request.method === 'POST') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      // Peek at body to verify walletAddress matches token (prevents misuse)
      let body: DepositRequest;
      try {
        body = await request.clone().json<DepositRequest>();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      if (body.walletAddress && body.walletAddress.toLowerCase() !== authWallet) {
        return Response.json({ error: 'walletAddress does not match authenticated session' }, { status: 403 });
      }

      const stub = getDoStub(env, authWallet);
      return stub.fetch(request);
    }

    // POST /infer — pay-per-use inference
    if (url.pathname === '/infer' && request.method === 'POST') {
      // Try Bearer token first, then SIWX header
      let authWallet = await extractAuthWallet(request, env);
      let siwxSession: { token: string; expiresAt: number } | undefined;

      if (!authWallet) {
        const siwxResult = await extractSiwxWallet(request, env, url);
        if (siwxResult) {
          authWallet = siwxResult.wallet;
          siwxSession = { token: siwxResult.token, expiresAt: siwxResult.expiresAt };
        }
      }

      if (!authWallet) return unauthorized();

      // Peek at body to verify walletAddress matches token (prevents misuse)
      let body: InferRequest;
      try {
        body = await request.clone().json<InferRequest>();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (body.walletAddress && body.walletAddress.toLowerCase() !== authWallet) {
        return Response.json({ error: 'walletAddress does not match authenticated session' }, { status: 403 });
      }

      // Route to the authenticated wallet's DO
      const stub = getDoStub(env, authWallet);
      const doResponse = await stub.fetch(request);

      // If 402 returned, augment with SIWX extension so clients can discover auth
      if (doResponse.status === 402) {
        return await augment402WithSiwx(doResponse, env, authWallet, url);
      }

      // If authenticated via SIWX, include the session token in response headers
      if (siwxSession) {
        const headers = new Headers(doResponse.headers);
        headers.set('X-Session-Token', siwxSession.token);
        headers.set('X-Session-Expires', String(siwxSession.expiresAt));
        return new Response(doResponse.body, { status: doResponse.status, headers });
      }

      return doResponse;
    }

    // GET /balance — credit balance lookup (wallet derived from token)
    if (url.pathname === '/balance' && request.method === 'GET') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getDoStub(env, authWallet);
      return stub.fetch(new Request(`${url.origin}/balance`, { method: 'GET' }));
    }

    // GET /history — conversation history (wallet derived from token)
    if (url.pathname === '/history' && request.method === 'GET') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getDoStub(env, authWallet);
      return stub.fetch(new Request(`${url.origin}/history`, { method: 'GET' }));
    }

    // DELETE /history — clear conversation history (wallet derived from token)
    if (url.pathname === '/history' && request.method === 'DELETE') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getDoStub(env, authWallet);
      return stub.fetch(new Request(`${url.origin}/history`, { method: 'DELETE' }));
    }

    return new Response('Not found', { status: 404 });
}

// ── SIWX 402 augmentation ────────────────────────────────────────────────────
// When the DO returns 402, fetch a nonce and attach the SIWX extension so
// x402-aware clients can discover how to authenticate.
async function augment402WithSiwx(
  doResponse: Response, env: Env, wallet: string, url: URL,
): Promise<Response> {
  try {
    const stub = getDoStub(env, wallet);
    const nonceRes = await stub.fetch(new Request(`${url.origin}/auth/nonce`, { method: 'GET' }));
    const { nonce } = await nonceRes.json<{ nonce: string }>();
    const extension = buildSiwxExtension(url.host, url.href, nonce);

    // Merge extension into the existing 402 body
    const originalBody = await doResponse.json<Record<string, unknown>>();
    originalBody.extensions = { 'sign-in-with-x': extension };
    const bodyJson = JSON.stringify(originalBody);

    const headers = new Headers(doResponse.headers);
    headers.set('PAYMENT-REQUIRED', btoa(bodyJson));

    return new Response(bodyJson, { status: 402, headers });
  } catch {
    // If augmentation fails, return the original 402 unmodified
    return doResponse;
  }
}
