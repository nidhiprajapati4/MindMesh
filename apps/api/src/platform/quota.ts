import { env } from '../config/env';
import { HttpError } from '../middleware/errors';
import { Usage } from '../models/Usage';

export const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED';

export class QuotaExceededError extends HttpError {
  constructor() {
    super(429, 'Daily AI budget reached. It resets at midnight UTC.', QUOTA_EXCEEDED);
  }
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** Throws QuotaExceededError when spending `estimatedTokens` more would pass today's budget. */
export async function assertWithinBudget(userId: string, estimatedTokens: number) {
  const usage = await Usage.findOne({ userId, day: utcDay() }, { embedTokens: 1, genTokens: 1 }).lean();
  const used = (usage?.embedTokens ?? 0) + (usage?.genTokens ?? 0);
  if (used + estimatedTokens > env.AI_DAILY_TOKEN_BUDGET) throw new QuotaExceededError();
}

/** Atomically adds to today's counters. */
export async function recordUsage(userId: string, tokens: { embed?: number; gen?: number }) {
  await Usage.updateOne(
    { userId, day: utcDay() },
    { $inc: { embedTokens: tokens.embed ?? 0, genTokens: tokens.gen ?? 0, requests: 1 } },
    { upsert: true }
  );
}

export async function getUsage(userId: string) {
  const usage = await Usage.findOne({ userId, day: utcDay() }).lean();
  return { day: utcDay(), embedTokens: usage?.embedTokens ?? 0, genTokens: usage?.genTokens ?? 0, requests: usage?.requests ?? 0, budget: env.AI_DAILY_TOKEN_BUDGET };
}
