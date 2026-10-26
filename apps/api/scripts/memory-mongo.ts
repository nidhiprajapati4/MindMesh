// Starts a throwaway in-memory MongoDB for local end-to-end testing. Data is lost when it stops.
import { MongoMemoryServer } from 'mongodb-memory-server';

const port = Number(process.env.MEMORY_MONGO_PORT ?? 27999);

MongoMemoryServer.create({ instance: { port, ip: '127.0.0.1' } }).then((server) => {
  console.log(`In-memory MongoDB ready: ${server.getUri('mindmesh_local_test')}`);
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => undefined, 1 << 30); // the mongod child is unref'd; keep this process alive
});
