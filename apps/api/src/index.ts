import type { Server } from 'node:http';
import mongoose from 'mongoose';
import { app, lifecycle } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';
import { log } from './platform/logger';
import { startWorker, stopWorker } from './worker/loop';

/** Hosting platforms give a process about 30 s after SIGTERM; finish well within that. */
const SHUTDOWN_TIMEOUT_MS = 20_000;
let server: Server | null = null;

async function shutdown(signal: string) {
  if (lifecycle.shuttingDown) return;
  lifecycle.shuttingDown = true;
  log.info('shutting_down', { signal });
  setTimeout(() => {
    log.error('shutdown_timed_out');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  // Stop taking new connections and let requests in flight finish, finish the current job, then close the database.
  await Promise.all([new Promise((r) => (server ? server.close(r) : r(undefined))), stopWorker()]);
  await mongoose.disconnect();
  log.info('stopped');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown(signal));

connectDb()
  .then(() => {
    server = app.listen(env.PORT, () => log.info('api_listening', { port: env.PORT, worker: env.RUN_WORKER }));
    if (env.RUN_WORKER === 'inline') startWorker();
  })
  .catch((err) => {
    log.error('startup_failed', { err });
    process.exit(1);
  });
