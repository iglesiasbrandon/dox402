import { describe, it, expect } from 'vitest';
import { chunkText, computeEmbeddingCost } from '../src/rag';
import {
  RAG_CHUNK_CHAR_SIZE,
  RAG_CHUNK_CHAR_OVERLAP,
  MICRO_USDC_PER_NEURON,
  OVERHEAD_MICRO_USDC,
  TARGET_MARGIN,
  RAG_EMBEDDING_NEURON_RATE,
} from '../src/constants';

// ── chunkText ────────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('returns empty array for empty text', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('returns empty array for whitespace-only text', () => {
    expect(chunkText('   \n\n   ')).toEqual([]);
  });

  it('returns single chunk for short text (< RAG_CHUNK_CHAR_SIZE)', () => {
    const text = 'Hello, world! This is a short document.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toBe(text);
  });

  it('returns single chunk whose length equals RAG_CHUNK_CHAR_SIZE exactly', () => {
    const text = 'x'.repeat(RAG_CHUNK_CHAR_SIZE);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toBe(text);
  });

  it('returns multiple chunks for text exceeding RAG_CHUNK_CHAR_SIZE', () => {
    // Build text well over the limit using words separated by spaces
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    expect(text.length).toBeGreaterThan(RAG_CHUNK_CHAR_SIZE);

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('produces chunks that do not exceed RAG_CHUNK_CHAR_SIZE + RAG_CHUNK_CHAR_OVERLAP', () => {
    // Each raw segment is at most RAG_CHUNK_CHAR_SIZE; overlap prepends up to
    // RAG_CHUNK_CHAR_OVERLAP characters, so the trimmed result should not
    // exceed their sum.
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`);
    const text = words.join(' ');

    const chunks = chunkText(text);
    const maxAllowed = RAG_CHUNK_CHAR_SIZE + RAG_CHUNK_CHAR_OVERLAP;
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxAllowed);
    }
  });

  // ── Splitting strategies ──────────────────────────────────────────────────

  it('splits on paragraph boundaries (\\n\\n)', () => {
    // Create two paragraphs, each under the chunk limit individually, but
    // combined they exceed it.
    const paraA = 'A'.repeat(1000);
    const paraB = 'B'.repeat(1000);
    const text = paraA + '\n\n' + paraB;
    expect(text.length).toBeGreaterThan(RAG_CHUNK_CHAR_SIZE);

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain the first paragraph
    expect(chunks[0].text).toContain('A'.repeat(100));
    // Second chunk should contain the second paragraph
    expect(chunks[chunks.length - 1].text).toContain('B'.repeat(100));
  });

  it('splits on sentence boundaries (". ") when no paragraph breaks exist', () => {
    // Create long text with sentences but no paragraph or line breaks
    const sentence = 'This is a moderately long sentence that takes up some space. ';
    const repetitions = Math.ceil((RAG_CHUNK_CHAR_SIZE * 2.5) / sentence.length);
    const text = sentence.repeat(repetitions).trim();
    expect(text.length).toBeGreaterThan(RAG_CHUNK_CHAR_SIZE * 2);

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);

    // Verify that each chunk (except possibly the last) ends on a sentence boundary
    // The raw segment (before overlap) should end with ". " since the splitter
    // preserves separators. We check the first chunk which has no overlap prefix.
    expect(chunks[0].text).toMatch(/\.\s*$/);
  });

  // ── Overlap ───────────────────────────────────────────────────────────────

  it('applies overlap between consecutive chunks', () => {
    // Generate deterministic text: numbered sentences of known length
    const sentences: string[] = [];
    for (let i = 0; i < 100; i++) {
      sentences.push(`Sentence number ${String(i).padStart(3, '0')} is part of the test document. `);
    }
    const text = sentences.join('');
    expect(text.length).toBeGreaterThan(RAG_CHUNK_CHAR_SIZE * 2);

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);

    // The end of chunk N should appear near the start of chunk N+1
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i].text.slice(-RAG_CHUNK_CHAR_OVERLAP);
      // The next chunk should start with (approximately) the overlap text
      expect(chunks[i + 1].text).toContain(tail.trim());
    }
  });

  it('overlap is approximately RAG_CHUNK_CHAR_OVERLAP characters', () => {
    // Use word-separated text to force splitting at word boundaries
    const words = Array.from({ length: 1000 }, (_, i) => `w${i}`);
    const text = words.join(' ');

    const chunks = chunkText(text);
    if (chunks.length < 2) return; // safety guard

    // Check that the second chunk starts with content from the end of the
    // first raw segment. The overlap is taken from the raw (pre-overlap)
    // previous segment's last RAG_CHUNK_CHAR_OVERLAP chars. We can verify
    // by checking the shared substring length is in the right ballpark.
    const firstChunkText = chunks[0].text;
    const secondChunkText = chunks[1].text;
    const tailOfFirst = firstChunkText.slice(-RAG_CHUNK_CHAR_OVERLAP);
    const overlapIndex = secondChunkText.indexOf(tailOfFirst.trim());
    // The overlap text should be found near the beginning of the second chunk
    expect(overlapIndex).toBeGreaterThanOrEqual(0);
    expect(overlapIndex).toBeLessThan(50); // found near the start
  });

  // ── Sequential indices ────────────────────────────────────────────────────

  it('assigns sequential indices starting at 0', () => {
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`);
    const text = words.join(' ');

    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });

  // ── Whitespace trimming ───────────────────────────────────────────────────

  it('trims leading and trailing whitespace from chunks', () => {
    const paraA = '  ' + 'A'.repeat(1000) + '  ';
    const paraB = '  ' + 'B'.repeat(1000) + '  ';
    const text = paraA + '\n\n' + paraB;

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(chunk.text.trim());
    }
  });

  it('does not produce empty chunks from whitespace-only segments', () => {
    // Create text where some paragraph-separated segments are whitespace
    const text = 'Content here.\n\n   \n\n   \n\nMore content here.';
    const chunks = chunkText(text);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    // Should have at most 2 chunks (the two content segments), possibly 1 if
    // they fit together
    expect(chunks.length).toBeLessThanOrEqual(2);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles text that is exactly one character', () => {
    const chunks = chunkText('a');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, text: 'a' });
  });

  it('handles text with only newlines', () => {
    const chunks = chunkText('\n\n\n\n');
    expect(chunks).toEqual([]);
  });

  it('preserves all content across chunks (no data loss)', () => {
    // For a known input, verify every sentence appears in at least one chunk
    const sentences: string[] = [];
    for (let i = 0; i < 80; i++) {
      sentences.push(`Unique sentence ${i}.`);
    }
    const text = sentences.join(' ');
    const chunks = chunkText(text);
    const combined = chunks.map(c => c.text).join(' ');

    for (const sentence of sentences) {
      expect(combined).toContain(sentence);
    }
  });
});

