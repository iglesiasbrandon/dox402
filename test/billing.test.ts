import { describe, it, expect } from 'vitest';
import { parseSSE, computeCostMicroUSDC, validateInferenceResult } from '../src/billing';
import { AI_MODEL, MICRO_USDC_PER_NEURON, NEURON_RATES, OVERHEAD_MICRO_USDC, TARGET_MARGIN } from '../src/constants';

// ── parseSSE ──────────────────────────────────────────────────────────────────

describe('parseSSE', () => {
  it('extracts text from multi-line SSE stream', () => {
    const sse = [
      'data: {"response":"Hello"}',
      'data: {"response":" world"}',
      'data: [DONE]',
    ].join('\n');
    const { text, usage } = parseSSE(sse);
    expect(text).toBe('Hello world');
    expect(usage).toBeNull();
  });

  it('extracts usage when present', () => {
    const sse = [
      'data: {"response":"Hi"}',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: [DONE]',
    ].join('\n');
    const { text, usage } = parseSSE(sse);
    expect(text).toBe('Hi');
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it('handles [DONE] — stops parsing after it', () => {
    const sse = [
      'data: {"response":"before"}',
      'data: [DONE]',
      'data: {"response":"after"}',
    ].join('\n');
    const { text } = parseSSE(sse);
    expect(text).toBe('before');
  });

  it('ignores malformed JSON lines', () => {
    const sse = [
      'data: {"response":"ok"}',
      'data: {broken json',
      'data: {"response":" fine"}',
      'data: [DONE]',
    ].join('\n');
    const { text } = parseSSE(sse);
    expect(text).toBe('ok fine');
  });

  it('ignores non-data lines', () => {
    const sse = [
      ': keepalive',
      'event: message',
      'data: {"response":"text"}',
      'data: [DONE]',
    ].join('\n');
    const { text } = parseSSE(sse);
    expect(text).toBe('text');
  });

  it('returns empty text and null usage for empty input', () => {
    const { text, usage } = parseSSE('');
    expect(text).toBe('');
    expect(usage).toBeNull();
  });

  it('returns empty text for DONE-only stream', () => {
    const { text } = parseSSE('data: [DONE]');
    expect(text).toBe('');
  });
});

// ── computeCostMicroUSDC ──────────────────────────────────────────────────────

describe('computeCostMicroUSDC', () => {
  it('computes cost from real token counts', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50 };
    const cost = computeCostMicroUSDC(usage, AI_MODEL);
    // Minimum non-zero cost is ceil((0 + OVERHEAD) / (1 - MARGIN)) = ceil(6/0.85) = 8
    expect(cost).toBeGreaterThanOrEqual(8);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('uses char-count fallback when tokens are zero', () => {
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const cost = computeCostMicroUSDC(usage, AI_MODEL, { inputChars: 400, outputChars: 200 });
    // 400/4=100 prompt tokens, 200/4=50 completion tokens — includes overhead + margin
    expect(cost).toBeGreaterThanOrEqual(8);
  });

  it('returns 0 when tokens are zero and no fallback', () => {
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const cost = computeCostMicroUSDC(usage, AI_MODEL);
    expect(cost).toBe(0);
  });

  it('returns 0 when usage is null and no fallback', () => {
    const cost = computeCostMicroUSDC(null, AI_MODEL);
    expect(cost).toBe(0);
  });

  it('enforces minimum cost per request (overhead + margin)', () => {
    // Very small input — minimum is ceil(OVERHEAD / (1 - MARGIN)) = ceil(6/0.85) = 8
    const usage = { prompt_tokens: 1, completion_tokens: 1 };
    const cost = computeCostMicroUSDC(usage, AI_MODEL);
    expect(cost).toBe(8);
  });

  it('falls back to default model rates for unknown model', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50 };
    const costUnknown = computeCostMicroUSDC(usage, '@cf/nonexistent/model');
    const costDefault = computeCostMicroUSDC(usage, AI_MODEL);
    expect(costUnknown).toBe(costDefault);
  });

  it('produces different costs for different models', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 500 };
    const costLlama8B = computeCostMicroUSDC(usage, '@cf/meta/llama-3.1-8b-instruct');
    const costDeepSeek = computeCostMicroUSDC(usage, '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');
    // DeepSeek has much higher output neuron rate, so should cost more
    expect(costDeepSeek).toBeGreaterThan(costLlama8B);
  });

  it('cost scales with token count', () => {
    const small = computeCostMicroUSDC({ prompt_tokens: 10, completion_tokens: 10 }, AI_MODEL);
    const large = computeCostMicroUSDC({ prompt_tokens: 1000, completion_tokens: 1000 }, AI_MODEL);
    expect(large).toBeGreaterThan(small);
  });

  it('applies overhead and margin to neuron cost', () => {
    // DeepSeek R1: 1500in, 2000out
    // neurons = (1500*45170 + 2000*443756)/1e6 = 955.267
    // rawCost = 955.267 * 0.011 = 10.508
    // cogs = 10.508 + 6 = 16.508
    // price = ceil(16.508 / 0.85) = ceil(19.42) = 20
    const usage = { prompt_tokens: 1500, completion_tokens: 2000 };
    const cost = computeCostMicroUSDC(usage, '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b');
    expect(cost).toBe(20);
  });

  it('achieves at least target margin on every model', () => {
    for (const [model, rates] of Object.entries(NEURON_RATES)) {
      const usage = { prompt_tokens: 500, completion_tokens: 300 };
      const cost = computeCostMicroUSDC(usage, model);
      const neurons = (500 * rates.in + 300 * rates.out) / 1e6;
      const cogs = neurons * MICRO_USDC_PER_NEURON + OVERHEAD_MICRO_USDC;
      const margin = (cost - cogs) / cost;
      expect(margin).toBeGreaterThanOrEqual(TARGET_MARGIN);
    }
  });
});

