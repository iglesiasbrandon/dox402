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
  );
  return response as unknown as ReadableStream;
}
