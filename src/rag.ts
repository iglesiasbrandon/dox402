import type { Env } from './types';
import {
  MICRO_USDC_PER_NEURON,
  OVERHEAD_MICRO_USDC,
  TARGET_MARGIN,
  RAG_CHUNK_CHAR_SIZE,
  RAG_CHUNK_CHAR_OVERLAP,
  RAG_TOP_K,
  RAG_MIN_SCORE,
  RAG_EMBEDDING_MODEL,
  RAG_EMBEDDING_BATCH_SIZE,
  RAG_EMBEDDING_NEURON_RATE,
} from './constants';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single chunk produced by the recursive character text splitter. */
export interface TextChunk {
  index: number;
  text: string;
}

// ── R2 Document Storage ──────────────────────────────────────────────────────

/** Build the R2 key for a document's content: `documents/{wallet}/{docId}` */
export function r2DocKey(wallet: string, docId: string): string {
  return `documents/${wallet.toLowerCase()}/${docId}`;
}

/**
 * Store document content in R2. Returns true on success, false on failure.
 * Never throws — caller decides how to handle failure.
 */
export async function storeDocumentContent(
  env: Env, wallet: string, docId: string, content: string,
): Promise<boolean> {
  try {
    await env.RAG_STORAGE.put(r2DocKey(wallet, docId), content);
    return true;
  } catch (err) {
    console.error('[rag] R2 put failed for %s/%s:', wallet, docId, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Read document content from R2. Returns null if not found or on error.
 * Never throws — caller decides how to handle missing content.
 */
export async function getDocumentContent(
  env: Env, wallet: string, docId: string,
): Promise<string | null> {
  try {
    const obj = await env.RAG_STORAGE.get(r2DocKey(wallet, docId));
    if (!obj) return null;
    return await obj.text();
  } catch (err) {
    console.error('[rag] R2 get failed for %s/%s:', wallet, docId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Delete document content from R2. Logs errors but never throws.
 */
export async function deleteDocumentContent(
  env: Env, wallet: string, docId: string,
): Promise<void> {
  try {
    await env.RAG_STORAGE.delete(r2DocKey(wallet, docId));
  } catch (err) {
    console.error('[rag] R2 delete failed for %s/%s:', wallet, docId, err instanceof Error ? err.message : String(err));
  }
}

// ── Text Chunking ────────────────────────────────────────────────────────────

/** Ordered list of separators for the recursive character text splitter. */
const SEPARATORS = ['\n\n', '\n', '. ', ' '] as const;

/**
 * Split text on a given separator, preserving the separator at the end of each
 * segment (except the last) so sentence boundaries remain intact.
 */
function splitOn(text: string, sep: string): string[] {
  const parts = text.split(sep);
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    // Re-attach the separator to the end of every part except the last one
    result.push(i < parts.length - 1 ? parts[i] + sep : parts[i]);
  }
  return result;
}

/**
 * Recursively split a single piece of text until every segment fits within
 * RAG_CHUNK_CHAR_SIZE. Tries separators in order: paragraph → line → sentence → word.
 */
function recursiveSplit(text: string, sepIdx: number): string[] {
  if (text.length <= RAG_CHUNK_CHAR_SIZE || sepIdx >= SEPARATORS.length) {
    return [text];
  }

  const sep = SEPARATORS[sepIdx];
  const segments = splitOn(text, sep);
  const result: string[] = [];

  let buffer = '';
  for (const seg of segments) {
    if (buffer.length + seg.length <= RAG_CHUNK_CHAR_SIZE) {
      buffer += seg;
    } else {
      if (buffer.length > 0) {
        // If the accumulated buffer is still too large, recurse with next separator
        if (buffer.length > RAG_CHUNK_CHAR_SIZE) {
          result.push(...recursiveSplit(buffer, sepIdx + 1));
        } else {
          result.push(buffer);
        }
      }
      buffer = seg;
    }
  }
  if (buffer.length > 0) {
    if (buffer.length > RAG_CHUNK_CHAR_SIZE) {
      result.push(...recursiveSplit(buffer, sepIdx + 1));
    } else {
      result.push(buffer);
    }
  }

  return result;
}

/**
 * Recursive character text splitter with configurable overlap.
 *
 * Splits on paragraph breaks first, then line breaks, sentence boundaries, and
 * finally word boundaries. Applies `RAG_CHUNK_CHAR_OVERLAP` characters of
 * overlap between consecutive chunks to preserve context across boundaries.
 *
 * @param text - The source text to chunk
 * @returns An array of TextChunks with sequential indices starting at 0
 */
export function chunkText(text: string): TextChunk[] {
  const rawSegments = recursiveSplit(text, 0);

  // Apply overlap: prepend the last RAG_CHUNK_CHAR_OVERLAP chars from the
  // previous segment to the current segment
  const overlapped: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    if (i === 0) {
      overlapped.push(rawSegments[i]);
    } else {
      const prev = rawSegments[i - 1];
      const overlapStr = prev.slice(-RAG_CHUNK_CHAR_OVERLAP);
      overlapped.push(overlapStr + rawSegments[i]);
    }
  }

  // Trim whitespace and filter empty chunks
  const chunks: TextChunk[] = [];
  let idx = 0;
  for (const segment of overlapped) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      chunks.push({ index: idx, text: trimmed });
      idx++;
    }
  }

  return chunks;
}

// ── Embeddings ───────────────────────────────────────────────────────────────

/**
 * Generate embedding vectors for an array of texts using Workers AI.
 *
 * Texts are batched into groups of RAG_EMBEDDING_BATCH_SIZE (max 100) to stay
 * within the Workers AI per-call limit. Returns one 768-dimensional vector per
 * input text.
 *
 * @param env  - Workers environment bindings (requires env.AI)
 * @param texts - Array of text strings to embed
 * @returns Array of embedding vectors (number[][])
 */
export async function generateEmbeddings(env: Env, texts: string[]): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += RAG_EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + RAG_EMBEDDING_BATCH_SIZE);
    const resp = await env.AI.run(RAG_EMBEDDING_MODEL, { text: batch });
    const data = (resp as { shape: number[]; data: number[][] }).data;
    allEmbeddings.push(...data);
  }

  return allEmbeddings;
}

