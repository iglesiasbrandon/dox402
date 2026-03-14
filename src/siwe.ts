import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// ── Types ────────────────────────────────────────────────────────────────────
export interface SiweMessage {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
}

// ── Build EIP-4361 message string ────────────────────────────────────────────
export function buildSiweMessage(msg: SiweMessage): string {
  const lines = [
    `${msg.domain} wants you to sign in with your Ethereum account:`,
    msg.address,
    '',
    msg.statement,
    '',
    `URI: ${msg.uri}`,
    `Version: ${msg.version}`,
    `Chain ID: ${msg.chainId}`,
    `Nonce: ${msg.nonce}`,
    `Issued At: ${msg.issuedAt}`,
  ];
  if (msg.expirationTime) {
    lines.push(`Expiration Time: ${msg.expirationTime}`);
  }
  return lines.join('\n');
}

// ── Parse EIP-4361 message ───────────────────────────────────────────────────
export function parseSiweMessage(message: string): SiweMessage | null {
  try {
    const domainMatch = message.match(/^(.+) wants you to sign in with your Ethereum account:/m);
    const addressMatch = message.match(/^(0x[0-9a-fA-F]{40})$/m);
    const uriMatch = message.match(/^URI: (.+)$/m);
    const versionMatch = message.match(/^Version: (.+)$/m);
    const chainIdMatch = message.match(/^Chain ID: (\d+)$/m);
    const nonceMatch = message.match(/^Nonce: (.+)$/m);
    const issuedAtMatch = message.match(/^Issued At: (.+)$/m);
    const expirationMatch = message.match(/^Expiration Time: (.+)$/m);

    if (!domainMatch || !addressMatch || !uriMatch || !versionMatch || !chainIdMatch || !nonceMatch || !issuedAtMatch) {
      return null;
    }

    // Extract statement: lines between the address and "URI:" line
    const lines = message.split('\n');
    const addrIdx = lines.findIndex(l => /^0x[0-9a-fA-F]{40}$/.test(l));
    const uriIdx = lines.findIndex(l => l.startsWith('URI: '));
    const statementLines = lines.slice(addrIdx + 1, uriIdx).filter(l => l.trim() !== '');
    const statement = statementLines.join('\n');

    return {
      domain: domainMatch[1],
      address: addressMatch[1],
      statement,
      uri: uriMatch[1],
      version: versionMatch[1],
      chainId: parseInt(chainIdMatch[1], 10),
      nonce: nonceMatch[1],
      issuedAt: issuedAtMatch[1],
      expirationTime: expirationMatch?.[1],
    };
  } catch {
    return null;
  }
}

// ── Recover Ethereum address from EIP-191 personal_sign ──────────────────────
export function recoverAddress(message: string, signature: string): string {
  // EIP-191 prefix
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix);
  prefixed.set(msgBytes, prefix.length);
  const hash = keccak_256(prefixed);

  // Parse 65-byte signature: r(32) + s(32) + v(1)
  const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature;
  const sigBytes = hexToBytes(sigHex);
  if (sigBytes.length !== 65) throw new Error('Invalid signature length');

  const r = sigBytes.slice(0, 32);
  const s = sigBytes.slice(32, 64);
  let v = sigBytes[64];
  if (v >= 27) v -= 27; // normalize to 0 or 1
  if (v !== 0 && v !== 1) throw new Error('Invalid recovery bit');

  const sig = secp256k1.Signature.fromBytes(new Uint8Array([...r, ...s])).addRecoveryBit(v);
  const pubkey = sig.recoverPublicKey(hash);
  const pubkeyBytes = pubkey.toBytes(false); // uncompressed 65 bytes (04 + x + y)

  // Address = last 20 bytes of keccak256(pubkey[1:])
  const addrHash = keccak_256(pubkeyBytes.slice(1));
  const addrBytes = addrHash.slice(12);
  return '0x' + bytesToHex(addrBytes);
}

// ── Verify a complete SIWE login ─────────────────────────────────────────────
export function verifySiweLogin(
  message: string,
  signature: string,
  expectedDomain: string,
): { valid: true; parsed: SiweMessage } | { valid: false; reason: string } {
  const parsed = parseSiweMessage(message);
  if (!parsed) return { valid: false, reason: 'Failed to parse SIWE message' };

  // Domain check
  if (parsed.domain !== expectedDomain) {
    console.warn('[siwe] Domain mismatch: got %s, expected %s', parsed.domain, expectedDomain);
    return { valid: false, reason: 'Domain mismatch' };
  }

  // Version check
  if (parsed.version !== '1') {
    return { valid: false, reason: 'Unsupported SIWE version' };
  }

  // Expiration check
  if (parsed.expirationTime) {
    const expiry = new Date(parsed.expirationTime).getTime();
    if (isNaN(expiry) || Date.now() > expiry) {
      return { valid: false, reason: 'SIWE message expired' };
    }
  }

  // Issued-at must not be in the future (with 60s tolerance)
  const iat = new Date(parsed.issuedAt).getTime();
  if (isNaN(iat) || iat > Date.now() + 60_000) {
    return { valid: false, reason: 'issuedAt is in the future' };
  }

  // Signature recovery
  let recovered: string;
  try {
    recovered = recoverAddress(message, signature);
  } catch (e) {
    console.warn('[siwe] Signature verification failed: %s', e instanceof Error ? e.message : String(e));
    return { valid: false, reason: 'Signature verification failed' };
  }

  // Address match (case-insensitive)
  if (recovered.toLowerCase() !== parsed.address.toLowerCase()) {
    return { valid: false, reason: 'Recovered address does not match claimed address' };
  }

  return { valid: true, parsed };
}

// ── Hex helpers ──────────────────────────────────────────────────────────────
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
