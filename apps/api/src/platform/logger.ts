import { env } from '../config/env';
import { requestContext } from '../middleware/request-context';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const minLevel = env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info');
const format = env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty');

const describe = (e: unknown) =>
  e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : { message: String(e) };

/**
 * One line per event: `evt` names it, fields add detail, and the current request id is added
 * automatically. Never pass note text, questions, tokens or keys as fields.
 * `err` (any thrown value) is expanded into name, message and stack.
 */
function write(level: Level, evt: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const { err, ...rest } = fields;
  const entry = {
    t: new Date().toISOString(),
    level,
    evt,
    ...(requestContext() && !('requestId' in rest) ? { requestId: requestContext()!.requestId } : {}),
    ...rest,
    ...(err === undefined ? {} : { err: describe(err) }),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (format === 'json') {
    out.write(`${JSON.stringify(entry)}\n`);
    return;
  }
  const { t, level: _l, evt: _e, err: errField, ...details } = entry as typeof entry & { err?: { message: string; stack?: string } };
  const pairs = Object.entries(details)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  out.write(`${t.slice(11, 19)} ${level.padEnd(5)} ${evt}${pairs ? ` ${pairs}` : ''}\n`);
  if (errField) out.write(`${errField.stack ?? errField.message}\n`);
}

export const log = {
  debug: (evt: string, fields?: Record<string, unknown>) => write('debug', evt, fields),
  info: (evt: string, fields?: Record<string, unknown>) => write('info', evt, fields),
  warn: (evt: string, fields?: Record<string, unknown>) => write('warn', evt, fields),
  error: (evt: string, fields?: Record<string, unknown>) => write('error', evt, fields),
};
