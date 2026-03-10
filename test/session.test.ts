import { describe, it, expect, vi } from 'vitest';
import { createSessionToken, verifySessionToken } from '../src/session';

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
});
