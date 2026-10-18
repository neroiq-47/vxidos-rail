export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const badRequest = m => new HttpError(400, m);
export const notFound = m => new HttpError(404, m);
export const conflict = m => new HttpError(409, m);
