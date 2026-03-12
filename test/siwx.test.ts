import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { parseSiwxHeader, buildSiwxExtension, verifySiwxPayload } from '../src/siwx';
import { buildSiweMessage } from '../src/siwe';

// ── Test wallet helpers ─────────────────────────────────────────────────────

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

// ── parseSiwxHeader ─────────────────────────────────────────────────────────

describe('parseSiwxHeader', () => {
  it('parses a valid base64-encoded SIWX payload', () => {
    const payload = {
      message: 'test message',
      signature: '0xabc',
      chainId: 'eip155:8453',
      type: 'eip191',
      address: '0x1234567890abcdef1234567890abcdef12345678',
    };
    const encoded = btoa(JSON.stringify(payload));
    const result = parseSiwxHeader(encoded);
    expect(result).not.toBeNull();
    expect(result!.chainId).toBe('eip155:8453');
    expect(result!.type).toBe('eip191');
  });

  it('returns null for invalid base64', () => {
    expect(parseSiwxHeader('not-valid-base64!!!')).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const partial = { message: 'test', signature: '0x' };
    const encoded = btoa(JSON.stringify(partial));
    expect(parseSiwxHeader(encoded)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSiwxHeader('')).toBeNull();
  });

  it('returns null for valid base64 but invalid JSON', () => {
    expect(parseSiwxHeader(btoa('not json'))).toBeNull();
  });

  it('returns null when only address is missing', () => {
    const payload = { message: 'test', signature: '0x', chainId: 'eip155:8453', type: 'eip191' };
    expect(parseSiwxHeader(btoa(JSON.stringify(payload)))).toBeNull();
  });
});

// ── buildSiwxExtension ──────────────────────────────────────────────────────

describe('buildSiwxExtension', () => {
  it('builds a valid SIWX extension', () => {
    const ext = buildSiwxExtension('dox402.com', 'https://dox402.com/infer', 'abc123');
    expect(ext.supportedChains).toHaveLength(1);
    expect(ext.supportedChains[0].chainId).toBe('eip155:8453');
    expect(ext.supportedChains[0].type).toBe('eip191');
    expect(ext.info.domain).toBe('dox402.com');
    expect(ext.info.uri).toBe('https://dox402.com/infer');
    expect(ext.info.nonce).toBe('abc123');
    expect(ext.info.version).toBe('1');
    expect(ext.info.statement).toContain('dox402');
  });

  it('sets issuedAt and expirationTime', () => {
    const before = Date.now();
    const ext = buildSiwxExtension('dox402.com', 'https://dox402.com', 'nonce1');
    const after = Date.now();

    const issuedAt = new Date(ext.info.issuedAt).getTime();
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(after);

    const expiry = new Date(ext.info.expirationTime).getTime();
    expect(expiry).toBeGreaterThan(issuedAt);
  });
});

// ── verifySiwxPayload ───────────────────────────────────────────────────────

describe('verifySiwxPayload', () => {
  const domain = 'dox402.com';

  it('verifies a valid EVM SIWX payload', () => {
    const { privKey, address } = generateWallet();
    const now = new Date();
    const message = buildSiweMessage({
      domain,
      address,
      statement: 'Sign in to dox402',
      uri: `https://${domain}`,
      version: '1',
      chainId: 8453,
      nonce: 'abcdef1234567890abcdef1234567890',
      issuedAt: now.toISOString(),
      expirationTime: new Date(now.getTime() + 300_000).toISOString(),
    });

    const signature = personalSign(message, privKey);

    const payload = {
      message,
      signature,
      chainId: 'eip155:8453',
      type: 'eip191',
      address,
    };

    const result = verifySiwxPayload(payload, domain);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.address).toBe(address.toLowerCase());
    }
  });

  it('rejects an unsupported chain', () => {
    const result = verifySiwxPayload({
      message: 'test',
      signature: '0x',
      chainId: 'solana:mainnet',
      type: 'ed25519',
      address: '7pK...',
    }, domain);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('Unsupported chain');
    }
  });

  it('rejects an unsupported signature type', () => {
    const result = verifySiwxPayload({
      message: 'test',
      signature: '0x',
      chainId: 'eip155:8453',
      type: 'unknown',
      address: '0x1234567890abcdef1234567890abcdef12345678',
    }, domain);
    expect(result.valid).toBe(false);
  });

  it('rejects address mismatch between payload and SIWE message', () => {
    const { privKey, address } = generateWallet();
    const { address: otherAddress } = generateWallet();
    const now = new Date();
    const message = buildSiweMessage({
      domain,
      address,
      statement: 'Sign in to dox402',
      uri: `https://${domain}`,
      version: '1',
      chainId: 8453,
      nonce: 'abcdef1234567890abcdef1234567890',
      issuedAt: now.toISOString(),
    });

    const signature = personalSign(message, privKey);

    const result = verifySiwxPayload({
      message,
      signature,
      chainId: 'eip155:8453',
      type: 'eip191',
      address: otherAddress, // different from SIWE message
    }, domain);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('address');
    }
  });

  it('rejects wrong domain', () => {
    const { privKey, address } = generateWallet();
    const now = new Date();
    const message = buildSiweMessage({
      domain: 'evil.com',
      address,
      statement: 'Sign in',
      uri: 'https://evil.com',
      version: '1',
      chainId: 8453,
      nonce: 'abcdef1234567890abcdef1234567890',
      issuedAt: now.toISOString(),
    });

    const signature = personalSign(message, privKey);

    const result = verifySiwxPayload({
      message,
      signature,
      chainId: 'eip155:8453',
      type: 'eip191',
      address,
    }, domain);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('Domain');
    }
  });
});
