import { app } from './app';
import { connectDb } from './config/db';
import { env } from './config/env';

connectDb()
  .then(() => app.listen(env.PORT, () => console.log(`API listening on :${env.PORT}`)))
  .catch((err) => {
    console.error('Startup failed', err);
    process.exit(1);
  });
