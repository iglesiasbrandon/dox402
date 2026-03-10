# dox402

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

Ensure `.dev.vars` contains:
```
PAYMENT_ADDRESS=0x...
BASE_RPC_URL=https://mainnet.base.org
MOCK_PAYMENTS=true
SESSION_SECRET=<any-hex-string>
```

In a second terminal, run the 9-phase end-to-end test:

```bash
npx ts-node --esm test/client.ts
```

The test client generates a random wallet, signs SIWE messages programmatically using `@noble/curves`, authenticates, deposits with a mock proof, runs inference, and verifies balance/history.

---

## Deploy to Cloudflare

```bash
# Set production secrets (use wrangler secret, not vars)
npx wrangler secret put PAYMENT_ADDRESS   # your USDC-receiving wallet
npx wrangler secret put BASE_RPC_URL      # e.g. https://mainnet.base.org
npx wrangler secret put SESSION_SECRET    # generate with: openssl rand -hex 32

npx wrangler deploy

# Verify
curl https://<worker>.workers.dev/health
```

---

## API

All authenticated endpoints require `Authorization: Bearer <token>` (obtained via SIWE login).

### Public
| Endpoint | Description |
|---|---|
| `GET /health` | Liveness probe |
| `GET /payment-info` | Payment address + network details |

### Auth (SIWE)
| Endpoint | Description |
|---|---|
| `GET /auth/nonce?wallet=0x...` | Generate one-time nonce |
| `POST /auth/login` | Verify SIWE signature → JWT |

### Authenticated
| Endpoint | Description |
|---|---|
| `POST /infer` | Run inference (post-billed from balance) |
| `POST /deposit` | Top-up balance with payment proof |
| `GET /balance` | Credit balance + usage stats |
| `GET /history` | Conversation messages + metadata |
| `DELETE /history` | Clear conversation |

---

## Payment Headers (x402 spec)

| Header | Direction | Content |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | Server → Client | base64-encoded `PaymentRequired` JSON |
| `PAYMENT-SIGNATURE` | Client → Server | base64-encoded `PaymentProof` JSON |

---

## Architecture

- **Durable Object** (`Dox402`): one instance per wallet address. Holds credit balance and seen-txHash keys in strongly-consistent storage. All credit updates happen inside `storage.transaction()` to prevent race conditions.
- **Worker** (`index.ts`): validates wallet address format, routes to the correct DO instance.
- **Replay prevention**: each payment hash stored as `seen:{txHash} = timestamp` (individual keys — O(1) lookup, no array read).
- **Authentication**: SIWE (EIP-4361) proves wallet ownership; stateless HMAC-SHA256 JWTs for session management.
- **Verification**: Tier 1 structural checks + Tier 2 on-chain RPC receipt verification via `eth_getTransactionReceipt`.

---

## Known Limitations

| Limitation | Impact | Tracked |
|-----------|--------|---------|
| No credit refund on AI failure | User loses credit on Workers AI 5xx | [#1](https://github.com/iglesiasbrandon/dox402/issues/1) |
| No streaming backpressure | Large responses may hit CF limits | [#2](https://github.com/iglesiasbrandon/dox402/issues/2) |
| RPC failure rejects valid payments | No graceful fallback on RPC downtime | [#3](https://github.com/iglesiasbrandon/dox402/issues/3) |
