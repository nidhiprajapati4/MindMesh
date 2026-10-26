import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { env } from './env';

if (!getApps().length) {
  initializeApp(
    env.FIREBASE_AUTH_EMULATOR_HOST
      ? { projectId: env.FIREBASE_PROJECT_ID } // emulator: no service account needed
      : {
          credential: cert({
            projectId: env.FIREBASE_PROJECT_ID,
            clientEmail: env.FIREBASE_CLIENT_EMAIL,
            privateKey: env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
          }),
        }
  );
}

export const adminAuth = getAuth();
