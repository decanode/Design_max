/** `status` carries the HTTP code the route should answer with. */
export class DocError extends Error {
  constructor(message: string, public status = 409, public extra?: Record<string, unknown>) { super(message); }
}
