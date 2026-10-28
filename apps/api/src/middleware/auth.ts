import type { RequestHandler } from 'express';
import { adminAuth } from '../config/firebase';
import { User } from '../models/User';
import { sendError } from './errors';
import { requestContext } from './request-context';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; uid: string };
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in to continue (missing bearer token)');
    return;
  }
  let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
  try {
    decoded = await adminAuth.verifyIdToken(header.slice(7));
  } catch {
    sendError(res, 401, 'UNAUTHORIZED', 'Your session has expired. Sign in again.');
    return;
  }
  // Only a bad token is a 401. A database failure here goes to the error handler (500, logged),
  // instead of telling the user to sign in again, which wouldn't help.
  const user = await User.findOneAndUpdate(
    { firebaseUid: decoded.uid },
    {
      $setOnInsert: {
        email: decoded.email ?? '',
        displayName: decoded.name ?? '',
        photoURL: decoded.picture ?? '',
      },
    },
    { upsert: true, new: true }
  );
  req.auth = { userId: user.id, uid: decoded.uid };
  const ctx = requestContext();
  if (ctx) ctx.userId = user.id; // for the request log line
  next();
};
