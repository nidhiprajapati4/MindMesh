import type { ErrorRequestHandler } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MULTER_MESSAGES: Partial<Record<MulterError['code'], [number, string]>> = {
  LIMIT_FILE_SIZE: [413, 'File is too large (max 10 MB)'],
  LIMIT_FILE_COUNT: [400, 'Upload one file at a time'],
  LIMIT_UNEXPECTED_FILE: [400, 'Attach the file in the "file" field'],
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.flatten() });
  } else if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (err instanceof MulterError) {
    const [status, message] = MULTER_MESSAGES[err.code] ?? [400, err.message];
    res.status(status).json({ error: message });
  } else if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
  } else if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
  } else {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
