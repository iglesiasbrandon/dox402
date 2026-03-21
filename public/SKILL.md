---
name: dox402-inference-api
description: Pay-per-use AI inference gateway using x402 payment protocol on Base Mainnet
---

# dox402 -- Pay-Per-Use AI Inference API

Base URL: `https://inference-gate.iglesias-brandon.workers.dev`

## What This Service Does

A payment-gated AI inference API built on Cloudflare Workers and Durable Objects. No signup, no API key -- authenticate with your Ethereum wallet, pay with USDC on Base Mainnet, and get AI responses. Each wallet gets isolated token balance, conversation history, and rate limiting via per-wallet Durable Objects with embedded SQLite storage.

## Quick Start (for Agents)

1. **Get a nonce:** `GET /auth/nonce?wallet=0xYOUR_ADDRESS`
2. **Sign:** Construct an EIP-4361 (SIWE) message with the nonce, sign with `personal_sign`
3. **Login:** `POST /auth/login` with `{message, signature}` -- returns `{token, expiresAt}` in response body
4. **Infer:** `POST /infer` with `Authorization: Bearer <token>` and `Accept: application/json` for synchronous JSON response, or omit Accept header for SSE streaming
5. **Handle 402:** If balance is zero, you get a 402 with payment instructions. Send USDC, construct a proof, and retry.

## Authentication

Three methods, ordered by agent preference:

**1. Bearer Token (recommended for agents):**
POST to `/auth/login` with a signed SIWE message. The response body contains `{token, expiresAt}`. Use the token as `Authorization: Bearer <token>` on all subsequent requests. Token is valid for 24 hours.

**2. SIWX (single-request, stateless):**
Include a `SIGN-IN-WITH-X` header with a base64-encoded payload containing `{message, signature, chainId, type, address}`. Authenticates a single request without a separate login step. The server returns a session cookie and `X-Session-Expires` header for subsequent requests.

**3. Cookie (browser clients):**
After login via either method, the server also sets an `ig_session` HttpOnly cookie. Browser clients use this automatically.

## Response Modes

**`POST /infer`** supports two output modes via the `Accept` header:

| Accept Header | Response | Best For |
|--------------|----------|----------|
| `application/json` | Single JSON object: `{response, usage, cost, model, balance}` | Agents, API clients |
| `text/event-stream` (or omitted) | SSE stream with heartbeat keepalive | Browsers, real-time UI |

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | None | Liveness probe |
| GET | /payment-info | None | Payment address, network, USDC contract |
| GET | /auth/nonce | None | Generate one-time nonce (query: `wallet`) |
| POST | /auth/login | None | Verify SIWE signature, returns `{token, expiresAt}` + sets cookie |
| POST | /auth/logout | Bearer/Cookie | Clear session cookie |
| POST | /infer | Bearer/Cookie/SIWX | AI inference (JSON or SSE, see Accept header) |
| POST | /deposit | Bearer/Cookie | Top up balance with payment proof |
| GET | /balance | Bearer/Cookie | Token balance and usage stats |
| GET | /history | Bearer/Cookie | Conversation messages |
| DELETE | /history | Bearer/Cookie | Clear conversation |
| POST | /documents | Bearer/Cookie | Upload document for RAG |
| GET | /documents | Bearer/Cookie | List uploaded documents |
| DELETE | /documents/:id | Bearer/Cookie | Delete document + embeddings |
| POST | /documents/reindex | Bearer/Cookie | Re-upsert all document vectors |

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

## Agent Integration Guide

### Python: Full Autonomous Flow

```python
import requests
from eth_account import Account
from eth_account.messages import encode_defunct
import json, base64, time

BASE = "https://inference-gate.iglesias-brandon.workers.dev"
PRIVATE_KEY = "0x..."  # Agent's private key
WALLET = Account.from_key(PRIVATE_KEY).address

# 1. Get nonce
nonce = requests.get(f"{BASE}/auth/nonce?wallet={WALLET}").json()["nonce"]

# 2. Construct & sign SIWE message
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
message = (
    f"inference-gate.iglesias-brandon.workers.dev wants you to sign in with your Ethereum account:\n"
    f"{WALLET}\n\n"
    f"Sign in to dox402 inference gateway\n\n"
    f"URI: https://inference-gate.iglesias-brandon.workers.dev\n"
    f"Version: 1\n"
    f"Chain ID: 8453\n"
    f"Nonce: {nonce}\n"
    f"Issued At: {now}"
)
sig = Account.sign_message(encode_defunct(text=message), PRIVATE_KEY).signature.hex()

# 3. Login — get Bearer token from response body
login = requests.post(f"{BASE}/auth/login", json={"message": message, "signature": f"0x{sig}"})
token = login.json()["token"]
headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

# 4. Infer (synchronous JSON response)
resp = requests.post(f"{BASE}/infer", headers=headers, json={
    "prompt": "What is x402?",
    "walletAddress": WALLET,
})

if resp.status_code == 200:
    data = resp.json()
    print(data["response"])         # AI-generated text
    print(f"Cost: {data['cost']} tokens, Balance: {data['balance']}")
elif resp.status_code == 402:
    print("Need to pay — see resp.json() for payment instructions")
```

### curl: Bearer Token + JSON Response

```bash
# Login and extract token
TOKEN=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"message":"...","signature":"0x..."}' | jq -r .token)

# Infer with JSON response (not SSE)
curl -s -X POST $BASE/infer \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello","walletAddress":"0x..."}'
```

### JSON Response Format

When using `Accept: application/json`, `/infer` returns:

```json
{
  "response": "The generated text...",
  "usage": { "prompt_tokens": 42, "completion_tokens": 128 },
  "cost": 9,
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "balance": 99991
}
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
