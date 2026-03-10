/**
 * End-to-end test client for dox402 — exercises the full SIWE auth + x402 payment flow.
 *
 * Signs SIWE messages programmatically using @noble/curves (no browser wallet needed).
 * Requires wrangler dev running on localhost:8787 with MOCK_PAYMENTS=true in .dev.vars.
 *
 * Run: npx ts-node --esm test/client.ts
 */
export {}; // ES module

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const BASE_URL = 'http://localhost:8787';
const DOMAIN   = 'localhost:8787';
const PROMPT   = 'In one sentence, what is a Durable Object?';

// ── Generate a random test wallet ──────────────────────────────────────────────
const privKey  = secp256k1.utils.randomSecretKey();
const pubKey   = secp256k1.getPublicKey(privKey, false); // uncompressed
const addrHash = keccak_256(pubKey.slice(1));
const WALLET   = '0x' + Array.from(addrHash.slice(12)).map(b => b.toString(16).padStart(2, '0')).join('');

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { throw new Error(`FAIL: ${msg}`); }

// ── EIP-191 personal_sign ──────────────────────────────────────────────────────
function personalSign(message: string, privateKey: Uint8Array): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix   = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix);
  prefixed.set(msgBytes, prefix.length);
  const hash = keccak_256(prefixed);

  // Sign with compact format (64 bytes r+s), then find the correct recovery bit
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

// ── Helpers ────────────────────────────────────────────────────────────────────
let authToken = '';
function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// Phase 1: Public endpoints
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[1] Public endpoints');

const healthRes = await fetch(`${BASE_URL}/health`);
if (healthRes.status !== 200) fail(`/health returned ${healthRes.status}`);
pass('GET /health → 200');

const payInfoRes = await fetch(`${BASE_URL}/payment-info`);
const payInfo = await payInfoRes.json() as Record<string, unknown>;
if (!payInfo.paymentAddress) fail('payment-info missing paymentAddress');
pass(`GET /payment-info → ${JSON.stringify(payInfo).slice(0, 80)}...`);

// ════════════════════════════════════════════════════════════════════════════════
// Phase 2: SIWE authentication
// ════════════════════════════════════════════════════════════════════════════════
console.log(`\n[2] SIWE auth — wallet ${WALLET.slice(0, 10)}...`);

// 2a: Get nonce
const nonceRes = await fetch(`${BASE_URL}/auth/nonce?wallet=${WALLET}`);
if (nonceRes.status !== 200) fail(`/auth/nonce returned ${nonceRes.status}`);
const { nonce } = await nonceRes.json() as { nonce: string };
pass(`GET /auth/nonce → nonce: ${nonce.slice(0, 12)}...`);

// 2b: Build and sign SIWE message
const now = new Date();
const exp = new Date(now.getTime() + 300_000); // 5 min
const siweMessage = [
  `${DOMAIN} wants you to sign in with your Ethereum account:`,
  WALLET,
  '',
  'Sign in to dox402 inference gateway',
  '',
  `URI: http://${DOMAIN}`,
  'Version: 1',
  'Chain ID: 8453',
  `Nonce: ${nonce}`,
  `Issued At: ${now.toISOString()}`,
  `Expiration Time: ${exp.toISOString()}`,
].join('\n');

const signature = personalSign(siweMessage, privKey);
pass('Built + signed SIWE message (EIP-191)');

