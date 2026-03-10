import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { build402Response, verifyProof } from '../src/x402';
import { PRICE_USDC_UNITS, PAYMENT_MICRO_USDC, USDC_CONTRACT } from '../src/constants';
import type { PaymentProof, Env } from '../src/types';

const PAYMENT_ADDRESS = '0x24AF3AcF8A91f5185e8CfB28087E2C54d49785B1';
const WALLET = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeProof(overrides?: Partial<PaymentProof>): PaymentProof {
  return {
    txHash: '0x' + 'a'.repeat(64),
    from: WALLET,
    amount: '1000',
    timestamp: Math.floor(Date.now() / 1000),
    signature: '0xmock',
    ...overrides,
  };
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
    // null RPC result still has default lastError since receipt remains null
    expect(result.reason).toBeTruthy();
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
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
    const result = await verifyProof(makeProof(), WALLET, env);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('timed out');
  });
});