// ── validateInferenceResult ─────────────────────────────────────────────────

describe('validateInferenceResult', () => {
  it('accepts normal response with text', () => {
    const result = validateInferenceResult({ text: 'Hello, how can I help?', usage: null });
    expect(result.ok).toBe(true);
  });

  it('accepts response with text and usage', () => {
    const result = validateInferenceResult({
      text: 'Hello',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects empty text', () => {
    const result = validateInferenceResult({ text: '', usage: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_response');
  });

  it('rejects whitespace-only text', () => {
    const result = validateInferenceResult({ text: '   \n\t  ', usage: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_response');
  });

  it('rejects JSON error object', () => {
    const result = validateInferenceResult({
      text: '{"error":"Internal server error"}',
      usage: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ai_error');
  });

  it('rejects JSON error with model unavailable message', () => {
    const result = validateInferenceResult({
      text: '{"error":"model @cf/meta/llama-3.1-8b-instruct is currently unavailable"}',
      usage: null,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ai_error');
  });

  it('accepts normal text that happens to contain the word "error"', () => {
    const result = validateInferenceResult({
      text: 'A 404 error occurs when a page is not found. This is a common HTTP status code that web developers encounter.',
      usage: null,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects short text matching "internal server error" sentinel', () => {
    const result = validateInferenceResult({ text: 'Internal server error', usage: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ai_error_text');
  });

  it('rejects short text matching "service unavailable" sentinel', () => {
    const result = validateInferenceResult({ text: 'service unavailable', usage: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ai_error_text');
  });

  it('rejects short text matching "model not available" sentinel', () => {
    const result = validateInferenceResult({ text: 'Model not available', usage: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ai_error_text');
  });

  it('accepts long text that contains error sentinel (length > 100)', () => {
    const longText = 'When you encounter an "internal server error", it usually means ' +
      'the server encountered an unexpected condition. ' +
      'This can happen for various reasons including misconfiguration or resource exhaustion.';
    const result = validateInferenceResult({ text: longText, usage: null });
    expect(result.ok).toBe(true);
  });

  it('accepts legitimate short response like "Yes"', () => {
    const result = validateInferenceResult({ text: 'Yes', usage: null });
    expect(result.ok).toBe(true);
  });

  it('accepts legitimate short response like "42"', () => {
    const result = validateInferenceResult({ text: '42', usage: null });
    expect(result.ok).toBe(true);
  });

  it('rejects "rate limit exceeded" short text', () => {
    const result = validateInferenceResult({ text: 'rate limit exceeded', usage: null });
    expect(result.ok).toBe(false);
  });

  it('rejects "context length exceeded" short text', () => {
    const result = validateInferenceResult({ text: 'context length exceeded', usage: null });
    expect(result.ok).toBe(false);
  });
});
