import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { build402Response, verifyProof, buildProofMessage } from '../src/x402';
import { PRICE_USDC_UNITS, PAYMENT_MICRO_USDC, USDC_CONTRACT } from '../src/constants';
import type { PaymentProof, Env } from '../src/types';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const PAYMENT_ADDRESS = '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1';

// ── Test keypairs (deterministic per run) ───────────────────────────────────

const PRIV_KEY = secp256k1.utils.randomSecretKey();
const PUB_KEY = secp256k1.getPublicKey(PRIV_KEY, false);
const ADDR_HASH = keccak_256(PUB_KEY.slice(1));
const WALLET = '0x' + Array.from(ADDR_HASH.slice(12)).map(b => b.toString(16).padStart(2, '0')).join('');

// Second keypair for "wrong wallet" tests
const PRIV_KEY_2 = secp256k1.utils.randomSecretKey();
const PUB_KEY_2 = secp256k1.getPublicKey(PRIV_KEY_2, false);
const ADDR_HASH_2 = keccak_256(PUB_KEY_2.slice(1));
const WALLET_2 = '0x' + Array.from(ADDR_HASH_2.slice(12)).map(b => b.toString(16).padStart(2, '0')).join('');

// ── EIP-191 personal_sign (same logic as recoverAddress in siwe.ts, but signing) ─

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeProof(overrides?: Partial<PaymentProof>): PaymentProof {
  const base: Omit<PaymentProof, 'signature'> = {
    txHash: '0x' + 'a'.repeat(64),
    from: WALLET,
    amount: '1000',
    timestamp: Math.floor(Date.now() / 1000),
  };
  const merged = { ...base, ...overrides } as PaymentProof;
  // Auto-sign with PRIV_KEY unless signature is explicitly provided in overrides
  if (!overrides || !('signature' in overrides)) {
    merged.signature = personalSign(buildProofMessage(merged), PRIV_KEY);
  }
  return merged;
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    DOX402: {} as any,
    AI: {} as any,
    PAYMENT_ADDRESS,
    BASE_RPC_URL: 'https://mainnet.base.org',
    NETWORK: 'base-mainnet',
    MOCK_PAYMENTS: 'true',
    SESSION_SECRET: 'test-secret',
    ...overrides,
  };
}

// ── build402Response ──────────────────────────────────────────────────────────

describe('build402Response', () => {
  it('returns 402 status', () => {
    const res = build402Response(PAYMENT_ADDRESS);
    expect(res.status).toBe(402);
  });

  it('has correct JSON body', async () => {
    const res = build402Response(PAYMENT_ADDRESS);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe('1');
    expect(body.scheme).toBe('exact');
    expect(body.paymentAddress).toBe(PAYMENT_ADDRESS);
    expect(body.asset).toBe('USDC');
    expect(body.amount).toBe(PRICE_USDC_UNITS);
    expect(body.balanceMicroUSDC).toBe(PAYMENT_MICRO_USDC);
  });

  it('has PAYMENT-REQUIRED header that decodes to same JSON', async () => {
    const res = build402Response(PAYMENT_ADDRESS);
    const header = res.headers.get('PAYMENT-REQUIRED');
    expect(header).toBeTruthy();
    const decoded = JSON.parse(atob(header!)) as Record<string, unknown>;
    expect(decoded.version).toBe('1');
    expect(decoded.paymentAddress).toBe(PAYMENT_ADDRESS);
  });
});

// ── verifyProof Tier 1 ──────────────────────────────────────────────────────────

