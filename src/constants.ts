// 1 token = 1 µUSDC = $0.000001 — tokens are the user-facing billing unit
export const PRICE_USDC_UNITS      = '1000';                         // $0.001 USDC per payment
export const PAYMENT_MICRO_USDC    = 1000;                           // tokens added per payment (1 token = 1 µUSDC = $0.000001)
export const MICRO_USDC_PER_NEURON = 0.011;                          // $0.011/1M neurons → 0.011 µUSDC/neuron
export const TARGET_MARGIN         = 0.15;                             // target gross margin (15%)

// ── Infrastructure overhead per request (µUSDC) ────────────────────────────────
// This fixed overhead absorbs platform costs that are too small to meter individually:
//   • Durable Object + Workers compute    ~5–6 µUSDC/req
//   • R2 Class A ops (PUT on upload)       $4.50/1M = 0.0045 µUSDC/op  (negligible)
//   • R2 Class B ops (GET on inference)    $0.36/1M = 0.00036 µUSDC/op (negligible)
//   • R2 storage (100KB doc × 30 days)     $0.015/GB-mo ≈ 0.0000015 µUSDC/doc-mo
//   • R2 DELETE ops                        Free
// At current scale, R2 costs are <0.01 µUSDC/req — well within the overhead budget.
// Revisit if avg document size or request volume grows significantly.
export const OVERHEAD_MICRO_USDC   = 6;
export const PROOF_MAX_AGE_SECS    = 300;                            // 5-minute proof validity window
export const MAX_HISTORY_MESSAGES  = 20;                             // max stored messages (10 exchanges)
export const MAX_TOKENS_LIMIT     = 2048;                            // server-side cap on maxTokens per request
export const RATE_LIMIT_PER_MINUTE = 60;                              // max requests per wallet per 60-second window
export const NETWORK               = 'base-mainnet';
export const USDC_CONTRACT         = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base Mainnet USDC
export const AI_MODEL              = '@cf/meta/llama-3.1-8b-instruct'; // default model

// Grace mode — provisional credit on RPC failure
export const GRACE_MAX_PROVISIONAL_MICRO_USDC = 5000;  // max outstanding provisional credit per wallet ($0.005)
export const GRACE_MAX_PENDING = 5;                      // max pending re-verifications per wallet
export const GRACE_INITIAL_RETRY_MS = 30_000;           // 30s first alarm
export const GRACE_MAX_RETRIES = 6;                      // max alarm retries before giving up (~15 min span)

// Streaming guards — heartbeat keepalive and duration limits
export const STREAM_HEARTBEAT_MS   = 15_000;     // send :keepalive every 15s of inactivity
export const STREAM_MAX_DURATION_MS = 120_000;   // hard cap: 2 minutes per inference stream

// Storage cleanup — TTL for replay-prevention and resolved pending entries
export const SEEN_TX_RETENTION_MS = 3_600_000;            // 1 hour — well beyond 5-min proof validity window
export const PENDING_TX_RETENTION_MS = 86_400_000;        // 24 hours — keep terminal pending entries for audit

// SIWX supported chains (CAIP-2 format)
export const SUPPORTED_CHAINS = [
  { chainId: 'eip155:8453', type: 'eip191' },  // Base Mainnet (EVM)
] as const;

// Neuron consumption rates per 1M tokens (from Cloudflare Workers AI pricing)
// contextWindow = max input tokens supported by the model (from Cloudflare docs)
export const NEURON_RATES: Record<string, { in: number; out: number; contextWindow: number }> = {
  '@cf/meta/llama-3.1-8b-instruct':              { in: 25608,  out: 75147,  contextWindow: 7968   },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast':    { in: 26668,  out: 204805, contextWindow: 24000  },
  '@cf/google/gemma-3-12b-it':                   { in: 25608,  out: 75147,  contextWindow: 8000   },
  '@cf/mistral/mistral-7b-instruct-v0.2':        { in: 10000,  out: 17300,  contextWindow: 8000   },
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { in: 45170,  out: 443756, contextWindow: 80000 },
};

// Allowlist of supported Workers AI text generation models.
// Keys are model IDs; values are the human-readable labels shown in the UI.
export const ALLOWED_MODELS: Record<string, string> = {
  '@cf/meta/llama-3.1-8b-instruct':               'Llama 3.1 8B',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast':      'Llama 3.3 70B',
  '@cf/google/gemma-3-12b-it':                     'Gemma 3 12B',
  '@cf/mistral/mistral-7b-instruct-v0.2':          'Mistral 7B',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b':   'DeepSeek R1 32B',
};

// ── RAG (Retrieval-Augmented Generation) configuration ────────────────────────
// Document content stored in R2 (RAG_STORAGE bucket). R2 cost analysis:
//   Storage: $0.015/GB-mo (10GB free tier). At 50 docs × 100KB avg = 5MB/wallet → free tier.
//   PUT (upload): $4.50/1M (1M free). One per document upload.
//   GET (inference): $0.36/1M (10M free). One per RAG-augmented inference.
//   DELETE: Free. One per document deletion.
export const RAG_CHUNK_CHAR_SIZE      = 1600;       // ~400 tokens at 4 chars/token
export const RAG_CHUNK_CHAR_OVERLAP   = 200;        // ~50 tokens overlap between chunks
export const RAG_TOP_K                = 5;           // top chunks retrieved per query
export const RAG_MIN_SCORE            = 0.45;        // minimum cosine similarity to include
// RAG context is no longer hard-capped; instead the total input (prompt + history + files)
// is validated against each model's contextWindow before inference.
export const RAG_MAX_DOCUMENT_SIZE    = 102_400;     // 100KB max document upload
export const RAG_MAX_DOCUMENTS        = 50;          // max documents per wallet
export const RAG_EMBEDDING_MODEL      = '@cf/baai/bge-base-en-v1.5' as const;
export const RAG_EMBEDDING_DIMENSIONS = 768;
export const RAG_EMBEDDING_BATCH_SIZE = 100;         // max texts per AI.run() call
// bge-base-en-v1.5 neuron rate: ~6,058 neurons per 1M input tokens (input-only model)
export const RAG_EMBEDDING_NEURON_RATE = 6058;
