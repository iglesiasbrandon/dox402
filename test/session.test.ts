import { describe, it, expect, vi } from 'vitest';
import { createSessionToken, verifySessionToken, buildSessionCookie, buildClearCookie, parseCookieToken, TOKEN_EXPIRY_SECS } from '../src/session';

const SECRET = 'test-secret-key-for-hmac-signing-1234567890abcdef';

describe('createSessionToken + verifySessionToken', () => {
  it('roundtrips successfully', async () => {
    const wallet = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { token, expiresAt } = await createSessionToken(wallet, SECRET);

    expect(token).toBeTruthy();
    expect(token.split('.')).toHaveLength(3);
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const payload = await verifySessionToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(wallet.toLowerCase());
    expect(payload!.iat).toBeGreaterThan(0);
    expect(payload!.exp).toBe(expiresAt);
  });

  it('lowercases the wallet address', async () => {
    const wallet = '0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf';
    const { token } = await createSessionToken(wallet, SECRET);
    const payload = await verifySessionToken(token, SECRET);
    expect(payload!.sub).toBe(wallet.toLowerCase());
  });

  it('returns null for expired token', async () => {
    const wallet = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { token } = await createSessionToken(wallet, SECRET);

    // Fast-forward time past expiry (24h + 1s)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 86401 * 1000);

    const payload = await verifySessionToken(token, SECRET);
    expect(payload).toBeNull();

    vi.useRealTimers();
  });

  it('returns null for tampered payload', async () => {
    const { token } = await createSessionToken('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', SECRET);
    const parts = token.split('.');
    // Tamper with the payload (change a character)
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');

    const payload = await verifySessionToken(tampered, SECRET);
    expect(payload).toBeNull();
  });

  it('returns null for tampered signature', async () => {
    const { token } = await createSessionToken('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', SECRET);
    const parts = token.split('.');
    // Tamper with the signature
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'x' ? 'y' : 'x');
    const tampered = parts.join('.');

    const payload = await verifySessionToken(tampered, SECRET);
    expect(payload).toBeNull();
  });

  it('returns null for wrong secret', async () => {
    const { token } = await createSessionToken('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', SECRET);
    const payload = await verifySessionToken(token, 'wrong-secret');
    expect(payload).toBeNull();
  });

  it('returns null for malformed token (wrong number of parts)', async () => {
    expect(await verifySessionToken('only-one-part', SECRET)).toBeNull();
    expect(await verifySessionToken('two.parts', SECRET)).toBeNull();
    expect(await verifySessionToken('four.parts.here.extra', SECRET)).toBeNull();
  });

  it('returns null for empty token', async () => {
    expect(await verifySessionToken('', SECRET)).toBeNull();
  });

  it('includes chain claim when provided', async () => {
    const wallet = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { token } = await createSessionToken(wallet, SECRET, 'eip155:8453');
    const payload = await verifySessionToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.chain).toBe('eip155:8453');
  });

  it('omits chain claim when not provided', async () => {
    const wallet = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { token } = await createSessionToken(wallet, SECRET);
    const payload = await verifySessionToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.chain).toBeUndefined();
  });
});

describe('buildSessionCookie', () => {
  it('returns correctly formatted Set-Cookie value with Secure', () => {
    const cookie = buildSessionCookie('my.jwt.token', 86400, true);
    expect(cookie).toBe('ig_session=my.jwt.token; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400; Secure');
  });

  it('omits Secure flag when isSecure is false', () => {
    const cookie = buildSessionCookie('my.jwt.token', 86400, false);
    expect(cookie).toBe('ig_session=my.jwt.token; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400');
    expect(cookie).not.toContain('Secure');
  });

  it('uses provided maxAgeSecs', () => {
    const cookie = buildSessionCookie('tok', 3600, true);
    expect(cookie).toContain('Max-Age=3600');
  });
});

describe('buildClearCookie', () => {
  it('returns cookie with Max-Age=0 and Secure', () => {
    const cookie = buildClearCookie(true);
    expect(cookie).toBe('ig_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
  });

  it('omits Secure flag when isSecure is false', () => {
    const cookie = buildClearCookie(false);
    expect(cookie).toBe('ig_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    expect(cookie).not.toContain('Secure');
  });
});

describe('parseCookieToken', () => {
  it('extracts token from Cookie header', () => {
    const token = parseCookieToken('ig_session=abc.def.ghi');
    expect(token).toBe('abc.def.ghi');
  });

  it('extracts token when multiple cookies present', () => {
    const token = parseCookieToken('other=foo; ig_session=abc.def.ghi; another=bar');
    expect(token).toBe('abc.def.ghi');
  });

  it('returns null for missing cookie', () => {
    expect(parseCookieToken('other=foo; bar=baz')).toBeNull();
  });

  it('returns null for null header', () => {
    expect(parseCookieToken(null)).toBeNull();
  });

  it('returns null for empty cookie value', () => {
    expect(parseCookieToken('ig_session=')).toBeNull();
  });
});

describe('TOKEN_EXPIRY_SECS', () => {
  it('is 4 hours in seconds', () => {
    expect(TOKEN_EXPIRY_SECS).toBe(14400);
  });
});
