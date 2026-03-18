import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers (imported transitively)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import { r2DocKey, storeDocumentContent, getDocumentContent, deleteDocumentContent } from '../src/rag';
import type { Env } from '../src/types';

// ── r2DocKey isolation ──────────────────────────────────────────────────────

describe('r2DocKey — wallet namespace isolation', () => {
  it('includes wallet address in the key path', () => {
    const key = r2DocKey('0xABC123', 'doc-1');
    expect(key).toBe('documents/0xabc123/doc-1');
  });

  it('lowercases wallet address for consistent keys', () => {
    const upper = r2DocKey('0xABCDEF', 'doc-1');
    const lower = r2DocKey('0xabcdef', 'doc-1');
    expect(upper).toBe(lower);
  });

  it('different wallets produce different keys for the same docId', () => {
    const keyA = r2DocKey('0xWalletA', 'doc-1');
    const keyB = r2DocKey('0xWalletB', 'doc-1');
    expect(keyA).not.toBe(keyB);
  });

  it('same wallet with different docIds produce different keys', () => {
    const key1 = r2DocKey('0xWallet', 'doc-1');
    const key2 = r2DocKey('0xWallet', 'doc-2');
    expect(key1).not.toBe(key2);
  });

  it('prevents path traversal via wallet address', () => {
    // A malicious wallet like "../other-wallet" should still be namespaced
    const key = r2DocKey('../other-wallet', 'doc-1');
    expect(key).toBe('documents/../other-wallet/doc-1');
    // R2 treats keys as opaque strings — '../' has no special meaning
    // The key is still unique to whatever value was passed as wallet
  });

  it('rejects docId with path traversal characters', () => {
    expect(() => r2DocKey('0xWallet', '../../secret')).toThrow('Invalid document ID');
    expect(() => r2DocKey('0xWallet', 'doc\x00id')).toThrow('Invalid document ID');
    expect(() => r2DocKey('0xWallet', 'doc\\id')).toThrow('Invalid document ID');
  });
});

// ── R2 helper functions ─────────────────────────────────────────────────────

function makeMockR2Env(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const env = {
    RAG_STORAGE: {
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      get: vi.fn(async (key: string) => {
        const val = store.get(key);
        if (!val) return null;
        return { text: async () => val };
      }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    },
  } as unknown as Env;
  return { env, store };
}

describe('storeDocumentContent', () => {
  it('stores content at the correct wallet-namespaced key', async () => {
    const { env, store } = makeMockR2Env();
    const ok = await storeDocumentContent(env, '0xAlice', 'doc-1', 'Hello world');
    expect(ok).toBe(true);
    expect(store.get('documents/0xalice/doc-1')).toBe('Hello world');
  });

  it('returns false on R2 failure without throwing', async () => {
    const env = {
      RAG_STORAGE: {
        put: vi.fn(async () => { throw new Error('R2 unavailable'); }),
      },
    } as unknown as Env;
    const ok = await storeDocumentContent(env, '0xAlice', 'doc-1', 'content');
    expect(ok).toBe(false);
  });

  it('wallet A cannot overwrite wallet B content', async () => {
    const { env, store } = makeMockR2Env();
    await storeDocumentContent(env, '0xAlice', 'doc-1', 'Alice data');
    await storeDocumentContent(env, '0xBob', 'doc-1', 'Bob data');

    // Both exist independently
    expect(store.get('documents/0xalice/doc-1')).toBe('Alice data');
    expect(store.get('documents/0xbob/doc-1')).toBe('Bob data');
  });
});

describe('getDocumentContent', () => {
  it('reads content from the correct wallet-namespaced key', async () => {
    const { env, store } = makeMockR2Env();
    store.set('documents/0xalice/doc-1', 'secret Alice data');

    const content = await getDocumentContent(env, '0xAlice', 'doc-1');
    expect(content).toBe('secret Alice data');
  });

  it('returns null for a different wallet even with same docId', async () => {
    const { env, store } = makeMockR2Env();
    store.set('documents/0xalice/doc-1', 'Alice data');

    // Bob tries to read Alice's doc — gets null
    const content = await getDocumentContent(env, '0xBob', 'doc-1');
    expect(content).toBeNull();
  });

  it('returns null on R2 failure without throwing', async () => {
    const env = {
      RAG_STORAGE: {
        get: vi.fn(async () => { throw new Error('R2 unavailable'); }),
      },
    } as unknown as Env;
    const content = await getDocumentContent(env, '0xAlice', 'doc-1');
    expect(content).toBeNull();
  });

  it('returns null for non-existent document', async () => {
    const { env } = makeMockR2Env();
    const content = await getDocumentContent(env, '0xAlice', 'nonexistent');
    expect(content).toBeNull();
  });
});

describe('deleteDocumentContent', () => {
  it('deletes only the specified wallet/doc key', async () => {
    const { env, store } = makeMockR2Env();
    store.set('documents/0xalice/doc-1', 'Alice data');
    store.set('documents/0xbob/doc-1', 'Bob data');

    await deleteDocumentContent(env, '0xAlice', 'doc-1');

    expect(store.has('documents/0xalice/doc-1')).toBe(false);
    expect(store.get('documents/0xbob/doc-1')).toBe('Bob data'); // untouched
  });

  it('does not throw on R2 failure', async () => {
    const env = {
      RAG_STORAGE: {
        delete: vi.fn(async () => { throw new Error('R2 unavailable'); }),
      },
    } as unknown as Env;
    // Should not throw
    await expect(deleteDocumentContent(env, '0xAlice', 'doc-1')).resolves.toBeUndefined();
  });
});

// ── Cross-wallet isolation (integration-level) ─────────────────────────────

describe('R2 cross-wallet isolation', () => {
  it('complete lifecycle: store, read, delete — isolated per wallet', async () => {
    const { env } = makeMockR2Env();

    // Alice stores a document
    await storeDocumentContent(env, '0xAlice', 'doc-1', 'Alice secret');
    // Bob stores a document with the same ID
    await storeDocumentContent(env, '0xBob', 'doc-1', 'Bob secret');

    // Each can only read their own
    expect(await getDocumentContent(env, '0xAlice', 'doc-1')).toBe('Alice secret');
    expect(await getDocumentContent(env, '0xBob', 'doc-1')).toBe('Bob secret');

    // Deleting Alice's doesn't affect Bob's
    await deleteDocumentContent(env, '0xAlice', 'doc-1');
    expect(await getDocumentContent(env, '0xAlice', 'doc-1')).toBeNull();
    expect(await getDocumentContent(env, '0xBob', 'doc-1')).toBe('Bob secret');
  });

  it('wallet address case normalization prevents duplicate keys', async () => {
    const { env } = makeMockR2Env();

    // Store with mixed case
    await storeDocumentContent(env, '0xAbCdEf', 'doc-1', 'data');

    // Read with different case — should find the same content
    expect(await getDocumentContent(env, '0xABCDEF', 'doc-1')).toBe('data');
    expect(await getDocumentContent(env, '0xabcdef', 'doc-1')).toBe('data');
  });
});
