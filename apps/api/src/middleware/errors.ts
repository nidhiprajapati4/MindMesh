import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { log } from '../platform/logger';
import { requestContext } from './request-context';

/** The machine-readable code for an HTTP status when no more specific one is given. */
const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

export class HttpError extends Error {
  /** A stable machine-readable reason (e.g. QUOTA_EXCEEDED); defaults from the status. */
  public code: string;
  constructor(public status: number, message: string, code?: string) {
    super(message);
    this.code = code ?? DEFAULT_CODES[status] ?? 'ERROR';
  }
}

/** Every error response: `{ error: { code, message, requestId, details? } }`. */
export function sendError(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ error: { code, message, requestId: requestContext()?.requestId, ...(details === undefined ? {} : { details }) } });
}

const MULTER_MESSAGES: Partial<Record<MulterError['code'], [number, string]>> = {
  LIMIT_FILE_SIZE: [413, 'File is too large (max 10 MB)'],
  LIMIT_FILE_COUNT: [400, 'Upload one file at a time'],
  LIMIT_UNEXPECTED_FILE: [400, 'Attach the file in the "file" field'],
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) return; // e.g. a stream that already started; nothing more can be sent
  if (err instanceof ZodError) {
    sendError(res, 400, 'VALIDATION_FAILED', 'Validation failed', err.flatten());
  } else if (err instanceof HttpError) {
    sendError(res, err.status, err.code, err.message);
  } else if (err instanceof MulterError) {
    const [status, message] = MULTER_MESSAGES[err.code] ?? [400, err.message];
    sendError(res, status, DEFAULT_CODES[status], message);
  } else if (err?.type === 'entity.parse.failed') {
    sendError(res, 400, 'MALFORMED_JSON', 'Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  } else {
    log.error('unhandled_error', { err });
    sendError(res, 500, 'INTERNAL', 'Something went wrong on our side. Please try again.');
  }
};

/** Unknown routes get the same error shape as everything else. */
export const notFoundHandler: RequestHandler = (_req, res) => sendError(res, 404, 'NOT_FOUND', 'No such endpoint');
