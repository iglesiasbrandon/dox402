---
name: dox402-inference-api
description: Pay-per-use AI inference gateway using x402 payment protocol on Base Mainnet
---

# dox402 -- Pay-Per-Use AI Inference API

Base URL: `https://inference-gate.iglesias-brandon.workers.dev`

## What This Service Does

A payment-gated AI inference API built on Cloudflare Workers and Durable Objects. No signup, no API key -- authenticate with your Ethereum wallet, pay with USDC on Base Mainnet, and get streamed AI responses. Each wallet gets isolated credit balance, conversation history, and rate limiting via per-wallet Durable Objects with embedded SQLite storage.

## Quick Start

1. **Get a nonce:** `GET /auth/nonce?wallet=0xYOUR_ADDRESS`
2. **Sign:** Construct an EIP-4361 (SIWE) message with the nonce, sign with `personal_sign`
3. **Login:** `POST /auth/login` with `{message, signature}` -- session cookie set automatically (24h)
4. **Check balance:** `GET /balance` (cookie-based auth)
5. **Infer:** `POST /infer` with `{prompt, walletAddress}` -- if balance is 0, you get a 402 with payment instructions

## Authentication

Three methods:

**SIWE (recommended for repeated use):**
Request a nonce, sign an EIP-4361 message, POST to /auth/login. The server sets an HttpOnly `ig_session` cookie valid for 24 hours. All subsequent requests are authenticated via this cookie automatically.

**SIWX (single-request, for x402 clients):**
Include a `SIGN-IN-WITH-X` header with a base64-encoded payload containing {message, signature, chainId, type, address}. The server returns a session cookie in the `Set-Cookie` header for subsequent requests.

**Cookie-based sessions:**
After login via either method, all authenticated endpoints use the `ig_session` HttpOnly cookie. No Bearer token or Authorization header needed.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | None | Liveness probe |
| GET | /payment-info | None | Payment address, network, USDC contract |
| GET | /auth/nonce | None | Generate one-time nonce (query: `wallet`) |
| POST | /auth/login | None | Verify SIWE signature, set session cookie |
| POST | /auth/logout | Cookie | Clear session cookie |
| POST | /infer | Cookie/SIWX | AI inference (SSE stream) |
| POST | /deposit | Cookie | Top up balance with payment proof |
| GET | /balance | Cookie | Credit balance and usage stats |
| GET | /history | Cookie | Conversation messages |
| DELETE | /history | Cookie | Clear conversation |

### Admin Endpoints

All admin endpoints require `Authorization: Bearer <ADMIN_SECRET>`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /admin/wallets | Admin | Paginated list of registered wallets (`?limit=&cursor=`) |
| GET | /admin/wallets/:wallet/status | Admin | Detailed DO status for a specific wallet |
| GET | /admin/stats | Admin | Total registered wallet count |
| GET | /admin/stale | Admin | Find zero-balance inactive wallets (`?inactive_days=30&max_balance=0&limit=50`) |

## Models

| Model ID | Name | Cost |
|----------|------|------|
| @cf/meta/llama-3.1-8b-instruct | Llama 3.1 8B | ~8-10 uUSDC/request |
| @cf/meta/llama-3.3-70b-instruct-fp8-fast | Llama 3.3 70B | ~9-13 uUSDC/request |
| @cf/google/gemma-3-12b-it | Gemma 3 12B | ~8-10 uUSDC/request |
| @cf/mistral/mistral-7b-instruct-v0.2 | Mistral 7B | ~4-6 uUSDC/request |
| @cf/deepseek-ai/deepseek-r1-distill-qwen-32b | DeepSeek R1 32B | ~15-25 uUSDC/request |

Default model: `@cf/meta/llama-3.1-8b-instruct`

## Payment (x402 Protocol)

1. `POST /infer` with zero balance returns **HTTP 402** with a `PAYMENT-REQUIRED` header
2. Decode the header (base64 JSON) to get payment address and amount
3. Send USDC on Base Mainnet to the payment address (minimum 0.001 USDC)
4. Construct a `PaymentProof` with txHash, from, amount, timestamp, and an EIP-191 signature
5. Base64-encode the proof and include as `PAYMENT-SIGNATURE` header on your next request, or use `POST /deposit` to top up without inference

**Payment proof fields:** `{txHash, from, amount, timestamp, signature}`

The signature is `personal_sign` over: `dox402 payment proof\ntxHash: ...\nfrom: ...\namount: ...\ntimestamp: ...`

**Grace mode:** If the Base RPC is unreachable during payment verification, the server grants provisional credit that is automatically re-verified via a background alarm. The `X-Payment-Status: provisional` header indicates grace mode was used.

## Rate Limiting

60 requests per minute per wallet. Exceeding returns 429 with `Retry-After` header.

## Example: Authenticate and Infer

```bash
# 1. Get nonce
NONCE=$(curl -s 'https://inference-gate.iglesias-brandon.workers.dev/auth/nonce?wallet=0xYOUR_WALLET' | jq -r .nonce)

# 2. Sign the SIWE message with your wallet (app-specific)

# 3. Login (cookie is set automatically via Set-Cookie header)
curl -s -c cookies.txt -X POST https://inference-gate.iglesias-brandon.workers.dev/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"message":"...signed SIWE message...","signature":"0x..."}'

# 4. Check balance
curl -s -b cookies.txt https://inference-gate.iglesias-brandon.workers.dev/balance

# 5. Run inference (streamed SSE response)
curl -N -b cookies.txt -X POST https://inference-gate.iglesias-brandon.workers.dev/infer \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain x402 in one sentence","walletAddress":"0xYOUR_WALLET"}'

# 6. Logout
curl -s -b cookies.txt -X POST https://inference-gate.iglesias-brandon.workers.dev/auth/logout
```

## Machine-Readable Specs

- OpenAPI 3.1: [/openapi.json](/openapi.json)
- A2A Agent Card: [/.well-known/agent.json](/.well-known/agent.json)
- Agents.json: [/.well-known/agents.json](/.well-known/agents.json)
