import type { Request, RequestHandler } from 'express';
import { env } from '../config/env';
import { HttpError } from './errors';

type Options = { max: number; windowMs: number; message: string };

/**
 * A sliding-window limit per key (the signed-in user, else the client's IP address), kept in
 * memory: right for one API instance. Several instances would need a shared store.
 */
export function createLimiter(name: string, opts: Options) {
  const recent = new Map<string, number[]>();
  let lastSweep = Date.now();

  /** Counts one request for `key`; throws 429 RATE_LIMITED (with a retry time) when over the limit. */
  function take(key: string) {
    const now = Date.now();
    // Forget keys with no request in the window, so the map doesn't grow forever.
    if (now - lastSweep > opts.windowMs) {
      for (const [k, times] of recent) if (now - (times.at(-1) ?? 0) >= opts.windowMs) recent.delete(k);
      lastSweep = now;
    }
    const times = (recent.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (times.length >= opts.max) {
      const err = new HttpError(429, opts.message, 'RATE_LIMITED') as HttpError & { retryAfterS?: number };
      err.retryAfterS = Math.max(1, Math.ceil((times[0] + opts.windowMs - now) / 1000));
      throw err;
    }
    times.push(now);
    recent.set(key, times);
  }

  const middleware: RequestHandler = (req, res, next) => {
    try {
      take(keyOf(req));
      next();
    } catch (e) {
      const retry = (e as { retryAfterS?: number }).retryAfterS;
      if (retry) res.setHeader('Retry-After', String(retry));
      next(e);
    }
  };

  return Object.assign(middleware, {
    limiterName: name,
    take,
    options: opts,
    /** Tests only. */
    reset: () => recent.clear(),
    size: () => recent.size,
  });
}

const keyOf = (req: Request) => (req.auth ? `user:${req.auth.userId}` : `ip:${req.ip}`);

const perMinute = env.RATE_LIMIT_PER_MINUTE;
const MINUTE = 60_000;

/** The API's limits (the Ask route has its own, stricter one). Generous for normal use. */
export const apiLimits = {
  /** Every /api request by IP address, checked before sign-in so token checks can't be flooded. */
  ip: createLimiter('ip', { max: perMinute * 2, windowMs: MINUTE, message: 'Too many requests from your network. Wait a minute and try again.' }),
  /** Every /api request by signed-in user. */
  user: createLimiter('user', { max: perMinute, windowMs: MINUTE, message: 'Too many requests. Wait a minute and try again.' }),
  /** Uploads and saving links: they fetch, parse and embed (20 a minute by default). */
  heavy: createLimiter('heavy', { max: Math.ceil(perMinute / 15), windowMs: MINUTE, message: 'Too many uploads or saved links in a short time. Wait a minute and try again.' }),
  /** Suggestions while writing embed the draft (60 a minute by default: one per second of typing). */
  suggest: createLimiter('suggest', { max: Math.ceil(perMinute / 5), windowMs: MINUTE, message: 'Suggestions are paused for a moment. Keep writing; they will be back shortly.' }),
};
