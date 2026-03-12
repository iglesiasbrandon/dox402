import { SUPPORTED_CHAINS, PROOF_MAX_AGE_SECS } from './constants';
import { SiwxPayload, SiwxExtension } from './types';
import { verifySiweLogin } from './siwe';

// ── Parse SIGN-IN-WITH-X header ─────────────────────────────────────────────

export function parseSiwxHeader(headerValue: string): SiwxPayload | null {
  try {
    const json = atob(headerValue);
    const payload = JSON.parse(json) as SiwxPayload;

    // Required fields
    if (!payload.message || !payload.signature || !payload.chainId || !payload.type || !payload.address) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ── Build SIWX extension for 402 responses ──────────────────────────────────

export function buildSiwxExtension(domain: string, uri: string, nonce: string): SiwxExtension {
  const now = new Date();
  const expiry = new Date(now.getTime() + PROOF_MAX_AGE_SECS * 1000);

  return {
    supportedChains: [...SUPPORTED_CHAINS],
    info: {
      domain,
      uri,
      version: '1',
      statement: 'Sign in to dox402 to access your inference balance',
      nonce,
      issuedAt: now.toISOString(),
      expirationTime: expiry.toISOString(),
    },
  };
}

// ── Verify SIWX payload (routes by chain type) ─────────────────────────────

export function verifySiwxPayload(
  payload: SiwxPayload,
  expectedDomain: string,
): { valid: true; address: string } | { valid: false; reason: string } {

  // Check that the chain is supported
  const chain = SUPPORTED_CHAINS.find(c => c.chainId === payload.chainId && c.type === payload.type);
  if (!chain) {
    return { valid: false, reason: `Unsupported chain: ${payload.chainId} (${payload.type})` };
  }

  // EVM chains: delegate to existing SIWE verification
  if (payload.type === 'eip191') {
    const result = verifySiweLogin(payload.message, payload.signature, expectedDomain);
    if (!result.valid) {
      return { valid: false, reason: result.reason };
    }

    // Ensure the address in the SIWX payload matches the SIWE message
    if (result.parsed.address.toLowerCase() !== payload.address.toLowerCase()) {
      return { valid: false, reason: 'SIWX address does not match SIWE message address' };
    }

    return { valid: true, address: result.parsed.address.toLowerCase() };
  }

  return { valid: false, reason: `Unsupported signature type: ${payload.type}` };
}
