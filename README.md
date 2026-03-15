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
ADMIN_SECRET=dev-admin-secret-for-local-testing
```

Run unit tests (no server needed):

```bash
npm test
```

Run the 9-phase end-to-end test (requires running dev server):

```bash
npm run test:e2e
```

The E2E test generates a random wallet, signs SIWE messages programmatically using `@noble/curves`, authenticates, deposits with a mock proof, runs inference, and verifies balance/history.

---

## Deploy to Cloudflare

```bash
# Set production secrets (use wrangler secret, not vars)
npx wrangler secret put PAYMENT_ADDRESS   # your USDC-receiving wallet
npx wrangler secret put BASE_RPC_URL      # e.g. https://mainnet.base.org
npx wrangler secret put SESSION_SECRET    # generate with: openssl rand -hex 32
npx wrangler secret put ADMIN_SECRET      # generate with: openssl rand -hex 32

npx wrangler deploy

# Verify
curl https://<worker>.workers.dev/health
```

---

## API

Authenticated endpoints accept either an `Authorization: Bearer <token>` header or an `ig_session` HttpOnly cookie (both obtained via SIWE login).

### Public
| Endpoint | Description |
|---|---|
| `GET /health` | Liveness probe |
| `GET /payment-info` | Payment address + network details |

### Auth (SIWE)
| Endpoint | Description |
|---|---|
| `GET /auth/nonce?wallet=0x...` | Generate one-time nonce |
| `POST /auth/login` | Verify SIWE signature → session cookie + JWT |
| `POST /auth/logout` | Clear session cookie |

### Authenticated
| Endpoint | Description |
|---|---|
| `POST /infer` | Run inference (post-billed from balance, SSE stream) |
| `POST /deposit` | Top-up balance with payment proof |
| `GET /balance` | Credit balance + usage stats |
| `GET /history` | Conversation messages + metadata |
| `DELETE /history` | Clear conversation |
| `POST /documents` | Upload document for RAG (embedding cost deducted) |
| `GET /documents` | List uploaded documents |
| `DELETE /documents/:id` | Delete document + Vectorize embeddings |

### Admin (requires `ADMIN_SECRET` Bearer token)
| Endpoint | Description |
|---|---|
| `GET /admin/wallets` | Paginated wallet list from KV registry |
| `GET /admin/wallets/:wallet/status` | Detailed DO status for a specific wallet |
| `GET /admin/stats` | Total registered wallet count |
| `GET /admin/stale` | Identify zero-balance inactive wallets |

---

## Payment Headers (x402 spec)

| Header | Direction | Content |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | Server → Client | base64-encoded `PaymentRequired` JSON |
| `PAYMENT-SIGNATURE` | Client → Server | base64-encoded `PaymentProof` JSON |

---

## Architecture

- **Durable Object** (`InferenceGate`): one instance per wallet address with embedded SQLite storage. Holds credit balance, conversation history, rate limits, and replay-prevention data. All credit updates happen inside `storage.transactionSync()` to prevent race conditions. New DOs are co-located in Eastern North America (`locationHint: 'enam'`) to minimize latency to Base chain RPC providers.
- **Worker** (`index.ts`): validates wallet address format, authenticates via SIWE session tokens or SIWX headers, routes to the correct DO instance via typed RPC stubs.
- **KV Registry** (`WALLET_REGISTRY`): global index of all active wallet DO instances, updated on first use via fire-and-forget `ctx.waitUntil()` calls. Powers the admin endpoints for fleet visibility.
- **Replay prevention**: each payment hash stored in the `seen_transactions` SQL table with automatic 1-hour TTL cleanup via DO alarms.
- **Authentication**: SIWE (EIP-4361) proves wallet ownership; HMAC-SHA256 JWTs delivered as HttpOnly cookies (browser) or Bearer tokens (API). SIWX single-request auth also supported for x402 clients.
- **Verification**: Tier 1 structural checks + Tier 2 on-chain RPC receipt verification via `eth_getTransactionReceipt`. Grace mode provides provisional credit when RPC is unreachable, with automatic alarm-based re-verification.
- **Streaming**: SSE responses with heartbeat keepalive (`:keepalive` comments every 15s of inactivity) and a 2-minute max-duration guard to prevent runaway streams. Backpressure is handled naturally via `await writer.write()`.
- **Billing safeguards**: failed AI responses (empty, error JSON, stream errors) are detected and not billed — credits are only deducted for successful inference.
- **RAG (Retrieval-Augmented Generation)**: per-wallet document knowledge base powered by Cloudflare Vectorize and Workers AI embeddings (`bge-base-en-v1.5`). Documents are chunked (1600 chars, 200 char overlap), embedded, and stored in a shared Vectorize index with per-wallet metadata filtering. Opt-in via `useRag: true` on `/infer` — relevant chunks are retrieved (top-5, cosine similarity ≥ 0.65) and injected as system context. RAG failure is non-fatal.
