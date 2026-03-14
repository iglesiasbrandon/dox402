import { Env } from './types';

/**
 * Verify that the request carries a valid admin Bearer token.
 * Returns true if ADMIN_SECRET is configured and the Authorization header matches.
 */
export function isAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_SECRET) return false;
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  // Constant-time comparison to prevent timing attacks
  if (token.length !== env.ADMIN_SECRET.length) return false;
  let result = 0;
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
  }
  return result === 0;
}

export function adminUnauthorized(): Response {
  return Response.json(
    { error: 'Admin authentication required' },
    { status: 401 },
  );
}

export function adminDisabled(): Response {
  return Response.json(
    { error: 'Admin endpoints not configured — set ADMIN_SECRET' },
    { status: 503 },
  );
}
