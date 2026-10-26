/**
 * Background worker (separate process): `npm run worker -w apps/api`.
 * Claims embed jobs from MongoDB and runs extract → clean → chunk → embed → store.
 * Several workers can run at once; claiming is atomic.
 */
import mongoose from 'mongoose';
import { connectDb } from '../config/db';
import { embeddingProvider } from '../platform/ai-client';
import { runNext } from '../modules/ai-processing/pipeline';

const IDLE_POLL_MS = 2000;
let stopping = false;

async function main() {
  await connectDb();
  const p = embeddingProvider();
  console.log(`Worker started (provider: ${p.name}, model: ${p.model})`);

  while (!stopping) {
    try {
      const outcome = await runNext();
      if (outcome) console.log(`job ${outcome}`);
      else await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    } catch (e) {
      // Database hiccups shouldn't kill the worker; back off and keep going.
      console.error('Worker loop error', e);
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS * 5));
    }
  }
  await mongoose.disconnect();
  console.log('Worker stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1); // second Ctrl+C: stop immediately
    console.log('Finishing the current job, then stopping… (Ctrl+C again to force)');
    stopping = true;
  });
}

main().catch((e) => {
  console.error('Worker failed to start', e);
  process.exit(1);
});
