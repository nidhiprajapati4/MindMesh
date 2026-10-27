'use client';

import { useEffect, useState } from 'react';
import { watchSlowRequests } from '@/lib/api';

/**
 * A small notice while a request is unusually slow. On the free hosting plan the server sleeps
 * after a quiet spell, and the first request then waits while it starts up.
 */
export function ServerStatus() {
  const [slow, setSlow] = useState(0);
  useEffect(() => watchSlowRequests(setSlow), []);

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      {slow > 0 && (
        <p className="flex max-w-md items-center gap-2 rounded bg-ink px-4 py-2 text-sm text-white shadow-lg">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-flag" aria-hidden />
          Still working… The server may be waking up, which can take up to a minute on the free plan.
        </p>
      )}
    </div>
  );
}
