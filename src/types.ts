// Conversation history message — stored in DO storage per wallet
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';  // 'system' used for RAG context injection
  content: string;
  meta?: {                 // usage metadata (assistant messages only)
    cost: number;          // tokens charged for this response (1 token = 1 µUSDC)
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
  balanceTokens: number;    // tokens added to balance per payment (1 token = 1 µUSDC)
  maxAgeSeconds: number;     // proof validity window in seconds
  description: string;
}

// Parsed PAYMENT-SIGNATURE header (base64-encoded JSON from client)
export interface PaymentProof {
  txHash: string;    // on-chain transaction hash
  from: string;      // payer wallet address (0x-prefixed)
  amount: string;    // USDC amount in smallest unit
  timestamp: number; // Unix seconds when proof was constructed
  signature: string; // EIP-191 personal_sign over canonical proof message (verified via ecrecover)
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
  useRag?: boolean;      // opt-in RAG augmentation — retrieves relevant document chunks as context
}

// Stored SIWE nonce — kept in an array of up to 5 per wallet
export interface StoredNonce {
  nonce: string;
  createdAt: number;
}

// SIWX (Sign-In with X) payload — decoded from SIGN-IN-WITH-X header (base64 JSON)
export interface SiwxPayload {
  message: string;       // EIP-4361 message string (for EVM)
  signature: string;     // hex-encoded signature (0x-prefixed)
  chainId: string;       // CAIP-2 chain ID, e.g. "eip155:8453"
  type: string;          // signature type, e.g. "eip191"
  address: string;       // wallet address (0x-prefixed for EVM)
}

// SIWX extension advertised in 402 responses
export interface SiwxExtension {
  supportedChains: { chainId: string; type: string }[];
  info: {
    domain: string;
    uri: string;
    version: string;
    statement: string;
    nonce: string;
    issuedAt: string;
    expirationTime: string;
  };
}

// Result from verifyProof() — may indicate a provisional (grace mode) credit
export interface VerifyProofResult {
  valid: boolean;
  reason?: string;
  amount?: number;
  /** true when Tier 1 passed but Tier 2 RPC was unreachable — caller should grant provisional credit */
  provisional?: boolean;
  /** Original proof data, echoed back when provisional — caller stores it for async re-verification */
  pendingProof?: PaymentProof;
}

// Stored in DO as `pending:{txHash}` — tracks a provisionally credited payment awaiting RPC re-verification
export interface PendingVerification {
  proof: PaymentProof;
  creditedAmount: number;       // tokens provisionally added to balance
  createdAt: number;            // Date.now() when grace mode activated
  retryCount: number;           // number of alarm-based re-verification attempts so far
  status: 'pending' | 'confirmed' | 'reversed' | 'expired';
  lastAttemptAt?: number;       // Date.now() of most recent re-verification attempt
  lastError?: string;           // most recent RPC error message
}

// Admin status response from a single DO instance
export interface AdminWalletStatus {
  walletAddress: string;
  balance: number;
  totalDeposited: number;
  totalSpent: number;
  totalRequests: number;
  totalFailedRequests: number;
  provisionalBalance: number;
  lastUsedAt: number | null;
  historyCount: number;
  pendingCount: number;
  nonceCount: number;
  seenTxCount: number;
}

// KV registry metadata stored per wallet
export interface WalletRegistryEntry {
  registeredAt: number;
}

// Document upload request body
export interface DocumentUploadRequest {
  title: string;    // max 200 chars
  content: string;  // raw text, max 100KB
}

// Document metadata returned by list/get endpoints
export interface DocumentMeta {
  id: string;
  title: string;
  charCount: number;
  chunkCount: number;
  createdAt: number;
  embeddingCostTokens: number;
}

// Env bindings (matches wrangler.toml)
export interface Env {
  DOX402: DurableObjectNamespace;
  AI: Ai;
  VECTORIZE: VectorizeIndex;    // Cloudflare Vectorize binding for RAG document embeddings
  PAYMENT_ADDRESS: string;
  BASE_RPC_URL: string;
  NETWORK: string;
  MOCK_PAYMENTS?: string;       // set to "true" in local dev only — skips Tier 2 RPC check
  MOCK_AI_BEHAVIOR?: string;    // local dev only: success | empty | error | stream_error
  SESSION_SECRET: string;       // HMAC-SHA256 key for SIWE session tokens (set via wrangler secret put)
  WALLET_REGISTRY: KVNamespace; // global wallet registry for admin tooling
  ADMIN_SECRET?: string;        // admin Bearer token (set via wrangler secret put)
}
