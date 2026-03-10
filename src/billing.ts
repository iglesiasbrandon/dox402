import { AI_MODEL, MICRO_USDC_PER_NEURON, NEURON_RATES } from './constants';

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
  // Minimum 1 µUSDC per request — prevents free inference on very short inputs
  return Math.max(1, Math.ceil(neurons * MICRO_USDC_PER_NEURON));
}
