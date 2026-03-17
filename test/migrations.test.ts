import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { MIGRATIONS } from '../src/migrations';
import type { Env } from '../src/types';

const dummyEnv = {} as unknown as Env;
const dummyWallet = '0xtest';

function makeSql() {
  const db = new Database(':memory:');
  return {
    db,
    sql: {
      exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
        const stmt = db.prepare(query);
        const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
        if (isRead) {
          const rows = stmt.all(...bindings) as T[];
          return { toArray: () => rows, one: () => rows[0] };
        } else {
          stmt.run(...bindings);
          return { toArray: () => [] as T[], one: () => { throw new Error('No rows'); } };
        }
      },
    },
  };
}

function runMigration(version: string) {
  const { db, sql } = makeSql();
  const migration = MIGRATIONS.find(([v]) => v === version);
  if (!migration) throw new Error(`Migration ${version} not found`);
  migration[1](sql, dummyEnv, dummyWallet);
  return { db, sql };
}

/** Run migrations 001 and 002 only (sync, no R2 needed) */
function runSyncMigrations() {
  const { db, sql } = makeSql();
  for (const [version, up] of MIGRATIONS) {
    if (version === '003') break; // Skip async R2 migration
    up(sql, dummyEnv, dummyWallet);
  }
  return { db, sql };
}

/** Run all migrations including async 003 (needs mock R2 env) */
async function runAllMigrations(env?: Env) {
  const { db, sql } = makeSql();
  for (const [, up] of MIGRATIONS) {
    await up(sql, env ?? dummyEnv, dummyWallet);
  }
  return { db, sql };
}

function makeMockR2Env(): { env: Env; stored: Map<string, string> } {
  const stored = new Map<string, string>();
  const env = {
    RAG_STORAGE: {
      put: vi.fn(async (key: string, value: string) => { stored.set(key, value); }),
      get: vi.fn(async (key: string) => {
        const val = stored.get(key);
        if (!val) return null;
        return { text: async () => val };
      }),
      delete: vi.fn(async (key: string) => { stored.delete(key); }),
    },
  } as unknown as Env;
  return { env, stored };
}

function getColumns(db: InstanceType<typeof Database>, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
}

describe('Migration 001 - Schema validation', () => {
  it('wallet_state table exists with correct columns', () => {
    const { db } = runMigration('001');
    const cols = getColumns(db, 'wallet_state');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('balance');
    expect(colNames).toContain('total_deposited');
    expect(colNames).toContain('total_spent');
    expect(colNames).toContain('total_requests');
    expect(colNames).toContain('total_failed_requests');
    expect(colNames).toContain('provisional_balance');
    expect(colNames).toContain('last_used_at');
  });

  it('wallet_state has exactly 1 seeded row with id=1 and balance=0', () => {
    const { db } = runMigration('001');
    const rows = db.prepare('SELECT * FROM wallet_state').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].balance).toBe(0);
  });

  it('wallet_state CHECK constraint: only id=1 allowed', () => {
    const { db } = runMigration('001');
    expect(() => {
      db.prepare('INSERT INTO wallet_state (id, balance) VALUES (2, 100)').run();
    }).toThrow();
  });

  it('seen_transactions table exists with tx_hash, created_at columns', () => {
    const { db } = runMigration('001');
    const cols = getColumns(db, 'seen_transactions');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('tx_hash');
    expect(colNames).toContain('created_at');
  });

  it('pending_verifications table exists with all columns', () => {
    const { db } = runMigration('001');
    const cols = getColumns(db, 'pending_verifications');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        'tx_hash',
        'proof_json',
        'credited_amount',
        'created_at',
        'retry_count',
        'status',
        'last_attempt_at',
        'last_error',
      ]),
    );
  });

  it('rate_limits table exists', () => {
    const { db } = runMigration('001');
    const cols = getColumns(db, 'rate_limits');
    expect(cols.length).toBeGreaterThan(0);
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('window_start');
    expect(colNames).toContain('count');
  });

  it('nonces table exists', () => {
    const { db } = runMigration('001');
    const cols = getColumns(db, 'nonces');
    expect(cols.length).toBeGreaterThan(0);
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('nonce');
    expect(colNames).toContain('created_at');
  });

  it('history table exists with AUTOINCREMENT id', () => {
    const { db } = runMigration('001');
    const cols = getColumns(db, 'history');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('content');
    expect(colNames).toContain('cost');
    expect(colNames).toContain('model');
    expect(colNames).toContain('created_at');

    // AUTOINCREMENT tables are tracked in sqlite_sequence
    db.prepare(
      "INSERT INTO history (role, content, created_at) VALUES ('user', 'hello', 1000)",
    ).run();
    const seq = db
      .prepare("SELECT * FROM sqlite_sequence WHERE name = 'history'")
      .get() as Record<string, unknown> | undefined;
    expect(seq).toBeDefined();
  });

  it('history role CHECK constraint: only user or assistant allowed', () => {
    const { db } = runMigration('001');
    expect(() => {
      db.prepare(
        "INSERT INTO history (role, content, created_at) VALUES ('system', 'hi', 1000)",
      ).run();
    }).toThrow();
  });
});

