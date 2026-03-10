// Conversation history message — stored in DO storage per wallet
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  meta?: {                 // usage metadata (assistant messages only)
    cost: number;          // µUSDC charged for this response
    model: string;         // Workers AI model ID used
  };
}

// 402 payment requirements — sent in PAYMENT-REQUIRED header (base64) and response body
export interface PaymentRequired {
  version: '1';
  scheme: 'exact';
  network: string;           // 'base-mainnet' or 'base-sepolia'
  paymentAddress: string;    // USDC receiving address
  asset: 'USDC';
  amount: string;            // USDC in smallest unit (e.g. '1000' = $0.001)
  balanceMicroUSDC: number; // µUSDC added to balance per payment
  maxAgeSeconds: number;     // proof validity window in seconds
  description: string;
}

// Parsed PAYMENT-SIGNATURE header (base64-encoded JSON from client)
export interface PaymentProof {
  txHash: string;    // on-chain transaction hash
  from: string;      // payer wallet address (0x-prefixed)
  amount: string;    // USDC amount in smallest unit
  timestamp: number; // Unix seconds when proof was constructed
  signature: string; // EIP-191 signature — vestigial in Tier 1 MVP (parsed but not cryptographically verified)
}

// Deposit-only request body (top-up without inference)
export interface DepositRequest {
  walletAddress: string; // 0x-prefixed EVM address — validated against session at router; DO derives wallet from its ID
  proof: string;         // base64-encoded PaymentProof JSON
}

// Inference request body
export interface InferRequest {
  prompt: string;
  walletAddress: string; // 0x-prefixed EVM address — validated against session at router; DO derives wallet from its ID
  maxTokens?: number;    // default 512
  model?: string;        // Workers AI model ID — validated against ALLOWED_MODELS; falls back to AI_MODEL
}

// Env bindings (matches wrangler.toml)
export interface Env {
  DOX402: DurableObjectNamespace;
  AI: Ai;
  PAYMENT_ADDRESS: string;
  BASE_RPC_URL: string;
  NETWORK: string;
  MOCK_PAYMENTS?: string;  // set to "true" in local dev only — skips Tier 2 RPC check
  SESSION_SECRET: string;  // HMAC-SHA256 key for SIWE session tokens (set via wrangler secret put)
}
