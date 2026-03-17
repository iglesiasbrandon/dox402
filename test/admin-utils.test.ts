import { describe, it, expect } from 'vitest';
import { isAdmin, adminUnauthorized, adminDisabled } from '../src/admin';
import type { Env } from '../src/types';

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com', { headers });
}

function makeEnv(adminSecret?: string): Env {
  return { ADMIN_SECRET: adminSecret } as unknown as Env;
}

describe('isAdmin', () => {
  it('returns false when ADMIN_SECRET is undefined', () => {
    const env = makeEnv(undefined);
    const request = makeRequest({ Authorization: 'Bearer anything' });
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns false when ADMIN_SECRET is empty string', () => {
    const env = makeEnv('');
    const request = makeRequest({ Authorization: 'Bearer anything' });
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns false when no Authorization header', () => {
    const env = makeEnv('my-secret');
    const request = makeRequest();
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns false when Authorization header does not start with "Bearer "', () => {
    const env = makeEnv('my-secret');
    const request = makeRequest({ Authorization: 'Basic my-secret' });
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns false with lowercase "bearer "', () => {
    const env = makeEnv('my-secret');
    const request = makeRequest({ Authorization: 'bearer my-secret' });
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns false when token has different length than ADMIN_SECRET', () => {
    const env = makeEnv('my-secret');
    const request = makeRequest({ Authorization: 'Bearer short' });
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns false when token is wrong but same length', () => {
    const env = makeEnv('my-secret');
    const request = makeRequest({ Authorization: 'Bearer xx-secret' });
    expect(isAdmin(request, env)).toBe(false);
  });

  it('returns true when token matches exactly', () => {
    const env = makeEnv('my-secret');
    const request = makeRequest({ Authorization: 'Bearer my-secret' });
    expect(isAdmin(request, env)).toBe(true);
  });

  it('works with special characters in the secret', () => {
    const secret = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
    const env = makeEnv(secret);
    const request = makeRequest({ Authorization: `Bearer ${secret}` });
    expect(isAdmin(request, env)).toBe(true);
  });

  it('works with a very long secret', () => {
    const secret = 'a'.repeat(10_000);
    const env = makeEnv(secret);
    const request = makeRequest({ Authorization: `Bearer ${secret}` });
    expect(isAdmin(request, env)).toBe(true);
  });

  it('returns false for partial match (same prefix, different suffix)', () => {
    const env = makeEnv('secret-AAAA');
    const request = makeRequest({ Authorization: 'Bearer secret-BBBB' });
    expect(isAdmin(request, env)).toBe(false);
  });
});

describe('adminUnauthorized', () => {
  it('returns 401 status', () => {
    const response = adminUnauthorized();
    expect(response.status).toBe(401);
  });

  it('returns JSON body with error message', async () => {
    const response = adminUnauthorized();
    const body = await response.json();
    expect(body).toEqual({ error: 'Admin authentication required' });
  });
});

describe('adminDisabled', () => {
  it('returns 503 status', () => {
    const response = adminDisabled();
    expect(response.status).toBe(503);
  });

  it('returns JSON body with error message', async () => {
    const response = adminDisabled();
    const body = await response.json();
    expect(body).toEqual({
      error: 'Admin endpoints not configured \u2014 set ADMIN_SECRET',
    });
  });
});
