import { runNext } from '../modules/ai-processing/pipeline';
import { log } from '../platform/logger';

const IDLE_POLL_MS = 2000;

let running: Promise<void> | null = null;
let stopping = false;
let wake: (() => void) | null = null;

/** Waits, but wakes up early when the worker is asked to stop. */
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
  });

/**
 * Claims embed jobs from MongoDB and runs them one at a time until stopped. Used by the separate
 * worker process (`npm run worker`) and, with RUN_WORKER=inline, inside the API process.
 * Several workers can run at once; claiming is atomic.
 */
export function startWorker() {
  if (running) return;
  stopping = false;
  running = (async () => {
    while (!stopping) {
      try {
        const outcome = await runNext();
        if (outcome) log.info('job', { outcome });
        else await pause(IDLE_POLL_MS);
      } catch (e) {
        // Database hiccups shouldn't kill the worker; back off and keep going.
        log.error('worker_loop_error', { err: e });
        await pause(IDLE_POLL_MS * 5);
      }
    }
  })();
}

/** Lets the current job finish, then stops. */
export async function stopWorker() {
  stopping = true;
  wake?.();
  await running;
  running = null;
}

export const workerRunning = () => !!running && !stopping;
