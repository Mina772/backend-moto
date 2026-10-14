export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Unauthorized', code = 'UNAUTHORIZED') => new HttpError(401, code, message);
export const forbidden = (message = 'Forbidden', code = 'FORBIDDEN') => new HttpError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT', details?: unknown) => new HttpError(409, code, message, details);
export const unprocessable = (message: string, code = 'UNPROCESSABLE', details?: unknown) => new HttpError(422, code, message, details);