describe('Migration 002 - Schema validation', () => {
  it('documents table exists with correct columns', () => {
    const { db } = runSyncMigrations();
    const cols = getColumns(db, 'documents');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'content',
        'char_count',
        'chunk_count',
        'embedding_cost',
        'created_at',
      ]),
    );
  });

  it('document_chunks table exists with foreign key to documents', () => {
    const { db } = runSyncMigrations();
    const cols = getColumns(db, 'document_chunks');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining(['chunk_id', 'document_id', 'chunk_index', 'chunk_text']),
    );

    const fks = db.prepare('PRAGMA foreign_key_list(document_chunks)').all() as {
      table: string;
      from: string;
      to: string;
    }[];
    expect(fks).toHaveLength(1);
    expect(fks[0].table).toBe('documents');
    expect(fks[0].from).toBe('document_id');
    expect(fks[0].to).toBe('id');
  });

  it('idx_chunks_doc_id index exists', () => {
    const { db } = runSyncMigrations();
    const indexes = db.prepare('PRAGMA index_list(document_chunks)').all() as {
      name: string;
    }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_chunks_doc_id');
  });

  it('foreign key cascade: deleting a document deletes its chunks', () => {
    const { db } = runSyncMigrations();
    db.pragma('foreign_keys = ON');

    db.prepare(
      "INSERT INTO documents (id, title, content, char_count, chunk_count, embedding_cost, created_at) VALUES ('doc1', 'Test', 'content', 7, 2, 0, 1000)",
    ).run();
    db.prepare(
      "INSERT INTO document_chunks (chunk_id, document_id, chunk_index, chunk_text) VALUES ('c1', 'doc1', 0, 'chunk 0')",
    ).run();
    db.prepare(
      "INSERT INTO document_chunks (chunk_id, document_id, chunk_index, chunk_text) VALUES ('c2', 'doc1', 1, 'chunk 1')",
    ).run();

    const chunksBefore = db.prepare('SELECT * FROM document_chunks').all();
    expect(chunksBefore).toHaveLength(2);

    db.prepare("DELETE FROM documents WHERE id = 'doc1'").run();

    const chunksAfter = db.prepare('SELECT * FROM document_chunks').all();
    expect(chunksAfter).toHaveLength(0);
  });
});

describe('Migration 003 - R2 content migration', () => {
  it('migrates document content from SQL to R2', async () => {
    const { env, stored } = makeMockR2Env();
    const { db } = await runAllMigrations(env);

    // After migration 003, content column should be dropped — documents table should not have it
    const cols = getColumns(db, 'documents');
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain('content');
  });

  it('drops chunk_text column from document_chunks', async () => {
    const { env } = makeMockR2Env();
    const { db } = await runAllMigrations(env);

    const cols = getColumns(db, 'document_chunks');
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain('chunk_text');
  });

  it('stores existing document content in R2 during migration', async () => {
    const { env, stored } = makeMockR2Env();
    const { db, sql } = makeSql();

    // Run migrations 001 and 002 first
    for (const [version, up] of MIGRATIONS) {
      if (version === '003') break;
      await up(sql, env, dummyWallet);
    }

    // Insert a document with content (pre-migration 003 state)
    db.prepare(
      "INSERT INTO documents (id, title, content, char_count, chunk_count, embedding_cost, created_at) VALUES ('doc1', 'Test Doc', 'Hello world content', 19, 1, 10, 1000)",
    ).run();

    // Now run migration 003
    const migration003 = MIGRATIONS.find(([v]) => v === '003');
    await migration003![1](sql, env, dummyWallet);

    // Verify content was written to R2
    expect(stored.has(`documents/${dummyWallet.toLowerCase()}/doc1`)).toBe(true);
    expect(stored.get(`documents/${dummyWallet.toLowerCase()}/doc1`)).toBe('Hello world content');
  });

  it('handles empty documents table gracefully', async () => {
    const { env, stored } = makeMockR2Env();
    const { db } = await runAllMigrations(env);

    // No documents inserted — migration should still succeed
    expect(stored.size).toBe(0);
  });

  it('aborts migration if R2 write fails', async () => {
    const env = {
      RAG_STORAGE: {
        put: vi.fn(async () => { throw new Error('R2 unavailable'); }),
        get: vi.fn(async () => null),
        delete: vi.fn(async () => {}),
      },
    } as unknown as Env;

    const { db, sql } = makeSql();
    // Run 001 and 002
    for (const [version, up] of MIGRATIONS) {
      if (version === '003') break;
      await up(sql, env, dummyWallet);
    }

    // Insert a document
    db.prepare(
      "INSERT INTO documents (id, title, content, char_count, chunk_count, embedding_cost, created_at) VALUES ('doc1', 'Test', 'content', 7, 1, 5, 1000)",
    ).run();

    // Migration 003 should throw (R2 write failed)
    const migration003 = MIGRATIONS.find(([v]) => v === '003');
    await expect(migration003![1](sql, env, dummyWallet)).rejects.toThrow('R2 migration failed');

    // Content column should still exist (migration did not complete)
    const cols = getColumns(db, 'documents');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('content');
  });
});

describe('Migration ordering and idempotency', () => {
  it('MIGRATIONS array has correct version numbers in order', () => {
    const versions = MIGRATIONS.map(([v]) => v);
    expect(versions).toEqual(['001', '002', '003']);
    // Verify sorted order
    const sorted = [...versions].sort();
    expect(versions).toEqual(sorted);
  });

  it('running sync migrations (001-002) twice does not error', () => {
    const { sql } = makeSql();
    expect(() => {
      for (const [version, up] of MIGRATIONS) {
        if (version === '003') break;
        up(sql, dummyEnv, dummyWallet);
      }
      for (const [version, up] of MIGRATIONS) {
        if (version === '003') break;
        up(sql, dummyEnv, dummyWallet);
      }
    }).not.toThrow();
  });

  it('all migrations run successfully on a clean database', async () => {
    const { env } = makeMockR2Env();
    await expect(runAllMigrations(env)).resolves.toBeDefined();
  });
});
