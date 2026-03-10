import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { buildSiweMessage, parseSiweMessage, recoverAddress, verifySiweLogin, SiweMessage } from '../src/siwe';

// ── Test wallet helpers ─────────────────────────────────────────────────────────

function generateWallet() {
  const privKey = secp256k1.utils.randomSecretKey();
  const pubKey = secp256k1.getPublicKey(privKey, false);
  const addrHash = keccak_256(pubKey.slice(1));
  const address = '0x' + Array.from(addrHash.slice(12)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { privKey, address };
}

function personalSign(message: string, privateKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix);
  prefixed.set(msgBytes, prefix.length);
  const hash = keccak_256(prefixed);

  const sig64 = secp256k1.sign(hash, privateKey, { prehash: false });
  const expectedPub = secp256k1.getPublicKey(privateKey, false);

  let recoveryBit = 0;
  for (const v of [0, 1]) {
    const sigObj = secp256k1.Signature.fromBytes(sig64).addRecoveryBit(v);
    const recovered = sigObj.recoverPublicKey(hash).toBytes(false);
    if (recovered.every((b: number, i: number) => b === expectedPub[i])) {
      recoveryBit = v;
      break;
    }
  }

  const hex = Array.from(sig64).map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hex + (recoveryBit + 27).toString(16).padStart(2, '0');
}

function makeSiweParams(address: string, overrides?: Partial<SiweMessage>): SiweMessage {
  return {
    domain: 'localhost:8787',
    address,
    statement: 'Sign in to dox402',
    uri: 'http://localhost:8787',
    version: '1',
    chainId: 8453,
    nonce: 'abc123def456',
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe('buildSiweMessage', () => {
  it('produces correct EIP-4361 format', () => {
    const params = makeSiweParams('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const msg = buildSiweMessage(params);

    expect(msg).toContain('localhost:8787 wants you to sign in with your Ethereum account:');
    expect(msg).toContain('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(msg).toContain('URI: http://localhost:8787');
    expect(msg).toContain('Version: 1');
    expect(msg).toContain('Chain ID: 8453');
    expect(msg).toContain('Nonce: abc123def456');
    expect(msg).toContain('Issued At:');
  });

  it('includes expirationTime when provided', () => {
    const params = makeSiweParams('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', {
      expirationTime: '2030-01-01T00:00:00.000Z',
    });
    const msg = buildSiweMessage(params);
    expect(msg).toContain('Expiration Time: 2030-01-01T00:00:00.000Z');
  });

  it('omits expirationTime when not provided', () => {
    const params = makeSiweParams('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const msg = buildSiweMessage(params);
    expect(msg).not.toContain('Expiration Time:');
  });
});

describe('parseSiweMessage', () => {
  it('roundtrips with buildSiweMessage', () => {
    const params = makeSiweParams('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', {
      expirationTime: '2030-01-01T00:00:00.000Z',
    });
    const msg = buildSiweMessage(params);
    const parsed = parseSiweMessage(msg);

    expect(parsed).not.toBeNull();
    expect(parsed!.domain).toBe('localhost:8787');
    expect(parsed!.address).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(parsed!.statement).toBe('Sign in to dox402');
    expect(parsed!.uri).toBe('http://localhost:8787');
    expect(parsed!.version).toBe('1');
    expect(parsed!.chainId).toBe(8453);
    expect(parsed!.nonce).toBe('abc123def456');
    expect(parsed!.expirationTime).toBe('2030-01-01T00:00:00.000Z');
  });

  it('returns null on garbage input', () => {
    expect(parseSiweMessage('')).toBeNull();
    expect(parseSiweMessage('not a SIWE message')).toBeNull();
    expect(parseSiweMessage('hello\nworld')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    // Missing address line
    const msg = 'localhost wants you to sign in with your Ethereum account:\nURI: http://localhost\nVersion: 1\nChain ID: 1\nNonce: abc\nIssued At: 2025-01-01T00:00:00Z';
    expect(parseSiweMessage(msg)).toBeNull();
  });
});

describe('recoverAddress', () => {
  it('recovers the correct address from a known keypair', () => {
    const { privKey, address } = generateWallet();
    const message = 'Hello, Ethereum!';
    const signature = personalSign(message, privKey);
    const recovered = recoverAddress(message, signature);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });

  it('throws on invalid signature length', () => {
    expect(() => recoverAddress('test', '0x1234')).toThrow('Invalid signature length');
  });

  it('handles signature without 0x prefix', () => {
    const { privKey, address } = generateWallet();
    const message = 'test message';
    const sig = personalSign(message, privKey);
    const sigWithout0x = sig.slice(2);
    const recovered = recoverAddress(message, sigWithout0x);
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());
  });
});

describe('verifySiweLogin', () => {
  it('accepts a valid SIWE login', () => {
    const { privKey, address } = generateWallet();
    const params = makeSiweParams(address, {
      expirationTime: new Date(Date.now() + 300_000).toISOString(),
    });
    const msg = buildSiweMessage(params);
    const sig = personalSign(msg, privKey);

    const result = verifySiweLogin(msg, sig, 'localhost:8787');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.parsed.address.toLowerCase()).toBe(address.toLowerCase());
    }
  });

  it('rejects wrong domain', () => {
    const { privKey, address } = generateWallet();
    const params = makeSiweParams(address);
    const msg = buildSiweMessage(params);
    const sig = personalSign(msg, privKey);

    const result = verifySiweLogin(msg, sig, 'evil.com');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('Domain mismatch');
  });

  it('rejects expired message', () => {
    const { privKey, address } = generateWallet();
    const params = makeSiweParams(address, {
      expirationTime: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });
    const msg = buildSiweMessage(params);
    const sig = personalSign(msg, privKey);

    const result = verifySiweLogin(msg, sig, 'localhost:8787');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('expired');
  });

  it('rejects issuedAt in the future', () => {
    const { privKey, address } = generateWallet();
    const params = makeSiweParams(address, {
      issuedAt: new Date(Date.now() + 120_000).toISOString(), // 2 min future
    });
    const msg = buildSiweMessage(params);
    const sig = personalSign(msg, privKey);

    const result = verifySiweLogin(msg, sig, 'localhost:8787');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('future');
  });

  it('rejects signature from a different wallet', () => {
    const wallet1 = generateWallet();
    const wallet2 = generateWallet();
    const params = makeSiweParams(wallet1.address); // message claims wallet1
    const msg = buildSiweMessage(params);
    const sig = personalSign(msg, wallet2.privKey); // signed by wallet2

    const result = verifySiweLogin(msg, sig, 'localhost:8787');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('does not match');
  });

  it('rejects malformed message', () => {
    const result = verifySiweLogin('garbage', '0x' + '00'.repeat(65), 'localhost:8787');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('parse');
  });

  it('rejects unsupported version', () => {
    const { privKey, address } = generateWallet();
    const params = makeSiweParams(address, { version: '2' });
    const msg = buildSiweMessage(params);
    const sig = personalSign(msg, privKey);

    const result = verifySiweLogin(msg, sig, 'localhost:8787');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain('version');
  });
});
