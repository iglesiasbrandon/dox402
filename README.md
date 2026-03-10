# inference-gate

Edge-native, accountless, pay-per-use AI inference using Cloudflare Durable Objects + the x402 payment protocol.

**Flow:** Client → POST /infer → 402 + `PAYMENT-REQUIRED` header → client pays on-chain (USDC on Base) → retries with `PAYMENT-SIGNATURE` header → streamed AI output.

No signup. No API key. No custody of funds.

---

## Prerequisites

```bash
# Authenticate with Cloudflare (required for Workers AI, even in local dev)
npx wrangler login
```

Workers AI calls are remote even during local development — you need a Cloudflare account with Workers AI access.

---

## Local Development

```bash
npm install
npx wrangler dev          # starts on http://localhost:8787
```

In a second terminal, run the 5-phase mock proof test:

```bash
npx ts-node --esm test/client.ts
```

The client tests all 4 success criteria without any real on-chain payment (mock proof, testnet only).

---

## Deploy to Cloudflare

```bash
# Set production secrets (use wrangler secret, not vars)
npx wrangler secret put PAYMENT_ADDRESS   # your USDC-receiving wallet
npx wrangler secret put BASE_RPC_URL      # e.g. https://sepolia.base.org

npx wrangler deploy

# Verify
curl https://<worker>.workers.dev/health
curl 'https://<worker>.workers.dev/balance?wallet=0x<address>'
```

---

## API

### `POST /infer`
Body: `{ prompt: string, walletAddress: string, maxTokens?: number }`

- No credits → `402` + `PAYMENT-REQUIRED: <base64 PaymentRequired>` + JSON body
- Valid `PAYMENT-SIGNATURE` header → `200` + `text/event-stream` SSE
- Invalid wallet → `400`

### `GET /balance?wallet=0x...`
Returns: `{ credits, totalPurchased, totalUsed }`

### `GET /health`
Returns: `{ status: "ok" }`

---

## Payment Headers (x402 spec)

| Header | Direction | Content |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | Server → Client | base64-encoded `PaymentRequired` JSON |
| `PAYMENT-SIGNATURE` | Client → Server | base64-encoded `PaymentProof` JSON |

---

## Architecture

- **Durable Object** (`InferenceGate`): one instance per wallet address. Holds credit balance and seen-txHash keys in strongly-consistent storage. All credit updates happen inside `storage.transaction()` to prevent race conditions.
- **Worker** (`index.ts`): validates wallet address format, routes to the correct DO instance.
- **Replay prevention**: each payment hash stored as `seen:{txHash} = timestamp` (individual keys — O(1) lookup, no array read).
- **Verification**: Tier 1 only (structural checks). Tier 2 on-chain RPC verification is marked with TODO comments.

---

## Known Limitations (MVP)

| Limitation | Impact | Post-MVP fix |
|-----------|--------|-------------|
| Tier 1 verification only | Proof can be fabricated on testnet | Add Base RPC receipt check in `verifyProof()` |
| No credit refund on AI failure | User loses credit on Workers AI 5xx | Restore credit in catch block, add idempotency key |
| Wallet address is client-supplied | No proof caller owns the wallet | Require EIP-191 signed request body |
| Single model, fixed params | No flexibility for callers | Accept model and temperature in request body |
| No streaming backpressure | Large responses may hit CF limits | Add chunked streaming with heartbeat keepalive |
