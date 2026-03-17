# COGS, Revenue & Gross Margin Analysis

## Overview

Dox402 operates as an **inference gateway** — users pay USDC on Base Mainnet, the system converts payments into tokens, and tokens are consumed per request. The pricing formula accounts for both variable neuron costs and fixed infrastructure overhead, targeting a **15% gross margin** on every request.

---

## Revenue

Revenue comes from a single source: **USDC deposits from users**.

Users send USDC on Base Mainnet to the payment address. The transfer is verified on-chain and credited atomically to their Durable Object balance.

```
Revenue per deposit = USDC transfer amount
```

There is no subscription, no tiered pricing, and no premium features. Revenue equals total USDC deposited across all users.

---

## Cost of Goods Sold (COGS)

COGS consists of three components, listed by magnitude:

### 1. Workers AI Inference (dominant cost)

Cloudflare charges **$0.011 per 1,000,000 neurons consumed**. Each model has different neuron consumption rates per token:

| Model | Neurons / 1M Input Tokens | Neurons / 1M Output Tokens | Output : Input Ratio |
|-------|--------------------------|---------------------------|---------------------|
| Mistral 7B | 10,000 | 17,300 | 1.7× |
| Llama 3.1 8B | 25,608 | 75,147 | 2.9× |
| Gemma 3 12B | 25,608 | 75,147 | 2.9× |
| Llama 3.3 70B | 26,668 | 204,805 | 7.7× |
| DeepSeek R1 32B | 45,170 | 443,756 | 9.8× |

**Cost per request** depends on model choice and token volume. Typical range:

| Model | Typical Cost (µUSDC) | Typical Cost (USD) |
|-------|---------------------|--------------------|
| Mistral 7B | ~1 | $0.000001 |
| Llama 3.1 8B | 1–3 | $0.000001–$0.000003 |
| Gemma 3 12B | 1–3 | $0.000001–$0.000003 |
| Llama 3.3 70B | 2–4 | $0.000002–$0.000004 |
| DeepSeek R1 32B | 2–11 | $0.000002–$0.000011 |

### 2. Durable Objects (storage + compute)

Cloudflare Durable Objects pricing:

| Component | Rate | Notes |
|-----------|------|-------|
| Requests | $0.15 / million | Each /infer, /balance, /deposit, /history call |
| Duration | $12.50 / million GB-seconds | Wall-clock time the DO is active |
| Storage (rows read) | $0.001 / million | SQLite reads for balance, history, rate-limit |
| Storage (rows written) | $1.00 / million | Balance updates, history appends, rate-limit counters |
| Stored data | $0.20 / GB-month | Persistent storage for all wallet data |

**Per-request DO overhead estimate** (for a typical /infer request):
- ~6 storage reads (balance, history, rate-limit key, totalSpent, totalRequests, lastUsedAt)
- ~5 storage writes (balance, history, totalSpent, totalRequests, lastUsedAt)
- DO request cost: $0.00000015
- Storage reads: $0.000000006
- Storage writes: $0.000005
- **Total DO overhead per request: ~$0.0000052**
- In µUSDC: ~5.2 µUSDC

### 3. Workers (edge compute)

| Component | Rate | Notes |
|-----------|------|-------|
| Requests | $0.30 / million | The edge Worker handling routing, auth, CORS |
| CPU time | $0.02 / million ms | SIWE verification, JSON parsing, token validation |

**Per-request Workers overhead: ~$0.0000003** (negligible)

### 4. Workers AI Embeddings (RAG document upload)

When users upload documents for RAG, the text is chunked and embedded using `@cf/baai/bge-base-en-v1.5`:

| Metric | Value |
|--------|-------|
| Neuron rate | 6,058 neurons / 1M input tokens |
| Cost per 1M tokens | $0.011 × 6,058 / 1M = ~$0.000067 |
| Typical 10KB document (~2,500 tokens) | ~0.015 neurons → ~1 µUSDC after margin |
| Typical RAG query embedding (~50 tokens) | negligible → ~1 µUSDC (minimum) |

Embedding cost is billed upfront at document upload. The RAG query embedding cost is added to the inference bill.

### 5. Cloudflare Vectorize (RAG vector storage)

| Component | Rate | Notes |
|-----------|------|-------|
| Storage | $0.05 / 100M stored dimensions | Free tier: 5M dims/month |
| Queries | $0.01 / 1M queried dimensions | Free tier: 30M dims/month |

Per document (10KB → ~7 chunks × 768 dims): 5,376 stored dimensions.
Per RAG query (1 query × 768 dims): ~768 queried dimensions.

At typical scale, **Vectorize costs are well within the free tier** and negligible.

### Free Tier Offsets

Cloudflare Workers paid plan ($5/month) includes generous free allowances:

| Component | Included Free |
|-----------|--------------|
| Workers requests | 10 million / month |
| DO requests | 1 million / month |
| DO duration | 400,000 GB-seconds / month |
| DO storage reads | 50 million / month |
| DO storage writes | 1 million / month |
| DO stored data | 1 GB |
| Workers AI neurons | 10,000 / day |

At low-to-moderate usage, **the free tier covers most or all operational costs**.

---

## Gross Margin Analysis

### Pricing Formula

