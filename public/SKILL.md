---
name: dox402-inference-api
description: Pay-per-use AI inference gateway using x402 payment protocol on Base Mainnet
---

# dox402 -- Pay-Per-Use AI Inference API

Base URL: `https://dox402.iglesias-brandon.workers.dev`

## What This Service Does

A payment-gated AI inference API built on Cloudflare Workers and Durable Objects. No signup, no API key -- authenticate with your Ethereum wallet, pay with USDC on Base Mainnet, and get streamed AI responses. Each wallet gets isolated credit balance, conversation history, and rate limiting.

## Quick Start

1. **Get a nonce:** `GET /auth/nonce?wallet=0xYOUR_ADDRESS`
2. **Sign:** Construct an EIP-4361 (SIWE) message with the nonce, sign with `personal_sign`
3. **Login:** `POST /auth/login` with `{message, signature}` -- receive a Bearer token (24h)
4. **Check balance:** `GET /balance` with `Authorization: Bearer <token>`
5. **Infer:** `POST /infer` with `{prompt, walletAddress}` -- if balance is 0, you get a 402 with payment instructions

## Authentication

Two methods:

**SIWE (recommended for repeated use):**
Request a nonce, sign an EIP-4361 message, POST to /auth/login, receive a JWT valid for 24 hours.

**SIWX (single-request, for x402 clients):**
Include a `SIGN-IN-WITH-X` header with a base64-encoded payload containing {message, signature, chainId, type, address}. The server returns a session token in the `X-Session-Token` response header for subsequent requests.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | None | Liveness probe |
| GET | /payment-info | None | Payment address, network, USDC contract |
| GET | /auth/nonce | None | Generate one-time nonce (query: `wallet`) |
| POST | /auth/login | None | Verify SIWE signature, issue JWT |
| POST | /infer | Bearer/SIWX | AI inference (SSE stream) |
| POST | /deposit | Bearer | Top up balance with payment proof |
| GET | /balance | Bearer | Credit balance and usage stats |
| GET | /history | Bearer | Conversation messages |
| DELETE | /history | Bearer | Clear conversation |

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

## Rate Limiting

60 requests per minute per wallet. Exceeding returns 429 with `Retry-After` header.

## Example: Authenticate and Infer

```bash
# 1. Get nonce
NONCE=$(curl -s 'https://dox402.iglesias-brandon.workers.dev/auth/nonce?wallet=0xYOUR_WALLET' | jq -r .nonce)

# 2. Sign the SIWE message with your wallet (app-specific)

# 3. Login
TOKEN=$(curl -s -X POST https://dox402.iglesias-brandon.workers.dev/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"message":"...signed SIWE message...","signature":"0x..."}' | jq -r .token)

# 4. Check balance
curl -s https://dox402.iglesias-brandon.workers.dev/balance \
  -H "Authorization: Bearer $TOKEN"

# 5. Run inference
curl -N -X POST https://dox402.iglesias-brandon.workers.dev/infer \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain x402 in one sentence","walletAddress":"0xYOUR_WALLET"}'
```

## Machine-Readable Specs

- OpenAPI 3.1: [/openapi.json](/openapi.json)
- A2A Agent Card: [/.well-known/agent.json](/.well-known/agent.json)
- Agents.json: [/.well-known/agents.json](/.well-known/agents.json)
