# Plan: Add Vitest unit test suite (Issue #4)

## 1. Install Vitest
- `npm install -D vitest` — lightweight, native ESM/TS support, no extra config needed
- Add `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json` scripts

## 2. Extract testable functions to `src/billing.ts`
- Move `parseSSE` and `computeCostMicroUSDC` from `dox402.ts` into `src/billing.ts`
- These are pure functions with no Durable Object dependency — importing `dox402.ts` in tests fails because `cloudflare:workers` isn't available outside Wrangler
- `dox402.ts` now imports from `billing.ts`

## 3. Rename existing E2E test
- `test/client.ts` → `test/e2e.ts`
- Update `package.json`: `"test:e2e": "npx ts-node --esm test/e2e.ts"`

## 4. Unit test files

### `test/siwe.test.ts` (16 tests)
- `buildSiweMessage` → produces correct EIP-4361 format, includes/omits expirationTime
- `parseSiweMessage` → roundtrips with buildSiweMessage, handles malformed input, returns null on garbage, returns null when required fields missing
- `recoverAddress` → recovers correct address from known keypair, throws on invalid sig length, handles no-0x-prefix
- `verifySiweLogin` → happy path, wrong domain, expired message, future issuedAt, signature from different wallet, malformed message, unsupported version

### `test/session.test.ts` (8 tests)
- `createSessionToken` + `verifySessionToken` roundtrip
- Lowercases wallet address
- Expired token returns null (via `vi.useFakeTimers`)
- Tampered payload/signature returns null
- Wrong secret returns null
- Malformed token (wrong number of parts) returns null
- Empty token returns null

### `test/x402.test.ts` (17 tests)
- `build402Response` → 402 status, correct JSON body, PAYMENT-REQUIRED header decodable
- `verifyProof` Tier 1: expired proof, wallet mismatch, insufficient amount, exact minimum, case-insensitive wallet
- `verifyProof` Tier 2 (mocked `fetch`): valid receipt with Transfer log + correct amount, reverted tx, sender mismatch, no matching log, null receipt, missing BASE_RPC_URL, RPC error, network failure

### `test/billing.test.ts` (15 tests)
- `parseSSE` → multi-line text extraction, usage extraction, [DONE] stops parsing, malformed lines ignored, non-data lines ignored, empty input, DONE-only stream
- `computeCostMicroUSDC` → real token counts, char-count fallback, zero tokens without fallback, null usage, minimum 1 µUSDC floor, unknown model fallback, different models produce different costs, cost scales with token count

### `test/constants.test.ts` (5 tests)
- Every `ALLOWED_MODELS` key has a `NEURON_RATES` entry
- All neuron rates are positive
- `AI_MODEL` is in both maps
- At least one model exists

## 5. GitHub Actions CI
- `.github/workflows/test.yml` — runs `npm test` on push to `main` and on PRs
- Node 22, npm cache

## Files changed
- `package.json` — add vitest dep + test scripts
- `src/billing.ts` — **new** — extracted `parseSSE`, `computeCostMicroUSDC`
- `src/dox402.ts` — imports from `billing.ts` instead of defining inline
- `test/client.ts` → `test/e2e.ts` (rename)
- `README.md` — update test command reference
- **New:** `test/siwe.test.ts`, `test/session.test.ts`, `test/x402.test.ts`, `test/billing.test.ts`, `test/constants.test.ts`
- **New:** `.github/workflows/test.yml`
