import { AI_MODEL, ALLOWED_MODELS, MAX_TOKENS_LIMIT } from './constants';
import { ConversationMessage, Env } from './types';

export async function runInference(
  env: Env,
  messages: ConversationMessage[],
  maxTokens: number = 512,
  model?: string,
): Promise<ReadableStream> {
  // Only allow explicitly whitelisted model IDs; fall back to default if unknown or absent
  const selectedModel = (model && model in ALLOWED_MODELS) ? model : AI_MODEL;

  // Cap maxTokens to prevent unbounded compute consumption
  const clampedTokens = Math.max(1, Math.min(maxTokens, MAX_TOKENS_LIMIT));

  const response = await env.AI.run(
    selectedModel as Parameters<Ai['run']>[0],
    {
      messages: messages as AiTextGenerationInput['messages'],
      max_tokens: clampedTokens,
      stream: true,
    } as AiTextGenerationInput,
    {
      gateway: { id: 'dox402-gateway' },
    },
  );
  return response as unknown as ReadableStream;
}

/** Non-streaming inference — returns the complete response as a single object.
 *  Used when agents request `Accept: application/json` instead of SSE. */
export async function runInferenceSync(
  env: Env,
  messages: ConversationMessage[],
  maxTokens: number = 512,
  model?: string,
): Promise<{ response: string; usage?: { prompt_tokens: number; completion_tokens: number } }> {
  const selectedModel = (model && model in ALLOWED_MODELS) ? model : AI_MODEL;
  const clampedTokens = Math.max(1, Math.min(maxTokens, MAX_TOKENS_LIMIT));

  const result = await env.AI.run(
    selectedModel as Parameters<Ai['run']>[0],
    {
      messages: messages as AiTextGenerationInput['messages'],
      max_tokens: clampedTokens,
      stream: false,
    } as AiTextGenerationInput,
    {
      gateway: { id: 'dox402-gateway' },
    },
  );
  return result as unknown as { response: string; usage?: { prompt_tokens: number; completion_tokens: number } };
}
