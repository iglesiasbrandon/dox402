import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../src/migrations';

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
  migration[1](sql);
  return { db, sql };
}

function runAllMigrations() {
  const { db, sql } = makeSql();
  for (const [, up] of MIGRATIONS) {
    up(sql);
  }
  return { db, sql };
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
    const { db } = runAllMigrations();
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
    const { db } = runAllMigrations();
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
    const { db } = runAllMigrations();
    const indexes = db.prepare('PRAGMA index_list(document_chunks)').all() as {
      name: string;
    }[];
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_chunks_doc_id');
  });

  it('foreign key cascade: deleting a document deletes its chunks', () => {
    const { db } = runAllMigrations();
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

describe('Migration ordering and idempotency', () => {
  it('MIGRATIONS array has correct version numbers in order', () => {
    const versions = MIGRATIONS.map(([v]) => v);
    expect(versions).toEqual(['001', '002']);
    // Verify sorted order
    const sorted = [...versions].sort();
    expect(versions).toEqual(sorted);
  });

  it('running all migrations twice does not error', () => {
    const { sql } = makeSql();
    expect(() => {
      for (const [, up] of MIGRATIONS) {
        up(sql);
      }
      for (const [, up] of MIGRATIONS) {
        up(sql);
      }
    }).not.toThrow();
  });

  it('all migrations run successfully on a clean database', () => {
    expect(() => {
      runAllMigrations();
    }).not.toThrow();
  });
});
