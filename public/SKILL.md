---
name: dox402-inference-api
description: Pay-per-use AI inference gateway using x402 payment protocol on Base Mainnet
---

# dox402 -- Pay-Per-Use AI Inference API

Base URL: `https://inference-gate.iglesias-brandon.workers.dev`

## What This Service Does

A payment-gated AI inference API built on Cloudflare Workers and Durable Objects. No signup, no API key -- authenticate with your Ethereum wallet, pay with USDC on Base Mainnet, and get streamed AI responses. Each wallet gets isolated token balance, conversation history, and rate limiting via per-wallet Durable Objects with embedded SQLite storage.

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
| POST | /infer | Cookie/SIWX | AI inference (SSE stream, optional `systemPrompt`) |
| POST | /deposit | Cookie | Top up balance with payment proof |
| GET | /balance | Cookie | Token balance and usage stats |
| GET | /history | Cookie | Conversation messages |
| DELETE | /history | Cookie | Clear conversation |
| POST | /documents | Cookie | Upload document for RAG (embedding deducted from balance) |
| GET | /documents | Cookie | List uploaded documents |
| DELETE | /documents/:id | Cookie | Delete document + embeddings |
| POST | /documents/reindex | Cookie | Re-upsert all document vectors |

## Models

| Model ID | Name | Context Window | Cost |
|----------|------|---------------|------|
| @cf/meta/llama-3.1-8b-instruct | Llama 3.1 8B | 7,968 tokens | ~8-10 tokens/request |
| @cf/meta/llama-3.3-70b-instruct-fp8-fast | Llama 3.3 70B | 24,000 tokens | ~9-13 tokens/request |
| @cf/google/gemma-3-12b-it | Gemma 3 12B | 8,000 tokens | ~8-10 tokens/request |
| @cf/mistral/mistral-7b-instruct-v0.2 | Mistral 7B | 8,000 tokens | ~4-6 tokens/request |
| @cf/deepseek-ai/deepseek-r1-distill-qwen-32b | DeepSeek R1 32B | 80,000 tokens | ~15-25 tokens/request |

Default model: `@cf/meta/llama-3.1-8b-instruct`

## Payment (x402 Protocol)

1. `POST /infer` with zero balance returns **HTTP 402** with a `PAYMENT-REQUIRED` header
2. Decode the header (base64 JSON) to get payment address and amount
3. Send USDC on Base Mainnet to the payment address (minimum 0.001 USDC)
4. Construct a `PaymentProof` with txHash, from, amount, timestamp, and an EIP-191 signature
5. Base64-encode the proof and include as `PAYMENT-SIGNATURE` header on your next request, or use `POST /deposit` to top up without inference

**Payment proof fields:** `{txHash, from, amount, timestamp, signature}`

The signature is `personal_sign` over: `dox402 payment proof\ntxHash: ...\nfrom: ...\namount: ...\ntimestamp: ...`

**Grace mode:** If the Base RPC is unreachable during payment verification, the server grants provisional tokens that are automatically re-verified via a background alarm. The `X-Payment-Status: provisional` header indicates grace mode was used.

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

## RAG (Retrieval-Augmented Generation)

Upload text documents to create a per-wallet knowledge base. Documents are chunked, embedded via Workers AI (`bge-base-en-v1.5`), and stored in Cloudflare Vectorize. When `useRag: true` is set on `/infer` requests, relevant document chunks are retrieved and injected as system context.

**Upload:** `POST /documents` with `{title, content}` — content is plain text, max 100KB, max 50 documents per wallet. Embedding cost is deducted from balance at upload.

**Query:** Set `useRag: true` in your `/infer` request body. The prompt is embedded, matched against your documents via cosine similarity (top-5 chunks, min score 0.45), and injected as a system message. Total input (prompt + history + RAG context) is validated against the selected model's context window — the server returns 413 if the limit is exceeded. RAG failure is non-fatal — inference proceeds without context.

**Delete:** `DELETE /documents/:id` removes the document and its Vectorize embeddings.

**Supported file types (UI):** `.pdf`, `.docx`, `.txt`, `.md`, `.csv`, `.json`, `.html` — parsed client-side (pdf.js for PDFs, mammoth.js for DOCX), sent as plain text.

## Machine-Readable Specs

- OpenAPI 3.1: [/openapi.json](/openapi.json)
- A2A Agent Card: [/.well-known/agent.json](/.well-known/agent.json)
- Agents.json: [/.well-known/agents.json](/.well-known/agents.json)
