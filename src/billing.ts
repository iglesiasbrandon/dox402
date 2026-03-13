import { AI_MODEL, MICRO_USDC_PER_NEURON, NEURON_RATES, OVERHEAD_MICRO_USDC, TARGET_MARGIN } from './constants';

// Parse SSE payload — returns assistant text and token usage if present
export function parseSSE(sse: string): { text: string; usage: { prompt_tokens: number; completion_tokens: number } | null } {
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
export function computeCostMicroUSDC(
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
  // Price = ceil(COGS / (1 − margin)) where COGS = raw neuron cost + infrastructure overhead
  const rawNeuronCost = neurons * MICRO_USDC_PER_NEURON;
  const cogs = rawNeuronCost + OVERHEAD_MICRO_USDC;
  return Math.max(1, Math.ceil(cogs / (1 - TARGET_MARGIN)));
}

// ── Inference result validation ─────────────────────────────────────────────
// Determines whether a parsed SSE response represents a successful inference.
// Returns { ok: false, reason } when the response should NOT be billed.

export interface InferenceValidation {
  ok: boolean;
  reason?: string;
}

const ERROR_SENTINELS = [
  'internal server error',
  'model not available',
  'service unavailable',
  'rate limit exceeded',
  'context length exceeded',
];

export function validateInferenceResult(
  result: { text: string; usage: { prompt_tokens: number; completion_tokens: number } | null },
): InferenceValidation {
  const { text } = result;

  // Case 1: Empty output — AI returned no content
  if (!text || text.trim().length === 0) {
    return { ok: false, reason: 'empty_response' };
  }

  // Case 2: Output is a JSON error object (e.g. {"error":"Internal server error"})
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return { ok: false, reason: `ai_error: ${parsed.error}` };
    }
  } catch { /* not JSON — normal text response */ }

  // Case 3: Short text matching known error sentinels
  const lower = text.trim().toLowerCase();
  if (text.trim().length < 100 && ERROR_SENTINELS.some(s => lower.includes(s))) {
    return { ok: false, reason: `ai_error_text: ${text.trim().slice(0, 80)}` };
  }

  return { ok: true };
}
