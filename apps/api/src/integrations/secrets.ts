import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Credentials for source systems are stored encrypted (AES-256-GCM) and are never sent back to a browser. */
function key(): Buffer {
  const k = process.env.INTEGRATION_KEY;
  if (!k && process.env.NODE_ENV === 'production') throw new Error('INTEGRATION_KEY is required in production');
  return scryptSync(k ?? 'dev-only-integration-key', 'design-max-integrations', 32);
}
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
export function decryptSecret(token: string): string {
  const [v, iv, tag, enc] = token.split(':');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unreadable credential');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
