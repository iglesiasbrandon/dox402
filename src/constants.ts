export const PRICE_USDC_UNITS      = '1000';                         // $0.001 USDC per payment
export const PAYMENT_MICRO_USDC    = 1000;                           // µUSDC added per payment (1 µUSDC = $0.000001)
export const MICRO_USDC_PER_NEURON = 0.011;                          // $0.011/1M neurons → 0.011 µUSDC/neuron
export const OVERHEAD_MICRO_USDC   = 6;                               // estimated DO + Workers overhead per request (µUSDC)
export const TARGET_MARGIN         = 0.15;                             // target gross margin (15%)
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

// Storage cleanup — TTL for replay-prevention and resolved pending entries
export const SEEN_TX_RETENTION_MS = 3_600_000;            // 1 hour — well beyond 5-min proof validity window
export const PENDING_TX_RETENTION_MS = 86_400_000;        // 24 hours — keep terminal pending entries for audit

// SIWX supported chains (CAIP-2 format)
export const SUPPORTED_CHAINS = [
  { chainId: 'eip155:8453', type: 'eip191' },  // Base Mainnet (EVM)
] as const;

// Neuron consumption rates per 1M tokens (from Cloudflare Workers AI pricing)
export const NEURON_RATES: Record<string, { in: number; out: number }> = {
  '@cf/meta/llama-3.1-8b-instruct':              { in: 25608,  out: 75147  },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast':    { in: 26668,  out: 204805 },
  '@cf/google/gemma-3-12b-it':                   { in: 25608,  out: 75147  },
  '@cf/mistral/mistral-7b-instruct-v0.2':        { in: 10000,  out: 17300  },
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { in: 45170,  out: 443756 },
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
