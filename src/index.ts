import { InferenceGate } from './dox402';
import { Env, InferRequest, DepositRequest, DocumentUploadRequest, AdminWalletStatus, WalletRegistryEntry } from './types';
import { USDC_CONTRACT } from './constants';
import { verifySiweLogin } from './siwe';
import { createSessionToken, verifySessionToken, TOKEN_EXPIRY_SECS, buildSessionCookie, buildClearCookie, parseCookieToken } from './session';
import { parseSiwxHeader, verifySiwxPayload, buildSiwxExtension } from './siwx';
import { isAdmin, adminUnauthorized, adminDisabled } from './admin';

// Re-export the DO class so Cloudflare can find it
export { InferenceGate };

const WALLET_REGEX = /^0x[0-9a-fA-F]{40}$/;

// ── CORS ──────────────────────────────────────────────────────────────────

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE, SIGN-IN-WITH-X',
    'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, X-Session-Expires',
    'Access-Control-Max-Age': '86400',
  };
}

function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  for (const [k, v] of Object.entries(securityHeaders())) {
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

/** Get a typed DO stub for direct RPC calls (no HTTP fetch routing).
 *  locationHint: 'enam' co-locates new DOs near AWS us-east-1 where Base chain
 *  RPC providers (mainnet.base.org) are hosted, minimizing payment verification
 *  latency. Workers AI routing is location-independent so inference is unaffected.
 *  Note: hint only applies on first instantiation — existing DOs keep their location. */
function getTypedStub(env: Env, walletAddress: string) {
  const doName = walletAddress.slice(2).toLowerCase(); // strip 0x, lowercase
  const id = env.DOX402.idFromName(doName);
  return (env.DOX402 as DurableObjectNamespace<InferenceGate>).get(id, { locationHint: 'enam' });
}

function isSecureOrigin(url: URL): boolean {
  return url.protocol === 'https:';
}

// Extract verified wallet from Cookie (browser) or Authorization: Bearer (API)
async function extractAuthWallet(request: Request, env: Env): Promise<string | null> {
  // 1. Try HttpOnly cookie (browser clients)
  const cookieToken = parseCookieToken(request.headers.get('Cookie'));
  if (cookieToken) {
    const payload = await verifySessionToken(cookieToken, env.SESSION_SECRET);
    if (payload) return payload.sub;
  }
  // 2. Fall back to Authorization: Bearer (API clients)
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

  // Verify nonce via DO RPC (one-time use)
  const stub = getTypedStub(env, wallet);
  // Extract nonce from the SIWE message
  const nonceMatch = payload.message.match(/^Nonce: (.+)$/m);
  if (!nonceMatch) return null;

  const nonceRes = await stub.handleVerifyNonce(nonceMatch[1]);
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
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin), ...securityHeaders() } });
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
        minimumTokens:    1000,  // 0.001 USDC minimum top-up = 1,000 tokens
        tokensPerUSDC:    1_000_000,  // 1 USDC = 1,000,000 tokens
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // ── SIWE auth endpoints ──────────────────────────────────────────────

    // GET /auth/nonce?wallet= — generate a one-time nonce for SIWE signing
    if (url.pathname === '/auth/nonce' && request.method === 'GET') {
      const wallet = url.searchParams.get('wallet') ?? '';
      if (!WALLET_REGEX.test(wallet)) return invalidWallet();
      const stub = getTypedStub(env, wallet);
      return stub.handleNonce();
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

      // Verify nonce via DO RPC (one-time use, prevents replay)
      const stub = getTypedStub(env, wallet);
      const nonceRes = await stub.handleVerifyNonce(result.parsed.nonce);
      if (!nonceRes.ok) {
        const err = await nonceRes.json<{ error: string }>();
        return Response.json({ error: err.error || 'Nonce verification failed' }, { status: 401 });
      }

      // Issue session token — set as HttpOnly cookie, don't expose in body
      const { token, expiresAt } = await createSessionToken(wallet, env.SESSION_SECRET);
      const cookie = buildSessionCookie(token, TOKEN_EXPIRY_SECS, isSecureOrigin(url));
      return Response.json({ expiresAt }, {
        headers: { 'Cache-Control': 'no-store', 'Set-Cookie': cookie },
      });
    }

    // POST /auth/logout — clear session cookie
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const cookie = buildClearCookie(isSecureOrigin(url));
      return Response.json({ ok: true }, {
        headers: { 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
      });
    }

    // ── Admin endpoints ───────────────────────────────────────────────────

    // GET /admin/wallets — paginated wallet list from KV registry
    if (url.pathname === '/admin/wallets' && request.method === 'GET') {
      if (!env.ADMIN_SECRET) return adminDisabled();
      if (!isAdmin(request, env)) return adminUnauthorized();

      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 1000);
      const cursor = url.searchParams.get('cursor') ?? undefined;

      const list = await env.WALLET_REGISTRY.list({ limit, cursor });
      const wallets = list.keys.map(k => ({
        wallet: k.name,
        ...(k.metadata ? { metadata: k.metadata } : {}),
      }));

      return Response.json({
        wallets,
        cursor: list.list_complete ? null : list.cursor,
        hasMore: !list.list_complete,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // GET /admin/wallets/:wallet/status — detailed DO status for a specific wallet
    if (url.pathname.startsWith('/admin/wallets/') && url.pathname.endsWith('/status') && request.method === 'GET') {
      if (!env.ADMIN_SECRET) return adminDisabled();
      if (!isAdmin(request, env)) return adminUnauthorized();

      // Extract wallet from /admin/wallets/0x.../status
      const parts = url.pathname.split('/');
      const wallet = parts[3]; // ['', 'admin', 'wallets', '0x...', 'status']
      if (!wallet || !WALLET_REGEX.test(wallet)) return invalidWallet();

      const stub = getTypedStub(env, wallet);
      return stub.handleAdminStatus();
    }

    // GET /admin/stats — aggregate statistics (total registered wallets)
    if (url.pathname === '/admin/stats' && request.method === 'GET') {
      if (!env.ADMIN_SECRET) return adminDisabled();
      if (!isAdmin(request, env)) return adminUnauthorized();

      // Count all keys by iterating with cursor (KV has no native count API)
      let total = 0;
      let cursor: string | undefined;
      do {
        const list = await env.WALLET_REGISTRY.list({ limit: 1000, cursor });
        total += list.keys.length;
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);

      return Response.json({ totalWallets: total }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // GET /admin/stale — identify zero-balance inactive wallets
    if (url.pathname === '/admin/stale' && request.method === 'GET') {
      if (!env.ADMIN_SECRET) return adminDisabled();
      if (!isAdmin(request, env)) return adminUnauthorized();

      const inactiveDays = Math.max(parseInt(url.searchParams.get('inactive_days') ?? '30', 10) || 30, 1);
      const maxBalance = Math.max(parseInt(url.searchParams.get('max_balance') ?? '0', 10) || 0, 0);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
      const cutoffMs = Date.now() - inactiveDays * 86_400_000;

      // Collect all registered wallets from KV
      const allWallets: string[] = [];
      let kvCursor: string | undefined;
      do {
        const list = await env.WALLET_REGISTRY.list({ limit: 1000, cursor: kvCursor });
        for (const key of list.keys) allWallets.push(key.name);
        kvCursor = list.list_complete ? undefined : list.cursor;
      } while (kvCursor);

      // Fan-out to DOs in bounded batches to avoid overwhelming the runtime
      const BATCH_SIZE = 10;
      const stale: AdminWalletStatus[] = [];

      for (let i = 0; i < allWallets.length && stale.length < limit; i += BATCH_SIZE) {
        const batch = allWallets.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (w) => {
            const stub = getTypedStub(env, w);
            const res = await stub.handleAdminStatus();
            return res.json<AdminWalletStatus>();
          }),
        );

        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const status = result.value;
          if (
            status.balance <= maxBalance &&
            (status.lastUsedAt === null || status.lastUsedAt < cutoffMs)
          ) {
            stale.push(status);
            if (stale.length >= limit) break;
          }
        }
      }

      return Response.json({
        stale,
        count: stale.length,
        criteria: { inactiveDays, maxBalance, limit },
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // ── Authenticated endpoints ──────────────────────────────────────────

    // POST /deposit — top-up balance without inference
    if (url.pathname === '/deposit' && request.method === 'POST') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      // Peek at body to verify walletAddress matches token (prevents misuse)
      let body: DepositRequest;
      try {
        body = await request.json<DepositRequest>();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      if (body.walletAddress && body.walletAddress.toLowerCase() !== authWallet) {
        return Response.json({ error: 'walletAddress does not match authenticated session' }, { status: 403 });
      }

      // Also validate proof.from matches the session wallet to catch mismatches early
      try {
        const proof = JSON.parse(atob(body.proof)) as { from?: string };
        if (proof.from && proof.from.toLowerCase() !== authWallet) {
          return Response.json({
            error: `proof.from (${proof.from.toLowerCase()}) does not match session wallet (${authWallet})`,
          }, { status: 403 });
        }
      } catch {
        // Let the DO handle malformed proof errors
      }

      const stub = getTypedStub(env, authWallet);
      return stub.handleDeposit(body, url.hostname, authWallet);
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
        body = await request.json<InferRequest>();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (body.walletAddress && body.walletAddress.toLowerCase() !== authWallet) {
        return Response.json({ error: 'walletAddress does not match authenticated session' }, { status: 403 });
      }

      // Route to the authenticated wallet's DO via RPC
      const paymentSig = request.headers.get('PAYMENT-SIGNATURE');
      const stub = getTypedStub(env, authWallet);
      const doResponse = await stub.handleInfer(body, paymentSig, url.hostname, authWallet);

      // If 402 returned, augment with SIWX extension so clients can discover auth
      if (doResponse.status === 402) {
        return await augment402WithSiwx(doResponse, env, authWallet, url);
      }

      // If authenticated via SIWX, set session cookie + expiry header
      if (siwxSession) {
        const headers = new Headers(doResponse.headers);
        headers.set('Set-Cookie', buildSessionCookie(siwxSession.token, TOKEN_EXPIRY_SECS, isSecureOrigin(url)));
        headers.set('X-Session-Expires', String(siwxSession.expiresAt));
        return new Response(doResponse.body, { status: doResponse.status, headers });
      }

      return doResponse;
    }

    // GET /balance — credit balance lookup (wallet derived from token)
    if (url.pathname === '/balance' && request.method === 'GET') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getTypedStub(env, authWallet);
      return stub.handleBalance();
    }

    // GET /history — conversation history (wallet derived from token)
    if (url.pathname === '/history' && request.method === 'GET') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getTypedStub(env, authWallet);
      return stub.handleHistory();
    }

    // DELETE /history — clear conversation history (wallet derived from token)
    if (url.pathname === '/history' && request.method === 'DELETE') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getTypedStub(env, authWallet);
      return stub.handleClearHistory();
    }

    // POST /documents — upload a text document for RAG
    if (url.pathname === '/documents' && request.method === 'POST') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      let body: { title?: string; content?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      if (!body.title || !body.content) {
        return Response.json({ error: 'Missing title or content' }, { status: 400 });
      }

      const stub = getTypedStub(env, authWallet);
      return stub.handleDocumentUpload({ title: body.title, content: body.content }, authWallet);
    }

    // GET /documents — list uploaded documents
    if (url.pathname === '/documents' && request.method === 'GET') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getTypedStub(env, authWallet);
      return stub.handleDocumentList();
    }

    // GET /documents/debug — debug RAG pipeline (temporary)
    if (url.pathname === '/documents/debug' && request.method === 'GET') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const prompt = url.searchParams.get('prompt') || 'test query';
      const stub = getTypedStub(env, authWallet);
      return stub.handleRagDebug(prompt);
    }

    // POST /documents/reindex — re-upsert all document vectors (fixes metadata index issues)
    if (url.pathname === '/documents/reindex' && request.method === 'POST') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const stub = getTypedStub(env, authWallet);
      return stub.handleDocumentReindex();
    }

    // DELETE /documents/:id — delete a document and its embeddings
    if (url.pathname.startsWith('/documents/') && request.method === 'DELETE') {
      const authWallet = await extractAuthWallet(request, env);
      if (!authWallet) return unauthorized();

      const docId = url.pathname.slice('/documents/'.length);
      if (!docId) {
        return Response.json({ error: 'Missing document ID' }, { status: 400 });
      }

      const stub = getTypedStub(env, authWallet);
      return stub.handleDocumentDelete(docId);
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
    const stub = getTypedStub(env, wallet);
    const nonceRes = await stub.handleNonce();
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
