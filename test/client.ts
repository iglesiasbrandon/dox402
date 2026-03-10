/**
 * Demo client — simulates the full x402 pay-per-use flow using a mock payment proof.
 * Requires wrangler dev running on localhost:8787.
 * Run: npx ts-node --esm test/client.ts
 */
export {}; // make this file an ES module (required for top-level await)

const BASE_URL = 'http://localhost:8787';
const WALLET   = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const PROMPT   = 'In one sentence, what is a Durable Object?';

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { throw new Error(`FAIL: ${msg}`); }

// ── Phase 1: No proof, no credits → expect 402 ────────────────────────────────
console.log('\n[1] POST /infer — no payment (expect 402)');
const res1 = await fetch(`${BASE_URL}/infer`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: PROMPT, walletAddress: WALLET }),
});
if (res1.status !== 402) fail(`Expected 402, got ${res1.status}`);
pass(`Status: ${res1.status}`);

const paymentDetails = await res1.json() as Record<string, unknown>;
if (paymentDetails.version !== '1') fail('PaymentRequired JSON missing version field');
pass(`PaymentRequired body: ${JSON.stringify(paymentDetails)}`);

const prHeader = res1.headers.get('PAYMENT-REQUIRED');
if (!prHeader) fail('PAYMENT-REQUIRED header missing');
const decoded = JSON.parse(atob(prHeader!));
if (decoded.scheme !== 'exact') fail('PAYMENT-REQUIRED header decoded incorrectly');
pass(`PAYMENT-REQUIRED header present and valid`);

// ── Phase 2: Build a mock PaymentProof ────────────────────────────────────────
const mockTxHash = '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const mockProof = {
  txHash:    mockTxHash,
  from:      WALLET,
  amount:    '1000',
  timestamp: Math.floor(Date.now() / 1000),
  signature: '0xmocksignature_tier1_only',
};
const proofHeader = btoa(JSON.stringify(mockProof));
console.log(`\n[2] Mock proof built — txHash: ${mockTxHash.slice(0, 18)}...`);

// ── Phase 3: Submit proof → expect 200 + SSE stream ──────────────────────────
console.log('\n[3] POST /infer — with PAYMENT-SIGNATURE (expect 200 + stream)');
const res2 = await fetch(`${BASE_URL}/infer`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'PAYMENT-SIGNATURE': proofHeader,
  },
  body: JSON.stringify({ prompt: PROMPT, walletAddress: WALLET }),
});
if (res2.status !== 200) {
  const errBody = await res2.text();
  fail(`Expected 200, got ${res2.status}: ${errBody}`);
}
pass(`Status: ${res2.status}`);

if (res2.body) {
  const reader = res2.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  pass(`AI output (${output.length} chars): ${output.slice(0, 120).replace(/\n/g, ' ')}...`);
}

// ── Phase 4: Balance check ────────────────────────────────────────────────────
console.log('\n[4] GET /balance');
const res3 = await fetch(`${BASE_URL}/balance?wallet=${WALLET}`);
if (res3.status !== 200) fail(`Expected 200, got ${res3.status}`);
const balance = await res3.json() as { credits: number; totalPurchased: number; totalUsed: number };
pass(`Balance: ${JSON.stringify(balance)}`);
if (balance.credits !== 9)          fail(`Expected credits=9, got ${balance.credits}`);
if (balance.totalPurchased !== 10)  fail(`Expected totalPurchased=10, got ${balance.totalPurchased}`);
if (balance.totalUsed !== 1)        fail(`Expected totalUsed=1, got ${balance.totalUsed}`);
pass('Credit accounting correct');

// ── Phase 5: Replay attack — same txHash → expect 402 ────────────────────────
console.log('\n[5] POST /infer — replay same txHash (expect 402)');
const res4 = await fetch(`${BASE_URL}/infer`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'PAYMENT-SIGNATURE': proofHeader, // identical proof reused
  },
  body: JSON.stringify({ prompt: PROMPT, walletAddress: WALLET }),
});
if (res4.status !== 402) fail(`Expected 402, got ${res4.status}`);
const replayBody = await res4.json() as { error: string };
if (!replayBody.error?.includes('txHash already used')) {
  fail(`Expected replay error, got: ${JSON.stringify(replayBody)}`);
}
pass(`Status: ${res4.status} — ${replayBody.error}`);

console.log('\n✅  All 4 success criteria passed.\n');
