import { DocError } from '../errors.js';

const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^::1$/, /^fc/i, /^fd/i, /^fe80/i, /^localhost$/i, /\.local$/i, /\.internal$/i];

/**
 * A connection's address must be a plain https URL to a public host, so a project admin cannot point the server at
 * internal services. Local development and tests (not production) may use http and private hosts.
 */
export function validateBaseUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new DocError('That address is not a valid URL', 400); }
  const prod = process.env.NODE_ENV === 'production' && process.env.INTEGRATION_ALLOW_PRIVATE !== '1';
  if (u.username || u.password) throw new DocError('Do not put credentials in the address', 400);
  if (prod && u.protocol !== 'https:') throw new DocError('Use an https address', 400);
  if (!['https:', 'http:'].includes(u.protocol)) throw new DocError('Use an https address', 400);
  if (prod && PRIVATE.some((r) => r.test(u.hostname))) throw new DocError('That address points to a private network', 400);
  return u.origin;
}