// ── computeEmbeddingCost ─────────────────────────────────────────────────────

describe('computeEmbeddingCost', () => {
  it('returns at least 1 uUSDC even for very small inputs', () => {
    expect(computeEmbeddingCost(1)).toBeGreaterThanOrEqual(1);
  });

  it('returns minimum (1 uUSDC) for zero characters', () => {
    // 0 chars -> 0 tokens -> 0 neurons -> rawCost=0 -> cogs=OVERHEAD
    // price = ceil(OVERHEAD / (1-MARGIN)) = ceil(6 / 0.85) = ceil(7.06) = 8
    // Still >= 1
    const cost = computeEmbeddingCost(0);
    expect(cost).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('returns an integer', () => {
    expect(Number.isInteger(computeEmbeddingCost(5000))).toBe(true);
    expect(Number.isInteger(computeEmbeddingCost(100))).toBe(true);
    expect(Number.isInteger(computeEmbeddingCost(0))).toBe(true);
  });

  it('scales with input size — larger inputs cost more', () => {
    const small = computeEmbeddingCost(100);
    const medium = computeEmbeddingCost(10_000);
    const large = computeEmbeddingCost(100_000);
    expect(medium).toBeGreaterThanOrEqual(small);
    expect(large).toBeGreaterThan(medium);
  });

  it('follows ceil(cogs / (1 - margin)) billing formula', () => {
    const charCount = 4000; // 1000 tokens
    const tokens = Math.ceil(charCount / 4);
    const neurons = (tokens * RAG_EMBEDDING_NEURON_RATE) / 1e6;
    const rawCost = neurons * MICRO_USDC_PER_NEURON;
    const cogs = rawCost + OVERHEAD_MICRO_USDC;
    const expected = Math.max(1, Math.ceil(cogs / (1 - TARGET_MARGIN)));

    expect(computeEmbeddingCost(charCount)).toBe(expected);
  });

  it('always includes overhead even for zero tokens', () => {
    const cost = computeEmbeddingCost(0);
    const minWithOverhead = Math.max(1, Math.ceil(OVERHEAD_MICRO_USDC / (1 - TARGET_MARGIN)));
    expect(cost).toBe(minWithOverhead);
  });

  it('achieves at least the target margin', () => {
    const charCount = 20_000;
    const cost = computeEmbeddingCost(charCount);
    const tokens = Math.ceil(charCount / 4);
    const neurons = (tokens * RAG_EMBEDDING_NEURON_RATE) / 1e6;
    const rawCost = neurons * MICRO_USDC_PER_NEURON;
    const cogs = rawCost + OVERHEAD_MICRO_USDC;
    const margin = (cost - cogs) / cost;
    expect(margin).toBeGreaterThanOrEqual(TARGET_MARGIN);
  });

  it('computes a reasonable cost for a typical document (~10000 chars)', () => {
    // 10000 chars => ~2500 tokens
    // neurons = (2500 * 6058) / 1e6 = 15.145
    // rawCost = 15.145 * 0.011 = 0.16660
    // cogs = 0.16660 + 6 = 6.16660
    // price = ceil(6.16660 / 0.85) = ceil(7.255) = 8
    const cost = computeEmbeddingCost(10_000);
    expect(cost).toBe(8);
  });

  it('computes correct cost for a very large document (100KB)', () => {
    const charCount = 102_400;
    const tokens = Math.ceil(charCount / 4);
    const neurons = (tokens * RAG_EMBEDDING_NEURON_RATE) / 1e6;
    const rawCost = neurons * MICRO_USDC_PER_NEURON;
    const cogs = rawCost + OVERHEAD_MICRO_USDC;
    const expected = Math.max(1, Math.ceil(cogs / (1 - TARGET_MARGIN)));

    expect(computeEmbeddingCost(charCount)).toBe(expected);
    // Sanity: a 100KB document should still be cheap in micro-USDC
    expect(expected).toBeLessThan(100);
  });
});
