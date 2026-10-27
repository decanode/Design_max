import { createHmac, timingSafeEqual } from 'node:crypto';

/** Short-lived pass for one live editing session on one document. Browsers cannot send cookies the same way over every proxy, so this is the credential. */
export interface CollabClaim { uid: string; name: string; pid: string; ticket: string; kind: string; edit: boolean; exp: number }
const secret = () => process.env.SESSION_SECRET ?? (process.env.NODE_ENV === 'production' ? (() => { throw new Error('SESSION_SECRET is required in production'); })() : 'dev-only-session-secret');
const mac = (b: string) => createHmac('sha256', `collab:${secret()}`).update(b).digest('base64url');
export const TOKEN_SECONDS = 300;

export function signCollab(c: Omit<CollabClaim, 'exp'>, nowMs = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...c, exp: Math.floor(nowMs / 1000) + TOKEN_SECONDS })).toString('base64url');
  return `${body}.${mac(body)}`;
}
export function verifyCollab(token: string | undefined, nowMs = Date.now()): CollabClaim | null {
  const [body, sig] = token?.split('.') ?? [];
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as CollabClaim; return c.exp * 1000 > nowMs ? c : null; } catch { return null; }
}
export const docName = (pid: string, ticket: string, kind: string) => `${pid}:${ticket}:${kind}`;
