/**
 * Access gate.
 *
 * The hosted app holds a billed API key. Without a gate, the public URL is a machine that
 * spends someone else's money on request — anyone who finds it could generate hours of
 * speech. So every route that can reach Gemini requires a shared code.
 *
 * This is a spend limiter, not a security boundary. It is one shared secret over TLS with
 * no accounts and no rate limiting per user. It is exactly strong enough for "a personal
 * app that happens to live on the open web", which is what this is.
 *
 * If NIGHTSCRIPT_ACCESS_CODE is unset (local development), the gate is open.
 */

export const ACCESS_HEADER = 'x-access-code';
export const ACCESS_STORAGE_KEY = 'nightscript.access';

/** Server side. Returns null when allowed, or a Response when it should be refused. */
export function checkAccess(req: Request): Response | null {
  const expected = process.env.NIGHTSCRIPT_ACCESS_CODE;
  if (!expected) return null;
  const given = req.headers.get(ACCESS_HEADER);
  if (given && given === expected) return null;
  return Response.json(
    { error: 'This copy needs an access code.', code: 'no_access' },
    { status: 401 },
  );
}

/** Client side. */
export function getAccessCode(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(ACCESS_STORAGE_KEY) ?? '';
}

export function setAccessCode(code: string): void {
  localStorage.setItem(ACCESS_STORAGE_KEY, code.trim());
}

export function authHeaders(): Record<string, string> {
  const code = getAccessCode();
  return code ? { [ACCESS_HEADER]: code } : {};
}