The billing formula accounts for both variable neuron cost and fixed infrastructure overhead, with a configurable target margin:

```
OVERHEAD_MICRO_USDC = 6       // DO + Workers overhead per request
TARGET_MARGIN       = 0.15    // 15% target gross margin

price = ceil((raw_neuron_cost + OVERHEAD) / (1 − TARGET_MARGIN))
```

This guarantees at least 15% gross margin on every request, regardless of model or token volume.

### Margin by Model at Realistic Usage

For a "typical" request (500 input tokens, 300 output tokens):

| Model | Revenue (tokens) | Neuron COGS | DO COGS | Total COGS | Gross Margin |
|-------|-------------------|-------------|---------|------------|-------------|
| Mistral 7B | 8 | 0.07 | 5.2 | 5.3 | +34% |
| Llama 3.1 8B | 8 | 0.39 | 5.2 | 5.6 | +30% |
| Gemma 3 12B | 8 | 0.39 | 5.2 | 5.6 | +30% |
| Llama 3.3 70B | 9 | 0.82 | 5.2 | 6.0 | +33% |
| DeepSeek R1 32B | 10 | 1.72 | 5.2 | 6.9 | +31% |

At higher token volumes (2,000 input, 800 output):

| Model | Revenue (tokens) | Neuron COGS | DO COGS | Total COGS | Gross Margin |
|-------|-------------------|-------------|---------|------------|-------------|
| Mistral 7B | 8 | 0.37 | 5.2 | 5.6 | +30% |
| Llama 3.1 8B | 9 | 1.22 | 5.2 | 6.4 | +29% |
| Llama 3.3 70B | 10 | 2.39 | 5.2 | 7.6 | +24% |
| DeepSeek R1 32B | 20 | 10.51 | 5.2 | 15.7 | +22% |

**All models and usage levels achieve positive margin.** The formula automatically scales — cheap requests are dominated by the overhead component (yielding higher margin), while expensive requests approach the 15% floor.

---

## Configurable Pricing

The pricing formula uses two constants in `src/constants.ts`:

```typescript
OVERHEAD_MICRO_USDC = 6     // estimated DO + Workers overhead per request
TARGET_MARGIN       = 0.15  // target gross margin (15%)
```

**To adjust pricing**, change these values and redeploy:

| TARGET_MARGIN | Llama 8B (typical) | DeepSeek R1 (heavy) | Effect |
|---------------|-------------------|---------------------|--------|
| 0.10 | 8 tokens | 19 tokens | Thinner margin, cheaper for users |
| 0.15 (current) | 8 tokens | 20 tokens | Balanced |
| 0.25 | 9 tokens | 22 tokens | Higher margin, more headroom |
| 0.50 | 13 tokens | 33 tokens | Premium pricing |

---

## Unit Economics Summary

| Metric | Value |
|--------|-------|
| Revenue per request | 8–20 µUSDC ($0.000008–$0.000020) |
| Inference COGS per request | 0.07–10.51 µUSDC |
| DO overhead per request | ~5.2 µUSDC |
| Workers overhead per request | ~0.3 µUSDC |
| **Total COGS per request** | **5.3–15.7 µUSDC** |
| **Gross margin per request** | **+15% to +34%** |
| Embedding COGS per document upload | ~1–2 µUSDC |
| RAG query COGS per inference | ~1 µUSDC (embedding) + model-dependent context cost |
| Vectorize storage/query | negligible at current scale |
| Fixed costs per month | ~$6.00 |

---

## RAG Cost Impact

RAG adds two cost components to inference:

| Component | Per Request | Per Upload |
|-----------|-------------|------------|
| RAG query embedding (prompt) | ~1 µUSDC | — |
| Extra LLM input tokens (RAG context) | variable, depends on document size and model | — |
| Document embedding (all chunks) | — | ~1–2 µUSDC per 10KB |
| Vectorize storage/query | negligible | negligible |

**RAG-on vs RAG-off margin comparison** (Llama 3.1 8B, 500 input + 300 output tokens):

| Mode | Input Tokens | Revenue | Total COGS | Gross Margin |
|------|-------------|---------|------------|-------------|
| RAG off | 500 | 8 µUSDC | 5.6 µUSDC | +30% |
| RAG on (small doc) | ~2,500 (incl. context) | 10 µUSDC | 7.4 µUSDC | +26% |
| RAG on (large docs) | ~5,000 (incl. context) | 12 µUSDC | 9.2 µUSDC | +23% |

RAG context is no longer hard-capped; the total input (prompt + history + files) is validated against each model's context window (e.g. 7,968 tokens for Llama 3.1 8B, 80,000 for DeepSeek R1 32B). The pricing formula automatically adjusts — higher input token counts produce proportionally higher revenue, maintaining positive margin.

---

## Key Takeaway

The margin-targeting formula `price = ceil((neuron_cost + overhead) / (1 − margin))` ensures every request is profitable. The dominant cost for cheap models is Durable Object overhead (~5.2 µUSDC), not inference. By explicitly accounting for this overhead and applying a configurable margin, the system is sustainable at any scale. A 1,000-token deposit ($0.001 USDC) buys ~125 requests on cheap models — the product remains extremely inexpensive.
