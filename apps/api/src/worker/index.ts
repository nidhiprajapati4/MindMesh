/**
 * Background worker (separate process): `npm run worker -w apps/api`.
 * Claims embed jobs from MongoDB and runs extract → clean → chunk → embed → store.
 * Hosting without a separate worker can run the same loop inside the API (RUN_WORKER=inline).
 */
import mongoose from 'mongoose';
import { connectDb } from '../config/db';
import { embeddingProvider } from '../platform/ai-client';
import { log } from '../platform/logger';
import { startWorker, stopWorker } from './loop';

let stopping = false;

async function main() {
  await connectDb();
  const p = embeddingProvider();
  log.info('worker_started', { provider: p.name, model: p.model });
  startWorker();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1); // second Ctrl+C: stop immediately
    stopping = true;
    log.info('worker_stopping', { note: 'finishing the current job (Ctrl+C again to force)' });
    void stopWorker()
      .then(() => mongoose.disconnect())
      .then(() => {
        log.info('worker_stopped');
        process.exit(0);
      });
  });
}

main().catch((e) => {
  log.error('worker_start_failed', { err: e });
  process.exit(1);
});
