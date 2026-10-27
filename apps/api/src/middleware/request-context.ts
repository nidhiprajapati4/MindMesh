import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { log } from '../platform/logger';

type Context = { requestId: string; userId?: string };
const store = new AsyncLocalStorage<Context>();

/** The request being handled (in route code, services and anything they call), if any. */
export const requestContext = () => store.getStore();

// Accept a caller's id (e.g. from a proxy) only if it looks like one; never echo arbitrary text.
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Gives every request an id (`X-Request-Id`, reused from the caller when valid), available to
 * logs and error responses, and logs one line per request when it ends. The line has the route
 * pattern, not the URL, so search text in query strings never reaches the logs.
 */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const ctx: Context = { requestId: incoming && VALID_ID.test(incoming) ? incoming : randomUUID() };
  res.setHeader('X-Request-Id', ctx.requestId);
  const started = performance.now();
  res.on('close', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path;
    const fields = {
      method: req.method,
      route,
      status: res.statusCode,
      ms: Math.round(performance.now() - started),
      requestId: ctx.requestId,
      userId: ctx.userId,
      ...(res.writableFinished ? {} : { aborted: true }),
    };
    if (res.statusCode >= 500) log.error('http', fields);
    else log.info('http', fields);
  });
  store.run(ctx, next);
};
