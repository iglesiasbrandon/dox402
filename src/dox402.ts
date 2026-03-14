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
import { MIGRATIONS } from './migrations';

export class InferenceGate extends DurableObject<Env> {
  /** Wallet address — loaded once per activation via blockConcurrencyWhile() */
  private wallet = '';

  /** Shorthand for the DO SQL storage API */
  private get sql() { return this.ctx.storage.sql; }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.runMigrations();
      await this.migrateFromKV();
      const rows = this.sql.exec<{ wallet_address: string }>(
        'SELECT wallet_address FROM wallet_state WHERE id = 1',
      ).toArray();
      this.wallet = rows[0]?.wallet_address ?? '';
    });
  }

  // ── Schema migration infrastructure ────────────────────────────────────────

  /** Run unapplied SQL migrations in order (synchronous — all SQL) */
  private runMigrations(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const applied = new Set(
      this.sql.exec<{ version: string }>('SELECT version FROM _schema_migrations')
        .toArray().map(r => r.version),
    );
    for (const [version, up] of MIGRATIONS) {
      if (!applied.has(version)) {
        up(this.sql);
        this.sql.exec(
          'INSERT INTO _schema_migrations (version, applied_at) VALUES (?, ?)',
          version, Date.now(),
        );
      }
    }
  }

  /** One-time KV → SQL data migration for existing DO instances.
   *  Reads all KV data (async), writes to SQL (sync), then deletes KV keys. */
  private async migrateFromKV(): Promise<void> {
    // Already migrated if wallet_address is set in SQL
    const rows = this.sql.exec<{ wallet_address: string }>(
      'SELECT wallet_address FROM wallet_state WHERE id = 1',
    ).toArray();
    if (rows[0]?.wallet_address) return;

    // Check if there's any KV data to migrate
    const walletAddress = await this.ctx.storage.get<string>('walletAddress');
    if (!walletAddress) return; // fresh DO — no KV data

    // Migrate scalar wallet state
    const balance = (await this.ctx.storage.get<number>('balance')) ?? 0;
    const totalDeposited = (await this.ctx.storage.get<number>('totalDepositedMicroUSDC')) ?? 0;
    const totalSpent = (await this.ctx.storage.get<number>('totalSpentMicroUSDC')) ?? 0;
    const totalRequests = (await this.ctx.storage.get<number>('totalRequests')) ?? 0;
    const totalFailedRequests = (await this.ctx.storage.get<number>('totalFailedRequests')) ?? 0;
    const provisionalBalance = (await this.ctx.storage.get<number>('provisionalBalance')) ?? 0;
    const lastUsedAt = (await this.ctx.storage.get<number>('lastUsedAt')) ?? null;

    this.sql.exec(
      `UPDATE wallet_state SET wallet_address=?, balance=?, total_deposited=?,
       total_spent=?, total_requests=?, total_failed_requests=?,
       provisional_balance=?, last_used_at=? WHERE id = 1`,
      walletAddress, balance, totalDeposited, totalSpent,
      totalRequests, totalFailedRequests, provisionalBalance, lastUsedAt,
    );

    // Migrate seen:{txHash} keys
    const seenEntries = await this.ctx.storage.list({ prefix: 'seen:' });
    for (const [key, value] of seenEntries) {
      const txHash = key.slice('seen:'.length);
      this.sql.exec(
        'INSERT OR IGNORE INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
        txHash, value as number,
      );
    }

    // Migrate pending:{txHash} keys
    const pendingEntries = await this.ctx.storage.list({ prefix: 'pending:' });
    for (const [key, value] of pendingEntries) {
      const entry = value as PendingVerification;
      const txHash = key.slice('pending:'.length);
      this.sql.exec(
        `INSERT OR IGNORE INTO pending_verifications
         (tx_hash, proof_json, credited_amount, created_at, retry_count, status, last_attempt_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        txHash, JSON.stringify(entry.proof), entry.creditedAmount,
        entry.createdAt, entry.retryCount, entry.status,
        entry.lastAttemptAt ?? null, entry.lastError ?? null,
      );
    }

    // Migrate history JSON array
    const history = (await this.ctx.storage.get<ConversationMessage[]>('history')) ?? [];
    const now = Date.now();
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      this.sql.exec(
        'INSERT INTO history (role, content, cost, model, created_at) VALUES (?, ?, ?, ?, ?)',
        msg.role, msg.content,
        msg.meta?.cost ?? null, msg.meta?.model ?? null,
        now + i, // preserve ordering with incrementing timestamps
      );
    }

    // Migrate nonces
    const nonces = (await this.ctx.storage.get<StoredNonce[]>('siwe:nonces')) ?? [];
    for (const n of nonces) {
      this.sql.exec(
        'INSERT OR IGNORE INTO nonces (nonce, created_at) VALUES (?, ?)',
        n.nonce, n.createdAt,
      );
    }

    // Delete all KV keys
    const scalarKeys = [
      'walletAddress', 'balance', 'totalDepositedMicroUSDC', 'totalSpentMicroUSDC',
      'totalRequests', 'totalFailedRequests', 'provisionalBalance', 'history',
      'lastUsedAt', 'siwe:nonces', 'pendingTxHashes',
    ];
    for (const key of scalarKeys) await this.ctx.storage.delete(key);
    for (const key of seenEntries.keys()) await this.ctx.storage.delete(key);
    for (const key of pendingEntries.keys()) await this.ctx.storage.delete(key);
    const rlEntries = await this.ctx.storage.list({ prefix: 'rl:' });
    for (const key of rlEntries.keys()) await this.ctx.storage.delete(key);

    console.log('[dox402] KV → SQL migration complete for wallet %s', walletAddress);
  }

  /** Wallet address for the current context */
  private get walletAddress(): string {
    return this.wallet;
  }

  /** Fixed-window rate limit: RATE_LIMIT_PER_MINUTE requests per 60-second window */
  private checkRateLimit(): Response | null {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 60);

    // Read current count (before increment)
    const row = this.sql.exec<{ count: number }>(
      'SELECT count FROM rate_limits WHERE window_start = ?', windowStart,
    ).toArray()[0];
    const count = row?.count ?? 0;

    if (count >= RATE_LIMIT_PER_MINUTE) {
      return Response.json(
        { error: 'Rate limit exceeded — try again shortly' },
        { status: 429, headers: { 'Retry-After': String(60 - (now % 60)) } },
      );
    }

    // Atomic upsert: increment count for current window
    this.sql.exec(
      `INSERT INTO rate_limits (window_start, count) VALUES (?, 1)
       ON CONFLICT(window_start) DO UPDATE SET count = count + 1`,
      windowStart,
    );

    // Clean up old windows
    this.sql.exec('DELETE FROM rate_limits WHERE window_start < ?', windowStart);
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
      this.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', wallet);
    }

    const limited = this.checkRateLimit();
    if (limited) return limited;

    // Step 1: Load current µUSDC balance
    const walletRow = this.sql.exec<{ balance: number }>(
      'SELECT balance FROM wallet_state WHERE id = 1',
    ).toArray()[0]!;
    const balance = walletRow.balance;

    // Step 2: No proof and no balance → return 402
    if (!paymentSignature && balance === 0) {
      return build402Response(this.env.PAYMENT_ADDRESS);
    }

    // Load conversation history from SQL
    const historyRows = this.sql.exec<{ role: string; content: string }>(
      'SELECT role, content FROM history ORDER BY id',
    ).toArray();
    const messages: ConversationMessage[] = [
      ...historyRows.map(r => ({ role: r.role as 'user' | 'assistant', content: r.content })),
      { role: 'user', content: body.prompt },
    ];

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
      const canGrace = this.canActivateGraceMode(check.amount ?? PAYMENT_MICRO_USDC);
      if (!canGrace) {
        return new Response(JSON.stringify({
          error: 'RPC unavailable and provisional credit limit reached — please retry later',
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      isProvisional = true;
    }

    // Steps 7–8: Atomic transaction — replay check + balance top-up
    const creditAmount = check.amount ?? PAYMENT_MICRO_USDC;
    let newBalance = 0;
    try {
      this.ctx.storage.transactionSync(() => {
        const seen = this.sql.exec<{ tx_hash: string }>(
          'SELECT tx_hash FROM seen_transactions WHERE tx_hash = ?', proof.txHash,
        ).toArray();
        if (seen.length > 0) {
          throw new Error('txHash already used');
        }

        this.sql.exec(
          'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
          proof.txHash, Date.now(),
        );

        this.sql.exec(
          'UPDATE wallet_state SET balance = balance + ?, total_deposited = total_deposited + ? WHERE id = 1',
          creditAmount, creditAmount,
        );

        // Read back the new balance for use after the transaction
        const row = this.sql.exec<{ balance: number }>(
          'SELECT balance FROM wallet_state WHERE id = 1',
        ).toArray()[0]!;
        newBalance = row.balance;

        // Grace mode: store pending entry for async re-verification
        if (isProvisional && check.pendingProof) {
          this.sql.exec(
            `INSERT INTO pending_verifications
             (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
             VALUES (?, ?, ?, ?, 0, 'pending')`,
            proof.txHash, JSON.stringify(check.pendingProof), creditAmount, Date.now(),
          );

          this.sql.exec(
            'UPDATE wallet_state SET provisional_balance = provisional_balance + ? WHERE id = 1',
            creditAmount,
          );
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
        this.sql.exec(
          `UPDATE wallet_state SET last_used_at = ?,
           total_requests = total_requests + 1,
           total_failed_requests = total_failed_requests + 1
           WHERE id = 1`,
          Date.now(),
        );
        return; // no billing, no history
      }

      // Compute char counts for fallback billing when Workers AI returns zero token counts
      const inputChars  = messages.reduce((sum, m) => sum + m.content.length, 0);
      const outputChars = responseText.length;

      // Deduct actual cost from balance (uses char-count fallback if token usage is zero)
      const cost = computeCostMicroUSDC(usage, body.model ?? AI_MODEL, { inputChars, outputChars });
      this.sql.exec(
        `UPDATE wallet_state SET
         balance = MAX(0, balance - ?),
         total_spent = total_spent + ?,
         last_used_at = ?,
         total_requests = total_requests + 1
         WHERE id = 1`,
        cost, cost, Date.now(),
      );

      // Append user prompt + assistant reply to persistent history
      if (responseText) {
        const now = Date.now();
        this.sql.exec(
          'INSERT INTO history (role, content, cost, model, created_at) VALUES (?, ?, ?, ?, ?)',
          'user', body.prompt, null, null, now,
        );
        this.sql.exec(
          'INSERT INTO history (role, content, cost, model, created_at) VALUES (?, ?, ?, ?, ?)',
          'assistant', responseText, cost, body.model ?? AI_MODEL, now + 1,
        );
        // Trim to MAX_HISTORY_MESSAGES
        this.sql.exec(
          `DELETE FROM history WHERE id NOT IN (
            SELECT id FROM history ORDER BY id DESC LIMIT ?
          )`,
          MAX_HISTORY_MESSAGES,
        );
      }
    })();

    this.ctx.waitUntil(postStreamWork);

    // Return streamed SSE response.
    // Client refreshes via /balance after stream completes to get post-deduction value.
    return new Response(outStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        ...(provisional ? { 'X-Payment-Status': 'provisional' } : {}),
      },
    });
  }

  async handleDeposit(body: DepositRequest, hostname: string, wallet: string): Promise<Response> {
    // Persist wallet only on first-ever request (subsequent activations load via constructor)
    if (!this.wallet) {
      this.wallet = wallet;
      this.sql.exec('UPDATE wallet_state SET wallet_address = ? WHERE id = 1', wallet);
    }

    const limited = this.checkRateLimit();
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
      const canGrace = this.canActivateGraceMode(check.amount ?? PAYMENT_MICRO_USDC);
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
      this.ctx.storage.transactionSync(() => {
        const seen = this.sql.exec<{ tx_hash: string }>(
          'SELECT tx_hash FROM seen_transactions WHERE tx_hash = ?', proof.txHash,
        ).toArray();
        if (seen.length > 0) throw new Error('txHash already used');

        this.sql.exec(
          'INSERT INTO seen_transactions (tx_hash, created_at) VALUES (?, ?)',
          proof.txHash, Date.now(),
        );

        this.sql.exec(
          'UPDATE wallet_state SET balance = balance + ?, total_deposited = total_deposited + ? WHERE id = 1',
          creditAmount, creditAmount,
        );

        const row = this.sql.exec<{ balance: number }>(
          'SELECT balance FROM wallet_state WHERE id = 1',
        ).toArray()[0]!;
        newBalance = row.balance;

        // Grace mode: store pending entry for async re-verification
        if (isProvisional && check.pendingProof) {
          this.sql.exec(
            `INSERT INTO pending_verifications
             (tx_hash, proof_json, credited_amount, created_at, retry_count, status)
             VALUES (?, ?, ?, ?, 0, 'pending')`,
            proof.txHash, JSON.stringify(check.pendingProof), creditAmount, Date.now(),
          );

          this.sql.exec(
            'UPDATE wallet_state SET provisional_balance = provisional_balance + ? WHERE id = 1',
            creditAmount,
          );
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
    const limited = this.checkRateLimit();
    if (limited) return limited;

    const row = this.sql.exec<{
      balance: number;
      total_deposited: number;
      total_spent: number;
      total_requests: number;
      total_failed_requests: number;
      provisional_balance: number;
    }>(`SELECT balance, total_deposited, total_spent, total_requests,
        total_failed_requests, provisional_balance
        FROM wallet_state WHERE id = 1`).toArray()[0]!;

    return Response.json({
      balance:                  row.balance,
      totalDepositedMicroUSDC:  row.total_deposited,
      totalSpentMicroUSDC:      row.total_spent,
      totalRequests:            row.total_requests,
      totalFailedRequests:      row.total_failed_requests,
      provisionalMicroUSDC:     row.provisional_balance,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async handleHistory(): Promise<Response> {
    const limited = this.checkRateLimit();
    if (limited) return limited;

    const rows = this.sql.exec<{
      role: string; content: string; cost: number | null; model: string | null;
    }>('SELECT role, content, cost, model FROM history ORDER BY id').toArray();

    const history: ConversationMessage[] = rows.map(r => ({
      role: r.role as 'user' | 'assistant',
      content: r.content,
      ...(r.cost != null ? { meta: { cost: r.cost, model: r.model! } } : {}),
    }));

    return new Response(
      JSON.stringify({ history }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  async handleClearHistory(): Promise<Response> {
    const limited = this.checkRateLimit();
    if (limited) return limited;

    this.sql.exec('DELETE FROM history');
    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }

  // ── Grace mode: provisional credit helpers ─────────────────────────────────

  /** Check whether grace mode can be activated for the given amount */
  private canActivateGraceMode(amount: number): boolean {
    const row = this.sql.exec<{ provisional_balance: number }>(
      'SELECT provisional_balance FROM wallet_state WHERE id = 1',
    ).toArray()[0]!;
    if (row.provisional_balance + amount > GRACE_MAX_PROVISIONAL_MICRO_USDC) return false;

    const countRow = this.sql.exec<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pending_verifications WHERE status = 'pending'`,
    ).toArray()[0]!;
    if (countRow.cnt >= GRACE_MAX_PENDING) return false;

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

  /** Remove expired seen transactions and terminal pending entries from storage.
   *  Returns the number of unexpired seen transactions remaining. */
  private cleanupExpiredKeys(): number {
    const now = Date.now();

    // Delete expired replay-prevention entries
    this.sql.exec(
      'DELETE FROM seen_transactions WHERE ? - created_at > ?',
      now, SEEN_TX_RETENTION_MS,
    );

    // Delete terminal pending verification entries older than 24h
    this.sql.exec(
      `DELETE FROM pending_verifications WHERE status != 'pending' AND ? - created_at > ?`,
      now, PENDING_TX_RETENTION_MS,
    );

    // Count remaining seen entries
    const row = this.sql.exec<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM seen_transactions',
    ).toArray()[0]!;

    if (row.cnt === 0) {
      // Also clean up old rate limit windows while we're at it
      this.sql.exec('DELETE FROM rate_limits');
    }

    return row.cnt;
  }

  /** Clear provisional balance tracking for a resolved entry.
   *  If `reverseCredit` is true, also deducts the amount from the wallet balance. */
  private clearProvisionalCredit(amount: number, reverseCredit: boolean): void {
    this.sql.exec(
      'UPDATE wallet_state SET provisional_balance = MAX(0, provisional_balance - ?) WHERE id = 1',
      amount,
    );

    if (reverseCredit) {
      this.sql.exec(
        'UPDATE wallet_state SET balance = MAX(0, balance - ?) WHERE id = 1',
        amount,
      );
      const row = this.sql.exec<{ balance: number }>(
        'SELECT balance FROM wallet_state WHERE id = 1',
      ).toArray()[0]!;
      console.warn('[dox402] Reversed %d µUSDC from wallet %s (new balance: %d)',
        amount, this.walletAddress, row.balance);
    }
  }

  /** DO alarm handler — re-verification of provisionally credited payments + storage cleanup */
  async alarm(): Promise<void> {
    // Wallet is normally loaded by blockConcurrencyWhile() in constructor;
    // fallback for edge cases (e.g. test mocks where storage is populated after construction)
    if (!this.wallet) {
      const rows = this.sql.exec<{ wallet_address: string }>(
        'SELECT wallet_address FROM wallet_state WHERE id = 1',
      ).toArray();
      this.wallet = rows[0]?.wallet_address ?? '';
    }

    // ── Grace mode re-verification ────────────────────────────────────────────
    const pendingRows = this.sql.exec<{
      tx_hash: string;
      proof_json: string;
      credited_amount: number;
      retry_count: number;
    }>(`SELECT tx_hash, proof_json, credited_amount, retry_count
        FROM pending_verifications WHERE status = 'pending'`).toArray();

    let anyStillPending = false;
    let nextRetryMs = Infinity;

    for (const row of pendingRows) {
      const proof = JSON.parse(row.proof_json) as PaymentProof;

      // Attempt re-verification via RPC
      const result = await verifyProof(proof, this.walletAddress, this.env);

      const newRetryCount = row.retry_count + 1;
      const now = Date.now();

      if (result.valid && !result.provisional) {
        // RPC confirmed the transaction — mark as verified
        this.sql.exec(
          `UPDATE pending_verifications SET status = 'confirmed', retry_count = ?,
           last_attempt_at = ? WHERE tx_hash = ?`,
          newRetryCount, now, row.tx_hash,
        );
        this.clearProvisionalCredit(row.credited_amount, false);
        console.log('[dox402] Re-verification CONFIRMED tx %s, wallet %s', row.tx_hash, this.walletAddress);
        continue;
      }

      if (result.provisional) {
        // RPC still unreachable — schedule another retry
        if (newRetryCount >= GRACE_MAX_RETRIES) {
          this.sql.exec(
            `UPDATE pending_verifications SET status = 'expired', retry_count = ?,
             last_attempt_at = ?, last_error = ? WHERE tx_hash = ?`,
            newRetryCount, now, result.reason ?? null, row.tx_hash,
          );
          this.clearProvisionalCredit(row.credited_amount, false);
          console.error('[dox402] Re-verification EXPIRED after %d attempts for tx %s, wallet %s — keeping credit',
            newRetryCount, row.tx_hash, this.walletAddress);
          continue;
        }
        this.sql.exec(
          `UPDATE pending_verifications SET retry_count = ?,
           last_attempt_at = ?, last_error = ? WHERE tx_hash = ?`,
          newRetryCount, now, result.reason ?? null, row.tx_hash,
        );
        anyStillPending = true;
        // Exponential backoff: 30s * 2^(retryCount-1)
        const delay = GRACE_INITIAL_RETRY_MS * Math.pow(2, newRetryCount - 1);
        nextRetryMs = Math.min(nextRetryMs, delay);
        continue;
      }

      // RPC succeeded but verification FAILED (reverted, wrong sender, no transfer, etc.)
      // This is fraud or a mistake — reverse the provisional credit
      this.sql.exec(
        `UPDATE pending_verifications SET status = 'reversed', retry_count = ?,
         last_attempt_at = ?, last_error = ? WHERE tx_hash = ?`,
        newRetryCount, now, result.reason ?? null, row.tx_hash,
      );
      this.clearProvisionalCredit(row.credited_amount, true);
      console.error('[dox402] Re-verification REVERSED tx %s, wallet %s — reason: %s',
        row.tx_hash, this.walletAddress, result.reason);
    }

    // ── Storage cleanup — remove expired seen and terminal pending entries ─────
    const remainingSeenKeys = this.cleanupExpiredKeys();

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

  private static readonly NONCE_EXPIRY_MS = 300_000; // 5 minutes
  private static readonly MAX_NONCES = 5;

  async handleNonce(): Promise<Response> {
    const limited = this.checkRateLimit();
    if (limited) return limited;

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const now = Date.now();

    // Prune expired nonces
    this.sql.exec(
      'DELETE FROM nonces WHERE ? - created_at > ?',
      now, InferenceGate.NONCE_EXPIRY_MS,
    );

    // Insert new nonce
    this.sql.exec(
      'INSERT INTO nonces (nonce, created_at) VALUES (?, ?)',
      nonce, now,
    );

    // Cap at MAX_NONCES (delete oldest beyond limit)
    this.sql.exec(
      `DELETE FROM nonces WHERE rowid NOT IN (
        SELECT rowid FROM nonces ORDER BY created_at DESC LIMIT ?
      )`,
      InferenceGate.MAX_NONCES,
    );

    return Response.json({ nonce }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async handleVerifyNonce(nonce: string): Promise<Response> {
    const limited = this.checkRateLimit();
    if (limited) return limited;

    if (!nonce) {
      return Response.json({ error: 'Missing nonce' }, { status: 400 });
    }

    const row = this.sql.exec<{ created_at: number }>(
      'SELECT created_at FROM nonces WHERE nonce = ?', nonce,
    ).toArray()[0];

    if (!row) {
      return Response.json({ error: 'Invalid or expired nonce' }, { status: 401 });
    }

    // Check 5-minute expiry
    if (Date.now() - row.created_at > InferenceGate.NONCE_EXPIRY_MS) {
      this.sql.exec('DELETE FROM nonces WHERE nonce = ?', nonce);
      return Response.json({ error: 'Nonce expired' }, { status: 401 });
    }

    // One-time use — remove after verification
    this.sql.exec('DELETE FROM nonces WHERE nonce = ?', nonce);
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
