# Credits, µUSDC, and Neurons — Billing Model

## Unit Relationships

```
1 USDC  =  1,000,000 µUSDC  =  1,000,000 credits
1 credit =  1 µUSDC          =  $0.000001
```

**Credits** and **µUSDC** (micro-USDC) are the same thing — one credit equals one millionth of a USDC. The term "credits" is used in the UI to keep things simple; the backend stores and operates on µUSDC integers.

## How Users Add Credits

Users send USDC on Base Mainnet to the payment address. The minimum top-up is **0.001 USDC = 1,000 credits**. The transfer amount is verified on-chain via RPC and credited atomically to the wallet's Durable Object balance.

| USDC Sent | Credits Added |
|-----------|--------------|
| 0.001     | 1,000        |
| 0.005     | 5,000        |
| 0.01      | 10,000       |
| 0.05      | 50,000       |
| 1.00      | 1,000,000    |

## Cloudflare Neurons

**Neurons** are Cloudflare's billing unit for Workers AI inference. Cloudflare charges **$0.011 per 1 million neurons consumed**. Each model has published rates for how many neurons it consumes per 1 million input/output tokens:

| Model | Neurons per 1M Input Tokens | Neurons per 1M Output Tokens |
|-------|----------------------------|------------------------------|
| Llama 3.1 8B | 25,608 | 75,147 |
| Llama 3.3 70B | 26,668 | 204,805 |
| Gemma 3 12B | 25,608 | 75,147 |
| Mistral 7B | 10,000 | 17,300 |
| DeepSeek R1 32B | 45,170 | 443,756 |

Output tokens are significantly more expensive than input tokens for all models. Larger models (70B, 32B) have disproportionately higher output costs.

## The Billing Formula

After each inference request, the server computes the cost as:

```
neurons         = (prompt_tokens × rate_in + completion_tokens × rate_out) / 1,000,000
raw_neuron_cost = neurons × 0.011
cogs            = raw_neuron_cost + 6
cost_credits    = max(1, ceil(cogs / (1 − 0.15)))
```

The formula has three components:

1. **Raw neuron cost** — `neurons × 0.011` is the direct Cloudflare cost. The constant **0.011** converts neurons to µUSDC, derived from Cloudflare's $0.011 per 1M neurons pricing.

2. **Infrastructure overhead** — **6 µUSDC** (`OVERHEAD_MICRO_USDC`) covers Durable Object storage writes (balance updates, history appends, rate-limit counters) which cost ~5.2 µUSDC per request regardless of model.

3. **Target margin** — Dividing by **(1 − 0.15)** targets a **15% gross margin** (`TARGET_MARGIN`) on every request. Both constants are configurable in `src/constants.ts`.

There is a safety floor of **1 credit minimum**, though in practice the overhead alone guarantees a minimum of 8 credits per request.

## Worked Examples

### Example 1: Short question on Llama 3.1 8B

- Input: 200 tokens, Output: 150 tokens
- Neurons: (200 × 25,608 + 150 × 75,147) / 1,000,000 = **16.39 neurons**
- Raw neuron cost: 16.39 × 0.011 = 0.18 µUSDC
- COGS: 0.18 + 6 = 6.18 µUSDC
- Cost: ceil(6.18 / 0.85) = **8 credits**

### Example 2: Multi-turn conversation on Llama 3.3 70B

- Input: 2,000 tokens (prompt + history), Output: 800 tokens
- Neurons: (2,000 × 26,668 + 800 × 204,805) / 1,000,000 = **217.18 neurons**
- Raw neuron cost: 217.18 × 0.011 = 2.39 µUSDC
- COGS: 2.39 + 6 = 8.39 µUSDC
- Cost: ceil(8.39 / 0.85) = **10 credits**

### Example 3: Long reasoning on DeepSeek R1 32B

- Input: 1,500 tokens, Output: 2,000 tokens (chain-of-thought)
- Neurons: (1,500 × 45,170 + 2,000 × 443,756) / 1,000,000 = **955.27 neurons**
- Raw neuron cost: 955.27 × 0.011 = 10.51 µUSDC
- COGS: 10.51 + 6 = 16.51 µUSDC
- Cost: ceil(16.51 / 0.85) = **20 credits**

## Typical Cost Per Request

| Model | Typical Range | Notes |
|-------|--------------|-------|
| Llama 3.1 8B | 8–10 credits | Fast, cheap general purpose |
| Llama 3.3 70B | 9–13 credits | Higher quality, 2.7× output cost |
| Gemma 3 12B | 8–10 credits | Same rates as Llama 8B |
| Mistral 7B | ~8 credits | Cheapest model available |
| DeepSeek R1 32B | 10–20 credits | Expensive output (chain-of-thought) |

## Token Count Fallback

Workers AI sometimes returns zero token counts in the SSE stream. When this happens, the server falls back to character-count estimation:

```
estimated_tokens = ceil(character_count / 4)
```

This uses the standard approximation that 1 token ≈ 4 characters in English text. The fallback is applied independently to input and output.

## Summary

```
User pays USDC on Base  →  credited as µUSDC (= credits) in DO storage
                                         ↓
Request runs inference   →  Workers AI consumes neurons
                                         ↓
(neuron_cost + overhead) →  divided by (1 − margin)
         / (1 − 0.15)   →  credits deducted from balance
```

The system prices each request to cover both Cloudflare's neuron cost and Durable Object infrastructure overhead, with a configurable target gross margin (default 15%). Both `OVERHEAD_MICRO_USDC` and `TARGET_MARGIN` can be adjusted in `src/constants.ts`.
