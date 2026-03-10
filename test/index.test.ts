import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers (imported transitively via dox402.ts)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

import worker from '../src/index';
import type { Env } from '../src/types';

function makeEnv(): Env {
  return {
    DOX402: {} as any,
    AI: {} as any,
    PAYMENT_ADDRESS: '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1',
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    SESSION_SECRET: 'test-secret',
  };
}

// ── CORS ──────────────────────────────────────────────────────────────────────

describe('CORS', () => {
  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const req = new Request('https://dox402.example.com/infer', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('PAYMENT-SIGNATURE');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('OPTIONS on any path returns 204', async () => {
    const req = new Request('https://dox402.example.com/nonexistent', { method: 'OPTIONS' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
  });

  it('GET /health includes CORS headers', async () => {
    const req = new Request('https://dox402.example.com/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Balance');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('PAYMENT-REQUIRED');
  });

  it('Access-Control-Allow-Origin reflects the request URL origin', async () => {
    const req = new Request('http://localhost:8787/health', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8787');
  });

  it('404 responses also include CORS headers', async () => {
    const req = new Request('https://dox402.example.com/nonexistent', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
  });

  it('preserves original response headers alongside CORS headers', async () => {
    const req = new Request('https://dox402.example.com/payment-info', { method: 'GET' });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dox402.example.com');
  });
});