// ── Document Upsert ──────────────────────────────────────────────────────────

/** Max vectors per Vectorize upsert call. */
const VECTORIZE_UPSERT_BATCH = 1000;

/**
 * Chunk a document, embed it, and upsert the vectors into Vectorize.
 *
 * Each vector ID follows the pattern `{documentId}:{chunkIndex}` so chunks can
 * be deterministically identified and deleted when a document is removed.
 *
 * @param env        - Workers environment bindings
 * @param wallet     - Wallet address owning the document (used as Vectorize filter)
 * @param documentId - Unique document identifier
 * @param text       - Full document text to chunk and embed
 * @returns Chunk metadata and the embedding cost in µUSDC
 */
export async function upsertDocument(
  env: Env,
  wallet: string,
  documentId: string,
  text: string,
): Promise<{ chunks: { id: string; index: number; text: string }[]; embeddingCost: number }> {
  const textChunks = chunkText(text);
  const chunkTexts = textChunks.map(c => c.text);
  const embeddings = await generateEmbeddings(env, chunkTexts);

  // Build Vectorize vector records
  const vectors = textChunks.map((chunk, i) => ({
    id: `${documentId}:${chunk.index}`,
    values: embeddings[i],
    metadata: {
      wallet,
      documentId,
      chunkIndex: chunk.index,
      text: chunk.text,
    },
  }));

  // Upsert in batches of 1000
  for (let i = 0; i < vectors.length; i += VECTORIZE_UPSERT_BATCH) {
    const batch = vectors.slice(i, i + VECTORIZE_UPSERT_BATCH);
    await env.VECTORIZE.upsert(batch);
  }

  const embeddingCost = computeEmbeddingCost(text.length);

  const chunks = textChunks.map((chunk) => ({
    id: `${documentId}:${chunk.index}`,
    index: chunk.index,
    text: chunk.text,
  }));

  return { chunks, embeddingCost };
}

