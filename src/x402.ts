import { PRICE_USDC_UNITS, PAYMENT_MICRO_USDC, PROOF_MAX_AGE_SECS, NETWORK, USDC_CONTRACT } from './constants';
import { PaymentRequired, PaymentProof, Env, SiwxExtension } from './types';
import { recoverAddress } from './siwe';

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RPC_TIMEOUT_MS = 12_000;
const RPC_MAX_RETRIES = 4;

interface EthLog {
  address: string;
  topics: string[];
  data: string; // uint256 value as hex
}

interface EthReceipt {
  status: string; // '0x1' = success, '0x0' = reverted
  from: string;   // transaction sender
  logs: EthLog[];
}

// ── Proof message builder (shared with frontend for signing) ─────────────────

export function buildProofMessage(proof: Pick<PaymentProof, 'txHash' | 'from' | 'amount' | 'timestamp'>): string {
  return [
    'dox402 payment proof',
    `txHash: ${proof.txHash}`,
    `from: ${proof.from.toLowerCase()}`,
    `amount: ${proof.amount}`,
    `timestamp: ${proof.timestamp}`,
  ].join('\n');
}

// ── 402 response builder ───────────────────────────────────────────────────────

export function build402Response(paymentAddress: string, siwxExtension?: SiwxExtension): Response {
  const body: PaymentRequired & { extensions?: Record<string, unknown> } = {
    version: '1',
    scheme: 'exact',
    network: NETWORK,
    paymentAddress,
    asset: 'USDC',
    amount: PRICE_USDC_UNITS,
    balanceMicroUSDC: PAYMENT_MICRO_USDC,
    maxAgeSeconds: PROOF_MAX_AGE_SECS,
    description: `Pay 0.001 USDC to add ${PAYMENT_MICRO_USDC} µUSDC to your inference balance`,
  };

  if (siwxExtension) {
    body.extensions = { 'sign-in-with-x': siwxExtension };
  }

  const bodyJson = JSON.stringify(body);
  // x402 spec: PAYMENT-REQUIRED header carries base64-encoded PaymentRequired JSON
  return new Response(bodyJson, {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': btoa(bodyJson),
    },
  });
}

// ── Proof verification — Tier 1 (structural) + Tier 2 (on-chain) ──────────────

export async function verifyProof(
  proof: PaymentProof,
  walletAddress: string,
  env: Env,
  opts?: { skipSignature?: boolean },
): Promise<{ valid: boolean; reason?: string; amount?: number }> {

  // ── Tier 1: structural checks (fast, no I/O) ──────────────────────────────
  const now = Math.floor(Date.now() / 1000);

  if (now - proof.timestamp > PROOF_MAX_AGE_SECS)
    return { valid: false, reason: 'proof expired' };

  if (proof.from.toLowerCase() !== walletAddress.toLowerCase())
    return { valid: false, reason: `wallet mismatch: proof.from=${proof.from.toLowerCase()} expected=${walletAddress.toLowerCase()}` };

  if (BigInt(proof.amount) < BigInt(PRICE_USDC_UNITS))
    return { valid: false, reason: 'insufficient amount' };

  // MOCK_PAYMENTS bypasses signature + RPC checks in local dev — must never be set in production
  if (env.MOCK_PAYMENTS === 'true') return { valid: true };

  // EIP-191 signature verification — proves the wallet owner constructed this proof.
  // Skipped for authenticated deposits where Bearer token already establishes identity
  // and on-chain receipt.from confirms the sender.
  if (!opts?.skipSignature) {
    if (!proof.signature || proof.signature === '0x')
      return { valid: false, reason: 'missing proof signature' };

    try {
      const proofMessage = buildProofMessage(proof);
      const recovered = recoverAddress(proofMessage, proof.signature);
      if (recovered.toLowerCase() !== proof.from.toLowerCase())
        return { valid: false, reason: 'proof signature does not match proof.from' };
    } catch {
      return { valid: false, reason: 'invalid proof signature' };
    }
  }

  // ── Tier 2: on-chain receipt verification ──────────────────────────────────

  if (!env.BASE_RPC_URL)
    return { valid: false, reason: 'BASE_RPC_URL not configured' };

  // Fetch transaction receipt with timeout + retry on rate-limit
  let receipt: EthReceipt | null = null;
  let rpcSucceeded = false;
  let lastError = 'RPC request failed or timed out';

  for (let attempt = 0; attempt < RPC_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 3s
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await fetch(env.BASE_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_getTransactionReceipt',
          params: [proof.txHash],
          id: 1,
        }),
        signal: ac.signal,
      });
      const json = await res.json() as { result: EthReceipt | null; error?: { message: string } };
      if (json.error) {
        lastError = `RPC error: ${json.error.message}`;
        // Retry on rate-limit errors; fail fast on others
        if (!json.error.message.toLowerCase().includes('rate limit') &&
            !json.error.message.toLowerCase().includes('too many')) {
          return { valid: false, reason: lastError };
        }
        continue; // retry
      }
      receipt = json.result;
      rpcSucceeded = true;
      break; // success
    } catch {
      lastError = `RPC request failed or timed out (attempt ${attempt + 1}/${RPC_MAX_RETRIES})`;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!rpcSucceeded)
    return { valid: false, reason: lastError };

  if (!receipt)
    return { valid: false, reason: 'transaction not found on-chain — it may still be pending. Please retry in a few seconds.' };

  if (receipt.status !== '0x1')
    return { valid: false, reason: 'transaction reverted on-chain' };

  // Confirm the transaction was sent by the claimed wallet
  if (receipt.from.toLowerCase() !== proof.from.toLowerCase())
    return { valid: false, reason: 'transaction sender does not match proof.from' };

  // Find the USDC Transfer log that proves payment landed in our address
  //   topics[0] = Transfer event signature
  //   topics[1] = from address (left-padded to 32 bytes)
  //   topics[2] = to address   (left-padded to 32 bytes)
  //   data      = uint256 value transferred
  const matched = receipt.logs.find(log =>
    log.address.toLowerCase() === USDC_CONTRACT.toLowerCase() &&
    log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
    log.topics[1]?.toLowerCase().endsWith(proof.from.slice(2).toLowerCase()) &&
    log.topics[2]?.toLowerCase().endsWith(env.PAYMENT_ADDRESS.slice(2).toLowerCase()) &&
    BigInt(log.data) >= BigInt(PRICE_USDC_UNITS),
  );

  if (!matched)
    return { valid: false, reason: 'no matching USDC Transfer to payment address found in transaction' };

  // Return the actual on-chain transfer amount (ERC-20 units = µUSDC for USDC 6-decimal token)
  const amount = Number(BigInt(matched.data));
  return { valid: true, amount };
}
