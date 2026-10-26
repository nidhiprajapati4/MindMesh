import type { RequestHandler } from 'express';
import { adminAuth } from '../config/firebase';
import { User } from '../models/User';

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
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }
  try {
    const decoded = await adminAuth.verifyIdToken(header.slice(7));
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
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};