// 2c: Login
const loginRes = await fetch(`${BASE_URL}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: siweMessage, signature }),
});
if (loginRes.status !== 200) {
  const err = await loginRes.text();
  fail(`/auth/login returned ${loginRes.status}: ${err}`);
}
const loginBody = await loginRes.json() as { token: string; expiresAt: number };
authToken = loginBody.token;
pass(`POST /auth/login → token issued, expires ${new Date(loginBody.expiresAt * 1000).toISOString()}`);

// ════════════════════════════════════════════════════════════════════════════════
// Phase 3: Unauthenticated requests → 401
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[3] Auth enforcement');

const noAuthRes = await fetch(`${BASE_URL}/balance`);
if (noAuthRes.status !== 401) fail(`Expected 401 without auth, got ${noAuthRes.status}`);
pass('GET /balance without token → 401');

// ════════════════════════════════════════════════════════════════════════════════
// Phase 4: First inference → 402 (no balance)
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[4] POST /infer — no balance (expect 402)');

const inferNoBalRes = await fetch(`${BASE_URL}/infer`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({ prompt: PROMPT, walletAddress: WALLET }),
});
if (inferNoBalRes.status !== 402) fail(`Expected 402, got ${inferNoBalRes.status}`);
const prHeader = inferNoBalRes.headers.get('PAYMENT-REQUIRED');
if (!prHeader) fail('PAYMENT-REQUIRED header missing');
pass('Status: 402 + PAYMENT-REQUIRED header present');

// ════════════════════════════════════════════════════════════════════════════════
// Phase 5: Deposit with mock proof → balance topped up
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[5] POST /deposit — mock payment proof');

const mockTxHash = '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const mockProof = {
  txHash:    mockTxHash,
  from:      WALLET,
  amount:    '1000',
  timestamp: Math.floor(Date.now() / 1000),
  signature: '0xmocksignature',
};
const proofB64 = btoa(JSON.stringify(mockProof));

const depositRes = await fetch(`${BASE_URL}/deposit`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({ walletAddress: WALLET, proof: proofB64 }),
});
if (depositRes.status !== 200) {
  const err = await depositRes.text();
  fail(`Expected 200, got ${depositRes.status}: ${err}`);
}
const depositBody = await depositRes.json() as { ok: boolean; credited: number; balance: number };
pass(`Deposited ${depositBody.credited} µUSDC → balance: ${depositBody.balance}`);

// ════════════════════════════════════════════════════════════════════════════════
// Phase 6: Replay attack — same txHash → rejected
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[6] POST /deposit — replay same txHash (expect 402)');

const replayRes = await fetch(`${BASE_URL}/deposit`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({ walletAddress: WALLET, proof: proofB64 }),
});
if (replayRes.status !== 402) fail(`Expected 402, got ${replayRes.status}`);
const replayBody = await replayRes.json() as { error: string };
if (!replayBody.error?.includes('txHash already used')) fail(`Expected replay error, got: ${replayBody.error}`);
pass(`Replay blocked: ${replayBody.error}`);

// ════════════════════════════════════════════════════════════════════════════════
// Phase 7: Inference with balance → 200 + SSE stream
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[7] POST /infer — with balance (expect 200 + stream)');

const inferRes = await fetch(`${BASE_URL}/infer`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({ prompt: PROMPT, walletAddress: WALLET }),
});

// 502 is expected in --local mode (AI binding can't run locally)
if (inferRes.status === 502) {
  pass('Status: 502 — AI binding unavailable in local mode (expected)');
} else if (inferRes.status !== 200) {
  const err = await inferRes.text();
  fail(`Expected 200 or 502, got ${inferRes.status}: ${err}`);
} else {
  pass(`Status: 200, X-Balance: ${inferRes.headers.get('X-Balance')}`);
  if (inferRes.body) {
    const reader = inferRes.body.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    pass(`SSE stream received (${output.length} chars)`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Phase 8: Balance + History verification
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[8] Balance + history checks');

const inferSucceeded = inferRes.status === 200;

const balRes = await fetch(`${BASE_URL}/balance`, { headers: authHeaders() });
const bal = await balRes.json() as { balance: number; totalDepositedMicroUSDC: number; totalSpentMicroUSDC: number; totalRequests: number };
pass(`Balance: ${bal.balance} µUSDC (deposited: ${bal.totalDepositedMicroUSDC}, spent: ${bal.totalSpentMicroUSDC}, requests: ${bal.totalRequests})`);
if (bal.totalDepositedMicroUSDC !== 1000) fail(`Expected 1000 deposited, got ${bal.totalDepositedMicroUSDC}`);
pass('Credit accounting correct');

const histRes = await fetch(`${BASE_URL}/history`, { headers: authHeaders() });
const hist = await histRes.json() as { history: Array<{ role: string; content: string; meta?: unknown }> };
if (inferSucceeded) {
  if (hist.history.length < 2) fail(`Expected at least 2 messages in history, got ${hist.history.length}`);
  if (hist.history[0].role !== 'user') fail('First history message should be user');
  if (hist.history[1].role !== 'assistant') fail('Second history message should be assistant');
  pass(`History: ${hist.history.length} messages (user + assistant)`);
} else {
  pass(`History: ${hist.history.length} messages (inference was skipped in local mode)`);
}

// ════════════════════════════════════════════════════════════════════════════════
// Phase 9: Clear history
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n[9] DELETE /history');

const clearRes = await fetch(`${BASE_URL}/history`, { method: 'DELETE', headers: authHeaders() });
if (clearRes.status !== 200) fail(`Expected 200, got ${clearRes.status}`);
const afterClear = await fetch(`${BASE_URL}/history`, { headers: authHeaders() });
const afterHist = await afterClear.json() as { history: unknown[] };
if (afterHist.history.length !== 0) fail(`Expected empty history, got ${afterHist.history.length}`);
pass('History cleared');

console.log('\n✅  All 9 phases passed.\n');
