import { DurableObject } from 'cloudflare:workers';
import { build402Response, verifyProof } from './x402';
import { runInference } from './ai';
import { AI_MODEL, MAX_HISTORY_MESSAGES, MICRO_USDC_PER_NEURON, NEURON_RATES, PAYMENT_MICRO_USDC } from './constants';
import { ConversationMessage, DepositRequest, Env, InferRequest, PaymentProof } from './types';

// Parse SSE payload — returns assistant text and token usage if present
function parseSSE(sse: string): { text: string; usage: { prompt_tokens: number; completion_tokens: number } | null } {
  let text = '';
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const d = line.slice(6).trim();
    if (d === '[DONE]') break;
    try {
      const p = JSON.parse(d) as { response?: string; usage?: { prompt_tokens: number; completion_tokens: number } };
      if (p.response) text += p.response;
      if (p.usage) usage = p.usage;
    } catch { /* ignore malformed lines */ }
  }
  return { text, usage };
}

// Compute request cost in µUSDC from actual token usage.
// Workers AI often emits {prompt_tokens:0, completion_tokens:0} in production SSE,
// so when both are zero we fall back to character-count estimation (chars ÷ 4 ≈ tokens).
function computeCostMicroUSDC(
  usage: { prompt_tokens: number; completion_tokens: number } | null,
  model: string,
  fallback?: { inputChars: number; outputChars: number },
): number {
  const rates = NEURON_RATES[model] ?? NEURON_RATES[AI_MODEL];
  let promptTokens     = usage?.prompt_tokens     ?? 0;
  let completionTokens = usage?.completion_tokens ?? 0;
  // Use char-count fallback when token counts are unavailable
  if (promptTokens === 0 && completionTokens === 0 && fallback) {
    promptTokens     = Math.ceil(fallback.inputChars  / 4);
    completionTokens = Math.ceil(fallback.outputChars / 4);
  }
  if (promptTokens === 0 && completionTokens === 0) return 0;
  const neurons = (promptTokens * rates.in + completionTokens * rates.out) / 1e6;
  // Minimum 1 µUSDC per request — prevents free inference on very short inputs
  return Math.max(1, Math.ceil(neurons * MICRO_USDC_PER_NEURON));
}

export class Dox402 extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
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
    const check = await verifyProof(proof, body.walletAddress, this.env);
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
        console.error('[Dox402] AI inference failed:', msg);
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

    const check = await verifyProof(proof, body.walletAddress, this.env);
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

  private async handleNonce(): Promise<Response> {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    await this.ctx.storage.put('siwe:nonce', { nonce, createdAt: Date.now() });
    return Response.json({ nonce }, { headers: { 'Cache-Control': 'no-store' } });
  }

  async handleVerifyNonce(request: Request): Promise<Response> {
    let body: { nonce: string };
    try {
      body = await request.json<{ nonce: string }>();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const stored = await this.ctx.storage.get<{ nonce: string; createdAt: number }>('siwe:nonce');
    if (!stored || stored.nonce !== body.nonce) {
      return Response.json({ error: 'Invalid or expired nonce' }, { status: 401 });
    }
    // 5-minute nonce expiry
    if (Date.now() - stored.createdAt > 300_000) {
      await this.ctx.storage.delete('siwe:nonce');
      return Response.json({ error: 'Nonce expired' }, { status: 401 });
    }
    // One-time use — delete after verification
    await this.ctx.storage.delete('siwe:nonce');
    return Response.json({ valid: true });
  }
}
