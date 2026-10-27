/** `status` carries the HTTP code the route should answer with. */
export class DocError extends Error {
  constructor(message: string, public status = 409, public extra?: Record<string, unknown>) { super(message); }
}

const DOWN = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P02', '57P03', '08006', '08001', '08003']);

/** True when an error means "the database cannot be reached" (stopped, restarting, network), not a bug in the request. */
export function isDatabaseDown(e: unknown): boolean {
  const err = e as { code?: string; errors?: unknown[]; cause?: unknown } | null;
  if (!err) return false;
  if (err.code && DOWN.has(err.code)) return true;
  if (Array.isArray(err.errors) && err.errors.some(isDatabaseDown)) return true;   // pg reports IPv4 + IPv6 failures as an AggregateError
  return err.cause ? isDatabaseDown(err.cause) : false;
}
