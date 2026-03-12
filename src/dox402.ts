import { DurableObject } from 'cloudflare:workers';
import { build402Response, verifyProof } from './x402';
import { runInference } from './ai';
import { AI_MODEL, MAX_HISTORY_MESSAGES, PAYMENT_MICRO_USDC, RATE_LIMIT_PER_MINUTE } from './constants';
import { parseSSE, computeCostMicroUSDC } from './billing';
import { ConversationMessage, DepositRequest, Env, InferRequest, PaymentProof, StoredNonce } from './types';

export class InferenceGate extends DurableObject<Env> {
  /** Wallet address set by the router via X-DO-Wallet header on each request */
  private wallet = '';

  /** Wallet address for the current request — set in fetch() from router header */
  private get walletAddress(): string {
    return this.wallet;
  }

  /** Fixed-window rate limit: RATE_LIMIT_PER_MINUTE requests per 60-second window */
  private async checkRateLimit(): Promise<Response | null> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 60);
    const key = `rl:${windowStart}`;

    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= RATE_LIMIT_PER_MINUTE) {
      return Response.json(
        { error: 'Rate limit exceeded — try again shortly' },
        { status: 429, headers: { 'Retry-After': String(60 - (now % 60)) } },
      );
    }

    await this.ctx.storage.put(key, count + 1);
    await this.ctx.storage.delete(`rl:${windowStart - 60}`);
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    // Router passes the authenticated wallet via header — guaranteed present
    const walletHeader = request.headers.get('X-DO-Wallet');
    if (walletHeader) this.wallet = walletHeader;

    const limited = await this.checkRateLimit();
    if (limited) return limited;

    const url = new URL(request.url);
    if (url.pathname === '/infer' && request.method === 'POST') {
      return this.handleInfer(request);
    }
    if (url.pathname === '/balance' && request.method === 'GET') {
      return this.handleBalance();
    }
    if (url.pathname === '/history' && request.method === 'GET') {
      return this.handleHistory();
    }
    if (url.pathname === '/history' && request.method === 'DELETE') {
      return this.handleClearHistory();
    }
    if (url.pathname === '/deposit' && request.method === 'POST') {
      return this.handleDeposit(request);
    }
    if (url.pathname === '/auth/nonce' && request.method === 'GET') {
      return this.handleNonce();
    }
    if (url.pathname === '/auth/verify-nonce' && request.method === 'POST') {
      return this.handleVerifyNonce(request);
    }
    return new Response('Not found', { status: 404 });
  }

  private async handleInfer(request: Request): Promise<Response> {
    // Step 1: Parse body
    let body: InferRequest;
    try {
      body = await request.json<InferRequest>();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Step 2: Load current µUSDC balance
    const balance = (await this.ctx.storage.get<number>('balance')) ?? 0;

    // Step 3: Check for PAYMENT-SIGNATURE header
    const proofHeader = request.headers.get('PAYMENT-SIGNATURE');

    // Step 4a: No proof and no balance → return 402
    if (!proofHeader && balance === 0) {
      return build402Response(this.env.PAYMENT_ADDRESS);
    }

    // Load conversation history
    const history = (await this.ctx.storage.get<ConversationMessage[]>('history')) ?? [];
    const messages: ConversationMessage[] = [...history, { role: 'user', content: body.prompt }];

    // Step 4b: No proof but has balance → run inference (cost deducted post-stream)
    if (!proofHeader) {
      return this.inferAndLog(body, balance, messages);
    }

    // Step 5: Parse the proof from the PAYMENT-SIGNATURE header
    let proof: PaymentProof;
    try {
      proof = JSON.parse(atob(proofHeader)) as PaymentProof;
    } catch {
      return new Response(JSON.stringify({ error: 'Malformed PAYMENT-SIGNATURE header' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Step 6: Tier 1 structural + Tier 2 on-chain verification
    const check = await verifyProof(proof, this.walletAddress, this.env);
    if (!check.valid) {
      return new Response(JSON.stringify({ error: check.reason }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Steps 7–8: Atomic transaction — replay check + balance top-up
    // Use actual on-chain transfer amount (verified by verifyProof); fall back to constant
    const creditAmount = check.amount ?? PAYMENT_MICRO_USDC;
    let newBalance = 0;
    try {
      await this.ctx.storage.transaction(async (txn) => {
        const seenKey = `seen:${proof.txHash}`;
        if (await txn.get(seenKey)) {
          throw new Error('txHash already used');
        }
        await txn.put(seenKey, Date.now());

        const current = (await txn.get<number>('balance')) ?? 0;
        newBalance = current + creditAmount; // add actual payment amount; cost deducted post-stream
        await txn.put('balance', newBalance);

        const deposited = (await txn.get<number>('totalDepositedMicroUSDC')) ?? 0;
        await txn.put('totalDepositedMicroUSDC', deposited + creditAmount);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'txHash already used') {
        return new Response(JSON.stringify({ error: 'txHash already used — replay prevented' }), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw err;
    }

    // Step 9: Run inference (balance deducted async after stream)
    return this.inferAndLog(body, newBalance, messages);
  }

  private async inferAndLog(body: InferRequest, balance: number, messages: ConversationMessage[]): Promise<Response> {
    // Run Workers AI inference (falls back to mock in local dev when AI binding is unavailable)
    let stream: ReadableStream;
    try {
      stream = await runInference(this.env, messages, body.maxTokens, body.model);
    } catch (err: unknown) {
      // If AI binding is missing (local dev), return a mock stream
      if (!this.env.AI) {
        const mock = `data: {"response":"[local-dev mock — deploy to Cloudflare for real inference]"}\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":12}}\n\ndata: [DONE]\n\n`;
        stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(mock)); c.close(); } });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[InferenceGate] AI inference failed:', msg);
        return Response.json(
          { error: `Inference failed: ${msg}` },
          { status: 502 },
        );
      }
    }

    // Tee the stream: pipe chunks to the client while accumulating SSE for billing + history
    const { readable: outStream, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const postStreamWork = (async () => {
      const writer = writable.getWriter();
      const reader = stream.getReader();
      let accumulated = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { await writer.close(); break; }
          accumulated += new TextDecoder().decode(value);
          await writer.write(value);
        }
      } catch (e) {
        await writer.abort(e as Error);
        throw e;
      }

      const { text: responseText, usage } = parseSSE(accumulated);

      // Compute char counts for fallback billing when Workers AI returns zero token counts
      const inputChars  = messages.reduce((sum, m) => sum + m.content.length, 0);
      const outputChars = responseText.length;

      // Deduct actual cost from balance (uses char-count fallback if token usage is zero)
      const cost = computeCostMicroUSDC(usage, body.model ?? AI_MODEL, { inputChars, outputChars });
      const newBalance = Math.max(0, balance - cost);
      const spent = (await this.ctx.storage.get<number>('totalSpentMicroUSDC')) ?? 0;
      await this.ctx.storage.put('balance', newBalance);
      await this.ctx.storage.put('totalSpentMicroUSDC', spent + cost);

      // Append user prompt + assistant reply to persistent history
      if (responseText) {
        const current = (await this.ctx.storage.get<ConversationMessage[]>('history')) ?? [];
        const updated = [
          ...current,
          { role: 'user' as const, content: body.prompt },
          { role: 'assistant' as const, content: responseText, meta: { cost, model: body.model ?? AI_MODEL } },
        ].slice(-MAX_HISTORY_MESSAGES);
        await this.ctx.storage.put('history', updated);
      }

      // Log usage
      await this.ctx.storage.put('lastUsedAt', Date.now());
      const requests = (await this.ctx.storage.get<number>('totalRequests')) ?? 0;
      await this.ctx.storage.put('totalRequests', requests + 1);
    })();

    this.ctx.waitUntil(postStreamWork);

    // Return streamed SSE response.
    // X-Balance is the pre-deduction balance; client refreshes via /balance after stream to get final value.
    return new Response(outStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'X-Balance': String(balance),
      },
    });
  }

  private async handleDeposit(request: Request): Promise<Response> {
    let body: DepositRequest;
    try {
      body = await request.json<DepositRequest>();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    let proof: PaymentProof;
    try {
      proof = JSON.parse(atob(body.proof)) as PaymentProof;
    } catch {
      return Response.json({ error: 'Malformed proof — expected base64-encoded JSON' }, { status: 400 });
    }

    // Skip signature check: deposit is already behind Bearer auth (router verified identity)
    // and on-chain receipt.from confirms the sender — proof signature adds no security value.
    const check = await verifyProof(proof, this.walletAddress, this.env, { skipSignature: true });
    if (!check.valid) {
      return Response.json({ error: check.reason }, { status: 402 });
    }

    // Credit the actual verified on-chain transfer amount
    const creditAmount = check.amount ?? PAYMENT_MICRO_USDC;
    let newBalance = 0;
    try {
      await this.ctx.storage.transaction(async (txn) => {
        const seenKey = `seen:${proof.txHash}`;
        if (await txn.get(seenKey)) throw new Error('txHash already used');
        await txn.put(seenKey, Date.now());

        const current  = (await txn.get<number>('balance'))                  ?? 0;
        const deposited = (await txn.get<number>('totalDepositedMicroUSDC')) ?? 0;
        newBalance = current + creditAmount;
        await txn.put('balance',                  newBalance);
        await txn.put('totalDepositedMicroUSDC',  deposited + creditAmount);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'txHash already used') {
        return Response.json({ error: 'txHash already used — replay prevented' }, { status: 402 });
      }
      throw err;
    }

    return Response.json(
      { ok: true, credited: creditAmount, balance: newBalance },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  private async handleBalance(): Promise<Response> {
    const [balance, totalDeposited, totalSpent, totalRequests] = await Promise.all([
      this.ctx.storage.get<number>('balance'),
      this.ctx.storage.get<number>('totalDepositedMicroUSDC'),
      this.ctx.storage.get<number>('totalSpentMicroUSDC'),
      this.ctx.storage.get<number>('totalRequests'),
    ]);
    return Response.json({
      balance:                  balance ?? 0,
      totalDepositedMicroUSDC:  totalDeposited ?? 0,
      totalSpentMicroUSDC:      totalSpent ?? 0,
      totalRequests:            totalRequests ?? 0,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  private async handleHistory(): Promise<Response> {
    const history = (await this.ctx.storage.get<ConversationMessage[]>('history')) ?? [];
    return new Response(
      JSON.stringify({ history }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  private async handleClearHistory(): Promise<Response> {
    await this.ctx.storage.delete('history');
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  // ── SIWE nonce management ──────────────────────────────────────────────────
  // Stores an array of up to MAX_NONCES valid nonces per wallet to support
  // concurrent login flows and prevent nonce-overwrite DoS attacks.

  private static readonly NONCE_EXPIRY_MS = 300_000; // 5 minutes
  private static readonly MAX_NONCES = 5;

  private async handleNonce(): Promise<Response> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();

    const existing = (await this.ctx.storage.get<StoredNonce[]>('siwe:nonces')) ?? [];
    // Prune expired nonces
    const valid = existing.filter(n => now - n.createdAt <= InferenceGate.NONCE_EXPIRY_MS);
    // Cap at MAX_NONCES - 1 to make room for the new one (drop oldest first)
    const trimmed = valid.length >= InferenceGate.MAX_NONCES
      ? valid.slice(-(InferenceGate.MAX_NONCES - 1))
      : valid;
    trimmed.push({ nonce, createdAt: now });
    await this.ctx.storage.put('siwe:nonces', trimmed);

    return Response.json({ nonce }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async handleVerifyNonce(request: Request): Promise<Response> {
    let body: { nonce: string };
    try {
      body = await request.json<{ nonce: string }>();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const nonces = (await this.ctx.storage.get<StoredNonce[]>('siwe:nonces')) ?? [];
    const idx = nonces.findIndex(n => n.nonce === body.nonce);
    if (idx === -1) {
      return Response.json({ error: 'Invalid or expired nonce' }, { status: 401 });
    }
    // Check 5-minute expiry
    if (Date.now() - nonces[idx].createdAt > InferenceGate.NONCE_EXPIRY_MS) {
      nonces.splice(idx, 1);
      await this.ctx.storage.put('siwe:nonces', nonces);
      return Response.json({ error: 'Nonce expired' }, { status: 401 });
    }
    // One-time use — remove from array after verification
    nonces.splice(idx, 1);
    await this.ctx.storage.put('siwe:nonces', nonces);
    return Response.json({ valid: true });
  }
}