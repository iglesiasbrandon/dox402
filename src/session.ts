// Stateless JWT-like session tokens using Web Crypto HMAC-SHA256.
// No external dependencies — uses crypto.subtle available natively in Cloudflare Workers.

const TOKEN_EXPIRY_SECS = 86400; // 24 hours

interface SessionPayload {
  sub: string; // wallet address (lowercase, 0x-prefixed)
  iat: number; // issued-at (Unix seconds)
  exp: number; // expiry (Unix seconds)
}

// ── Create a session token ───────────────────────────────────────────────────
export async function createSessionToken(wallet: string, secret: string): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_EXPIRY_SECS;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: wallet.toLowerCase(), iat: now, exp }));
  const signature = await hmacSign(`${header}.${payload}`, secret);
  return { token: `${header}.${payload}.${signature}`, expiresAt: exp };
}

// ── Verify a session token ───────────────────────────────────────────────────
export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;

  // Verify HMAC signature
  const expected = await hmacSign(`${header}.${payload}`, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  // Decode and validate payload
  try {
    const decoded = JSON.parse(b64urlDecode(payload)) as SessionPayload;
    if (!decoded.sub || !decoded.iat || !decoded.exp) return null;
    if (Math.floor(Date.now() / 1000) > decoded.exp) return null; // expired
    return decoded;
  } catch {
    return null;
  }
}

// ── HMAC-SHA256 signing ──────────────────────────────────────────────────────
async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

// ── Timing-safe string comparison ────────────────────────────────────────────
// Uses native crypto.subtle.timingSafeEqual when available (Cloudflare Workers),
// falls back to constant-time manual comparison for Node.js test environments.
// Both inputs are padded to the same length to avoid timing leaks on length mismatch.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  const maxLen = Math.max(bufA.byteLength, bufB.byteLength);
  // Pad both to the same length so comparison is always constant-time
  const paddedA = new Uint8Array(maxLen);
  const paddedB = new Uint8Array(maxLen);
  paddedA.set(bufA);
  paddedB.set(bufB);

  // Use native API if available (Cloudflare Workers runtime)
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return bufA.byteLength === bufB.byteLength && crypto.subtle.timingSafeEqual(paddedA, paddedB);
  }
  // Fallback: manual constant-time XOR comparison
  let result = bufA.byteLength ^ bufB.byteLength; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    result |= paddedA[i] ^ paddedB[i];
  }
  return result === 0;
}

// ── Base64url encoding ───────────────────────────────────────────────────────
function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // Use btoa for browser/Workers compatibility
  let b64 = '';
  const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