// ── RAG Query ────────────────────────────────────────────────────────────────

/**
 * Query Vectorize for relevant document chunks and format them as a system
 * message for LLM context injection.
 *
 * Embeds the user prompt, queries Vectorize filtered by wallet, and assembles
 * matching chunks (above RAG_MIN_SCORE) into a system message bounded by
 * RAG_MAX_CONTEXT_CHARS.
 *
 * @param env    - Workers environment bindings
 * @param wallet - Wallet address to scope the vector search
 * @param prompt - User prompt to embed and query against
 * @returns System message with context, chunk count, and query cost — or null if no relevant chunks found
 */
export async function queryRagContext(
  env: Env,
  wallet: string,
  prompt: string,
  validDocIds?: Set<string>,
): Promise<{ systemMessage: string; chunkCount: number; queryCost: number } | null> {
  const [queryVector] = await generateEmbeddings(env, [prompt]);

  const result = await env.VECTORIZE.query(queryVector, {
    topK: RAG_TOP_K,
    returnMetadata: 'all',
    filter: { wallet: { $eq: wallet } },
  });

  // Filter by minimum similarity score
  const relevant = result.matches.filter(m => m.score >= RAG_MIN_SCORE);

  if (relevant.length === 0) {
    return null;
  }

  // Group chunks by documentId to avoid the LLM seeing each chunk as a separate file.
  // When validDocIds is provided, skip chunks from deleted documents (orphaned vectors).
  const docChunks = new Map<string, string[]>();
  for (const m of relevant) {
    const meta = m.metadata as Record<string, unknown>;
    const text = meta?.text as string;
    const docId = (meta?.documentId as string) || 'unknown';
    if (validDocIds && !validDocIds.has(docId)) continue;
    if (typeof text === 'string' && text.length > 0) {
      if (!docChunks.has(docId)) docChunks.set(docId, []);
      docChunks.get(docId)!.push(text);
    }
  }

  if (docChunks.size === 0) {
    return null;
  }

  const preamble =
    'You have access to the following reference documents provided by the user. ' +
    'Use them to inform your response if relevant, but do not mention them unless asked.';

  // Build one section per document (not per chunk)
  const sections: string[] = [];
  for (const [, chunks] of docChunks) {
    sections.push(chunks.join('\n'));
  }

  let systemMessage = preamble + '\n\n---\n' + sections.join('\n---\n') + '\n---';

  const queryCost = computeEmbeddingCost(prompt.length);

  return { systemMessage, chunkCount: docChunks.size, queryCost };
}

// ── Vector Deletion ──────────────────────────────────────────────────────────

/**
 * Delete document vectors from Vectorize by their chunk IDs.
 *
 * @param env      - Workers environment bindings
 * @param chunkIds - Array of vector IDs to delete (e.g. `["docId:0", "docId:1"]`)
 */
export async function deleteDocumentVectors(env: Env, chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) {
    return;
  }
  await env.VECTORIZE.deleteByIds(chunkIds);
}

// ── Cost Calculation ─────────────────────────────────────────────────────────

/**
 * Compute the embedding cost in µUSDC for a given character count.
 *
 * Uses the same margin-adjusted COGS formula as `computeCostMicroUSDC` in
 * billing.ts: `ceil(COGS / (1 − TARGET_MARGIN))` where COGS includes the raw
 * neuron cost plus fixed infrastructure overhead.
 *
 * @param charCount - Number of characters to embed (~4 chars per token)
 * @returns Cost in µUSDC (minimum 1)
 */
export function computeEmbeddingCost(charCount: number): number {
  const tokens = Math.ceil(charCount / 4);
  const neurons = (tokens * RAG_EMBEDDING_NEURON_RATE) / 1e6;
  const rawCost = neurons * MICRO_USDC_PER_NEURON;
  const cogs = rawCost + OVERHEAD_MICRO_USDC;
  return Math.max(1, Math.ceil(cogs / (1 - TARGET_MARGIN)));
}
