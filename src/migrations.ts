// SQL schema migrations for InferenceGate Durable Object storage.
// Each migration is a [version, applyFn] tuple. Migrations run in order
// inside blockConcurrencyWhile() on first activation after deploy.
//
// The `sql` parameter matches Cloudflare's ctx.storage.sql interface
// (synchronous exec with positional bindings).
//
// Migration functions may be sync or async. Async migrations (e.g. 003)
// are used when external I/O (like R2 writes) is required during migration.

import type { Env } from './types';
import { storeDocumentContent } from './rag';

export interface SqlExec {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): {
    toArray(): T[];
    one(): T;
  };
}

export type Migration = [
  version: string,
  up: (sql: SqlExec, env: Env, wallet: string) => void | Promise<void>,
];

export const MIGRATIONS: Migration[] = [
  ['001', (sql) => {
    // ── wallet_state: single-row table for scalar per-wallet counters ──
    sql.exec(`CREATE TABLE IF NOT EXISTS wallet_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      wallet_address TEXT NOT NULL DEFAULT '',
      balance INTEGER NOT NULL DEFAULT 0,
      total_deposited INTEGER NOT NULL DEFAULT 0,
      total_spent INTEGER NOT NULL DEFAULT 0,
      total_requests INTEGER NOT NULL DEFAULT 0,
      total_failed_requests INTEGER NOT NULL DEFAULT 0,
      provisional_balance INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    )`);
    // Seed the single row so UPDATE always has a target
    sql.exec(`INSERT OR IGNORE INTO wallet_state (id) VALUES (1)`);

    // ── seen_transactions: replay prevention (replaces seen:{txHash} KV) ──
    sql.exec(`CREATE TABLE IF NOT EXISTS seen_transactions (
      tx_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);

    // ── pending_verifications: grace mode (replaces pending:{txHash} KV) ──
    sql.exec(`CREATE TABLE IF NOT EXISTS pending_verifications (
      tx_hash TEXT PRIMARY KEY,
      proof_json TEXT NOT NULL,
      credited_amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      last_attempt_at INTEGER,
      last_error TEXT
    )`);

    // ── rate_limits: fixed-window counters (replaces rl:{windowStart} KV) ──
    sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
      window_start INTEGER PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )`);

    // ── nonces: SIWE nonce storage (replaces siwe:nonces JSON array) ──
    sql.exec(`CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`);

    // ── history: conversation messages (replaces history JSON array) ──
    sql.exec(`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      cost REAL,
      model TEXT,
      created_at INTEGER NOT NULL
    )`);
  }],

  // ── Migration 002: RAG document storage ──────────────────────────────────
  ['002', (sql) => {
    // ── documents: per-wallet document metadata + full text ──
    sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedding_cost INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);

    // ── document_chunks: maps Vectorize vector IDs back to parent document ──
    // Vectorize stores the embeddings + chunk text in metadata;
    // this table links chunk IDs to documents for cascade delete.
    sql.exec(`CREATE TABLE IF NOT EXISTS document_chunks (
      chunk_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )`);

    sql.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON document_chunks(document_id)`);
  }],

  // ── Migration 003: Move document content from SQLite to R2 ──────────────
  // This is an async migration: reads all document content from SQL, writes
  // each to R2 object storage, then drops the content columns. After this
  // migration, R2 is the sole source of truth for document text.
  ['003', async (sql, env, wallet) => {
    // Phase 1: Read all documents with content still in SQL
    const docs = sql.exec<{ id: string; content: string }>(
      "SELECT id, content FROM documents WHERE content IS NOT NULL AND content != ''",
    ).toArray();

    // Phase 2: Write each document's content to R2
    let migratedCount = 0;
    for (const doc of docs) {
      const ok = await storeDocumentContent(env, wallet, doc.id, doc.content);
      if (!ok) {
        // R2 write failed — abort migration so it retries on next activation
        throw new Error(`R2 migration failed: could not store document ${doc.id}`);
      }
      migratedCount++;
    }

    // Phase 3: Drop content columns (R2 is now source of truth)
    // SQLite doesn't support DROP COLUMN in older versions, but Cloudflare DO
    // SQLite uses a modern version that does support it.
    sql.exec('ALTER TABLE documents DROP COLUMN content');
    sql.exec('ALTER TABLE document_chunks DROP COLUMN chunk_text');

    if (migratedCount > 0) {
      console.log('[migrations] 003: Migrated %d documents from SQL to R2 for wallet %s', migratedCount, wallet);
    }
  }],
];
