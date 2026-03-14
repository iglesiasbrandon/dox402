import { DurableObject } from 'cloudflare:workers';
import { build402Response, verifyProof } from './x402';
import { runInference } from './ai';
import {
  AI_MODEL, MAX_HISTORY_MESSAGES, PAYMENT_MICRO_USDC, RATE_LIMIT_PER_MINUTE,
  GRACE_MAX_PROVISIONAL_MICRO_USDC, GRACE_MAX_PENDING, GRACE_INITIAL_RETRY_MS, GRACE_MAX_RETRIES,
  SEEN_TX_RETENTION_MS, PENDING_TX_RETENTION_MS,
} from './constants';
import { parseSSE, computeCostMicroUSDC, validateInferenceResult } from './billing';
import { ConversationMessage, DepositRequest, Env, InferRequest, PaymentProof, PendingVerification, StoredNonce } from './types';

export class InferenceGate extends DurableObject<Env> {
  /** Wallet address — loaded once per activation via blockConcurrencyWhile() */
  private wallet = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.wallet = (await ctx.storage.get<string>('walletAddress')) ?? '';
    });
  }

  /** Wallet address for the current context */
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

  // ── Public RPC methods ────────────────────────────────────────────────────
  // Called directly by the Worker via typed stubs (no HTTP fetch / URL routing).
  // Each method handles its own rate limiting.

  async handleInfer(
    body: InferRequest,
    paymentSignature: string | null,
    hostname: string,
    wallet: string,
  ): Promise<Response> {
    // Persist wallet only on first-ever request (subsequent activations load via constructor)
    if (!this.wallet) {
      this.wallet = wallet;
      await this.ctx.storage.put('walletAddress', wallet);
    }

    const limited = await this.checkRateLimit();
    if (limited) return limited;

    // Step 1: Load current µUSDC balance
    const balance = (await this.ctx.storage.get<number>('balance')) ?? 0;

    // Step 2: No proof and no balance → return 402
    if (!paymentSignature && balance === 0) {
      return build402Response(this.env.PAYMENT_ADDRESS);
    }

    // Load conversation history
    const history = (await this.ctx.storage.get<ConversationMessage[]>('history')) ?? [];
    const messages: ConversationMessage[] = [...history, { role: 'user', content: body.prompt }];

    // Step 3: No proof but has balance → run inference (cost deducted post-stream)
    if (!paymentSignature) {
      return this.inferAndLog(body, balance, messages);
    }

    // Step 4: Parse the proof from the payment signature
    let proof: PaymentProof;
    try {
      proof = JSON.parse(atob(paymentSignature)) as PaymentProof;
    } catch {
      return new Response(JSON.stringify({ error: 'Malformed PAYMENT-SIGNATURE header' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Step 5: Tier 1 structural + Tier 2 on-chain verification
    const check = await verifyProof(proof, this.walletAddress, this.env, {
      hostname,
    });
    if (!check.valid) {
      return new Response(JSON.stringify({ error: check.reason }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Step 6b: Grace mode — provisional credit when RPC is unreachable
    let isProvisional = false;
    if (check.provisional) {
      const canGrace = await this.canActivateGraceMode(check.amount ?? PAYMENT_MICRO_USDC);
      if (!canGrace) {
        return new Response(JSON.stringify({
          error: 'RPC unavailable and provisional credit limit reached — please retry later',
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      isProvisional = true;
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

        // Grace mode: store pending entry for async re-verification
        if (isProvisional && check.pendingProof) {
          const pendingKey = `pending:${proof.txHash}`;
          await txn.put(pendingKey, {
            proof: check.pendingProof,
            creditedAmount: creditAmount,
            createdAt: Date.now(),
            retryCount: 0,
            status: 'pending',
          } satisfies PendingVerification);

          const hashes = (await txn.get<string[]>('pendingTxHashes')) ?? [];
          hashes.push(proof.txHash);
          await txn.put('pendingTxHashes', hashes);

          const provBal = (await txn.get<number>('provisionalBalance')) ?? 0;
          await txn.put('provisionalBalance', provBal + creditAmount);
        }
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

    // Ensure cleanup alarm fires after seen key retention period
    await this.ensureAlarm(SEEN_TX_RETENTION_MS);

    // Schedule alarm for async re-verification if provisional (shorter delay overrides cleanup alarm)
    if (isProvisional) {
      console.warn('[dox402] Grace mode activated for tx %s, wallet %s, amount %d µUSDC',
        proof.txHash, this.walletAddress, creditAmount);
      await this.ensureAlarm(GRACE_INITIAL_RETRY_MS);
    }

    // Step 9: Run inference (balance deducted async after stream)
    return this.inferAndLog(body, newBalance, messages, isProvisional);
  }

  private async inferAndLog(body: InferRequest, balance: number, messages: ConversationMessage[], provisional = false): Promise<Response> {
    // Run Workers AI inference (falls back to mock in local dev when AI binding is unavailable)
    let stream: ReadableStream;
    try {
      stream = await runInference(this.env, messages, body.maxTokens, body.model);
    } catch (err: unknown) {
      // If AI binding is missing (local dev), return a configurable mock stream
      if (!this.env.AI) {
        stream = buildMockStream(this.env.MOCK_AI_BEHAVIOR ?? 'success');
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
      let streamErrored = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { await writer.close(); break; }
          accumulated += new TextDecoder().decode(value);
          await writer.write(value);
        }
      } catch (e) {
        streamErrored = true;
        console.error('[InferenceGate] Stream read error:', e instanceof Error ? e.message : String(e));
        // Try to send a terminal error event to the client
        try {
          const errPayload = JSON.stringify({
            error: 'stream_error',
            detail: (e instanceof Error ? e.message : String(e)).slice(0, 200),
          });
          await writer.write(new TextEncoder().encode(`data: ${errPayload}\n\ndata: [DONE]\n\n`));
          await writer.close();
        } catch {
          try { await writer.abort(e as Error); } catch { /* ignore */ }
        }
      }

      const { text: responseText, usage } = parseSSE(accumulated);

      // Validate inference result before billing — skip charges on failed responses
      const validation = streamErrored
        ? { ok: false, reason: 'stream_error' }
        : validateInferenceResult({ text: responseText, usage });

      if (!validation.ok) {
        console.error(`[InferenceGate] Skipping billing: ${validation.reason}`);
        await this.ctx.storage.put('lastUsedAt', Date.now());
        const requests = (await this.ctx.storage.get<number>('totalRequests')) ?? 0;
        await this.ctx.storage.put('totalRequests', requests + 1);
        const failedRequests = (await this.ctx.storage.get<number>('totalFailedRequests')) ?? 0;
        await this.ctx.storage.put('totalFailedRequests', failedRequests + 1);
        return; // no billing, no history
      }

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
        ...(provisional ? { 'X-Payment-Status': 'provisional' } : {}),
      },
    });
  }

  async handleDeposit(body: DepositRequest, hostname: string, wallet: string): Promise<Response> {
    // Persist wallet only on first-ever request (subsequent activations load via constructor)
    if (!this.wallet) {
      this.wallet = wallet;
      await this.ctx.storage.put('walletAddress', wallet);
    }

    const limited = await this.checkRateLimit();
    if (limited) return limited;

    let proof: PaymentProof;
    try {
      proof = JSON.parse(atob(body.proof)) as PaymentProof;
    } catch {
      return Response.json({ error: 'Malformed proof — expected base64-encoded JSON' }, { status: 400 });
    }

    // Skip signature check: deposit is already behind Bearer auth (router verified identity)
    // and on-chain receipt.from confirms the sender — proof signature adds no security value.
    const check = await verifyProof(proof, this.walletAddress, this.env, {
      skipSignature: true,
      hostname,
    });
    if (!check.valid) {
      return Response.json({ error: check.reason }, { status: 402 });
    }

    // Grace mode — provisional credit when RPC is unreachable
    let isProvisional = false;
    if (check.provisional) {
      const canGrace = await this.canActivateGraceMode(check.amount ?? PAYMENT_MICRO_USDC);
      if (!canGrace) {
        return Response.json({
          error: 'RPC unavailable and provisional credit limit reached — please retry later',
        }, { status: 503 });
      }
      isProvisional = true;
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

        // Grace mode: store pending entry for async re-verification
        if (isProvisional && check.pendingProof) {
          const pendingKey = `pending:${proof.txHash}`;
          await txn.put(pendingKey, {
            proof: check.pendingProof,
            creditedAmount: creditAmount,
            createdAt: Date.now(),
            retryCount: 0,
            status: 'pending',
          } satisfies PendingVerification);

          const hashes = (await txn.get<string[]>('pendingTxHashes')) ?? [];
          hashes.push(proof.txHash);
          await txn.put('pendingTxHashes', hashes);

          const provBal = (await txn.get<number>('provisionalBalance')) ?? 0;
          await txn.put('provisionalBalance', provBal + creditAmount);
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'txHash already used') {
        return Response.json({ error: 'txHash already used — replay prevented' }, { status: 402 });
      }
      throw err;
    }

    // Ensure cleanup alarm fires after seen key retention period
    await this.ensureAlarm(SEEN_TX_RETENTION_MS);

    // Schedule alarm for async re-verification if provisional (shorter delay overrides cleanup alarm)
    if (isProvisional) {
      console.warn('[dox402] Grace mode activated for tx %s, wallet %s, amount %d µUSDC',
        proof.txHash, this.walletAddress, creditAmount);
      await this.ensureAlarm(GRACE_INITIAL_RETRY_MS);
    }

    return Response.json(
      { ok: true, credited: creditAmount, balance: newBalance, provisional: isProvisional },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  async handleBalance(): Promise<Response> {
    const limited = await this.checkRateLimit();
    if (limited) return limited;

    const [balance, totalDeposited, totalSpent, totalRequests, totalFailedRequests, provisionalBalance] = await Promise.all([
      this.ctx.storage.get<number>('balance'),
      this.ctx.storage.get<number>('totalDepositedMicroUSDC'),
      this.ctx.storage.get<number>('totalSpentMicroUSDC'),
      this.ctx.storage.get<number>('totalRequests'),
      this.ctx.storage.get<number>('totalFailedRequests'),
      this.ctx.storage.get<number>('provisionalBalance'),
    ]);
    return Response.json({
      balance:                  balance ?? 0,
      totalDepositedMicroUSDC:  totalDeposited ?? 0,
      totalSpentMicroUSDC:      totalSpent ?? 0,
      totalRequests:            totalRequests ?? 0,
      totalFailedRequests:      totalFailedRequests ?? 0,
      provisionalMicroUSDC:     provisionalBalance ?? 0,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async handleHistory(): Promise<Response> {
    const limited = await this.checkRateLimit();
    if (limited) return limited;

    const history = (await this.ctx.storage.get<ConversationMessage[]>('history')) ?? [];
    return new Response(
      JSON.stringify({ history }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  async handleClearHistory(): Promise<Response> {
    const limited = await this.checkRateLimit();
    if (limited) return limited;

    await this.ctx.storage.delete('history');
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  // ── Grace mode: provisional credit helpers ─────────────────────────────────

  /** Check whether grace mode can be activated for the given amount */
  private async canActivateGraceMode(amount: number): Promise<boolean> {
    const provBal = (await this.ctx.storage.get<number>('provisionalBalance')) ?? 0;
    if (provBal + amount > GRACE_MAX_PROVISIONAL_MICRO_USDC) return false;

    const hashes = (await this.ctx.storage.get<string[]>('pendingTxHashes')) ?? [];
    if (hashes.length >= GRACE_MAX_PENDING) return false;

    return true;
  }

  /** Schedule a DO alarm at `Date.now() + delayMs`, but only if no earlier alarm exists.
   *  Coordinates grace mode retries (short delay) with cleanup alarms (long delay). */
  private async ensureAlarm(delayMs: number): Promise<void> {
    const target = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing <= target) return; // earlier alarm already scheduled
    await this.ctx.storage.setAlarm(target);
  }

  /** Remove a pending entry from the tracking list */
  private async removePendingEntry(txHash: string): Promise<void> {
    const hashes = (await this.ctx.storage.get<string[]>('pendingTxHashes')) ?? [];
    const filtered = hashes.filter(h => h !== txHash);
    await this.ctx.storage.put('pendingTxHashes', filtered);
  }

  /** Remove expired seen:{txHash} and terminal pending:{txHash} keys from storage.
   *  Returns the number of unexpired seen: keys remaining. */
  private async cleanupExpiredKeys(): Promise<number> {
    const now = Date.now();
    const toDelete: string[] = [];

    // Clean up expired replay-prevention keys
    const seenEntries = await this.ctx.storage.list({ prefix: 'seen:' });
    let remainingSeenKeys = 0;
    for (const [key, value] of seenEntries) {
      if (now - (value as number) > SEEN_TX_RETENTION_MS) {
        toDelete.push(key);
      } else {
        remainingSeenKeys++;
      }
    }

    // Clean up terminal pending verification entries (confirmed/reversed/expired) older than 24h
    const pendingEntries = await this.ctx.storage.list({ prefix: 'pending:' });
    for (const [key, value] of pendingEntries) {
      const entry = value as PendingVerification;
      if (entry.status !== 'pending' && now - entry.createdAt > PENDING_TX_RETENTION_MS) {
        toDelete.push(key);
      }
    }

    if (toDelete.length > 0) {
      for (const key of toDelete) {
        await this.ctx.storage.delete(key);
      }
      console.log('[dox402] Cleaned up %d expired keys for wallet %s', toDelete.length, this.walletAddress);
    }

    return remainingSeenKeys;
  }

  /** Clear provisional balance tracking for a resolved entry.
   *  If `reverseCredit` is true, also deducts the amount from the wallet balance. */
  private async clearProvisionalCredit(txHash: string, amount: number, reverseCredit: boolean): Promise<void> {
    await this.removePendingEntry(txHash);

    const provBal = (await this.ctx.storage.get<number>('provisionalBalance')) ?? 0;
    await this.ctx.storage.put('provisionalBalance', Math.max(0, provBal - amount));

    if (reverseCredit) {
      const balance = (await this.ctx.storage.get<number>('balance')) ?? 0;
      const newBalance = Math.max(0, balance - amount);
      await this.ctx.storage.put('balance', newBalance);
      console.warn('[dox402] Reversed %d µUSDC from wallet %s (new balance: %d)',
        amount, this.walletAddress, newBalance);
    }
  }

  /** DO alarm handler — re-verification of provisionally credited payments + storage cleanup */
  async alarm(): Promise<void> {
    // Wallet is normally loaded by blockConcurrencyWhile() in constructor;
    // fallback for edge cases (e.g. test mocks where storage is populated after construction)
    if (!this.wallet) {
      this.wallet = (await this.ctx.storage.get<string>('walletAddress')) ?? '';
    }

    // ── Grace mode re-verification ────────────────────────────────────────────
    const hashes = (await this.ctx.storage.get<string[]>('pendingTxHashes')) ?? [];
    let anyStillPending = false;
    let nextRetryMs = Infinity;

    for (const txHash of [...hashes]) {
      const key = `pending:${txHash}`;
      const entry = await this.ctx.storage.get<PendingVerification>(key);
      if (!entry || entry.status !== 'pending') {
        await this.removePendingEntry(txHash);
        continue;
      }

      // Attempt re-verification via RPC
      const result = await verifyProof(entry.proof, this.walletAddress, this.env);

      entry.retryCount++;
      entry.lastAttemptAt = Date.now();

      if (result.valid && !result.provisional) {
        // RPC confirmed the transaction — mark as verified
        entry.status = 'confirmed';
        await this.ctx.storage.put(key, entry);
        await this.clearProvisionalCredit(txHash, entry.creditedAmount, false);
        console.log('[dox402] Re-verification CONFIRMED tx %s, wallet %s', txHash, this.walletAddress);
        continue;
      }

      if (result.provisional) {
        // RPC still unreachable — schedule another retry
        if (entry.retryCount >= GRACE_MAX_RETRIES) {
          entry.status = 'expired';
          entry.lastError = result.reason;
          await this.ctx.storage.put(key, entry);
          await this.clearProvisionalCredit(txHash, entry.creditedAmount, false);
          console.error('[dox402] Re-verification EXPIRED after %d attempts for tx %s, wallet %s — keeping credit',
            entry.retryCount, txHash, this.walletAddress);
          continue;
        }
        entry.lastError = result.reason;
        await this.ctx.storage.put(key, entry);
        anyStillPending = true;
        // Exponential backoff: 30s * 2^(retryCount-1)
        const delay = GRACE_INITIAL_RETRY_MS * Math.pow(2, entry.retryCount - 1);
        nextRetryMs = Math.min(nextRetryMs, delay);
        continue;
      }

      // RPC succeeded but verification FAILED (reverted, wrong sender, no transfer, etc.)
      // This is fraud or a mistake — reverse the provisional credit
      entry.status = 'reversed';
      entry.lastError = result.reason;
      await this.ctx.storage.put(key, entry);
      await this.clearProvisionalCredit(txHash, entry.creditedAmount, true);
      console.error('[dox402] Re-verification REVERSED tx %s, wallet %s — reason: %s',
        txHash, this.walletAddress, result.reason);
    }

    // ── Storage cleanup — remove expired seen: and terminal pending: keys ─────
    const remainingSeenKeys = await this.cleanupExpiredKeys();

    // ── Schedule next alarm ───────────────────────────────────────────────────
    if (anyStillPending && nextRetryMs < Infinity) {
      // Grace mode retry needed — short delay takes priority
      await this.ctx.storage.setAlarm(Date.now() + nextRetryMs);
    } else if (remainingSeenKeys > 0) {
      // No grace retries, but unexpired seen keys remain — schedule cleanup
      await this.ensureAlarm(SEEN_TX_RETENTION_MS);
    }
  }

  // ── SIWE nonce management ──────────────────────────────────────────────────
  // Stores an array of up to MAX_NONCES valid nonces per wallet to support
  // concurrent login flows and prevent nonce-overwrite DoS attacks.

  private static readonly NONCE_EXPIRY_MS = 300_000; // 5 minutes
  private static readonly MAX_NONCES = 5;

  async handleNonce(): Promise<Response> {
    const limited = await this.checkRateLimit();
    if (limited) return limited;

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

  async handleVerifyNonce(nonce: string): Promise<Response> {
    const limited = await this.checkRateLimit();
    if (limited) return limited;

    if (!nonce) {
      return Response.json({ error: 'Missing nonce' }, { status: 400 });
    }

    const nonces = (await this.ctx.storage.get<StoredNonce[]>('siwe:nonces')) ?? [];
    const idx = nonces.findIndex(n => n.nonce === nonce);
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

// ── Local dev mock stream builder ─────────────────────────────────────────────
// Controlled via MOCK_AI_BEHAVIOR env var: success | empty | error | stream_error
function buildMockStream(behavior: string): ReadableStream {
  const enc = (s: string) => new TextEncoder().encode(s);
  switch (behavior) {
    case 'empty':
      return new ReadableStream({ start(c) { c.enqueue(enc('data: [DONE]\n\n')); c.close(); } });
    case 'error':
      return new ReadableStream({
        start(c) {
          c.enqueue(enc('data: {"error":"Internal server error"}\n\ndata: [DONE]\n\n'));
          c.close();
        },
      });
    case 'stream_error':
      return new ReadableStream({
        start(c) {
          c.enqueue(enc('data: {"response":"Starting to respond..."}\n\n'));
          setTimeout(() => c.error(new Error('mock stream error')), 10);
        },
      });
    default: // 'success'
      return new ReadableStream({
        start(c) {
          c.enqueue(enc('data: {"response":"[local-dev mock — deploy to Cloudflare for real inference]"}\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":12}}\n\ndata: [DONE]\n\n'));
          c.close();
        },
      });
  }
}