describe('verifyProof — Tier 1 (structural)', () => {
  it('accepts valid proof with MOCK_PAYMENTS=true', async () => {
    const result = await verifyProof(makeProof(), WALLET, makeEnv());
    expect(result.valid).toBe(true);
  });

  it('rejects expired proof', async () => {
    const proof = makeProof({ timestamp: Math.floor(Date.now() / 1000) - 600 }); // 10 min ago
    const result = await verifyProof(proof, WALLET, makeEnv());
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('rejects wallet mismatch', async () => {
    const result = await verifyProof(makeProof(), '0x1111111111111111111111111111111111111111', makeEnv());
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('wallet mismatch');
  });

  it('rejects insufficient amount', async () => {
    const proof = makeProof({ amount: '999' }); // less than PRICE_USDC_UNITS (1000)
    const result = await verifyProof(proof, WALLET, makeEnv());
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('insufficient');
  });

  it('accepts exact minimum amount', async () => {
    const proof = makeProof({ amount: PRICE_USDC_UNITS });
    const result = await verifyProof(proof, WALLET, makeEnv());
    expect(result.valid).toBe(true);
  });

  it('is case-insensitive for wallet comparison', async () => {
    const proof = makeProof({ from: WALLET.toUpperCase() });
    const result = await verifyProof(proof, WALLET.toLowerCase(), makeEnv());
    expect(result.valid).toBe(true);
  });
});

// ── verifyProof — Signature verification ─────────────────────────────────────

describe('verifyProof — Signature verification', () => {
  const env = makeEnv({ MOCK_PAYMENTS: undefined });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Stub RPC to return a valid receipt (so we isolate signature checks)
  function mockValidReceipt() {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({
        jsonrpc: '2.0', id: 1,
        result: {
          status: '0x1',
          from: WALLET,
          logs: [{
            address: USDC_CONTRACT,
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000' + WALLET.slice(2).toLowerCase(),
              '0x000000000000000000000000' + PAYMENT_ADDRESS.slice(2).toLowerCase(),
            ],
            data: '0x' + BigInt(1000).toString(16).padStart(64, '0'),
          }],
        },
      }),
    });
  }

  it('accepts proof with valid signature', async () => {
    mockValidReceipt();
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(true);
  });

  it('rejects missing proof signature', async () => {
    const proof = makeProof({ signature: '' });
    const result = await verifyProof(proof, WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('missing proof signature');
  });

  it('rejects placeholder 0x signature', async () => {
    const proof = makeProof({ signature: '0x' });
    const result = await verifyProof(proof, WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('missing proof signature');
  });

  it('rejects invalid signature bytes', async () => {
    const proof = makeProof({ signature: '0xdeadbeef' });
    const result = await verifyProof(proof, WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid proof signature');
  });

  it('rejects signature from wrong wallet', async () => {
    // Sign with PRIV_KEY_2 (whose address is WALLET_2) but claim from=WALLET
    const proof = makeProof();
    proof.signature = personalSign(buildProofMessage(proof), PRIV_KEY_2);
    const result = await verifyProof(proof, WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match');
  });
});

// ── verifyProof Tier 2 (on-chain) ───────────────────────────────────────────────

describe('verifyProof — Tier 2 (on-chain)', () => {
  const env = makeEnv({ MOCK_PAYMENTS: undefined }); // disable mock

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockRPCResponse(receipt: unknown) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }),
    });
  }

  const validReceipt = {
    status: '0x1',
    from: WALLET,
    logs: [{
      address: USDC_CONTRACT,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x000000000000000000000000' + WALLET.slice(2).toLowerCase(),
        '0x000000000000000000000000' + PAYMENT_ADDRESS.slice(2).toLowerCase(),
      ],
      data: '0x' + BigInt(5000).toString(16).padStart(64, '0'),
    }],
  };

  it('accepts valid receipt with matching Transfer log', async () => {
    mockRPCResponse(validReceipt);
    const result = await verifyProof(makeProof({ amount: '5000' }), WALLET, env);
    expect(result.valid).toBe(true);
    expect(result.amount).toBe(5000);
  });

  it('rejects reverted transaction', async () => {
    mockRPCResponse({ ...validReceipt, status: '0x0' });
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('reverted');
  });

  it('rejects sender mismatch', async () => {
    mockRPCResponse({ ...validReceipt, from: '0x1111111111111111111111111111111111111111' });
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('sender does not match');
  });

  it('rejects when no matching USDC Transfer log exists', async () => {
    mockRPCResponse({ ...validReceipt, logs: [] });
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no matching USDC Transfer');
  });

  it('rejects null receipt (tx not mined)', async () => {
    mockRPCResponse(null);
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('not found on-chain');
  });

  it('rejects when BASE_RPC_URL is missing', async () => {
    const noRpcEnv = makeEnv({ MOCK_PAYMENTS: undefined, BASE_RPC_URL: '' });
    const result = await verifyProof(makeProof(), WALLET, noRpcEnv);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('BASE_RPC_URL');
  });

  it('handles RPC error response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { message: 'internal server error' } }),
    });
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('RPC error');
  });

  it('handles fetch timeout/network failure', async () => {
    vi.useFakeTimers();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
    const promise = verifyProof(makeProof(), WALLET, env);
    // Advance past all retry backoff delays (4 retries × up to 3s backoff + 12s timeout each)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(15_000);
    }
    const result = await promise;
    vi.useRealTimers();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('timed out');
  });
});
