/**
 * Downloads the local embedding model (Xenova/all-MiniLM-L6-v2, quantised, ~23 MB) into the
 * library's cache inside node_modules, and checks it works. Run during a deploy's build step so
 * the server doesn't download it again every time it wakes up:
 *
 *   npm run prefetch-model -w apps/api
 */
import { localProvider } from '../src/platform/embeddings/local';

async function main() {
  const started = Date.now();
  const [vector] = await localProvider.embed(['MindMesh warm-up sentence.'], new AbortController().signal);
  if (vector?.length !== localProvider.dims) throw new Error(`Unexpected embedding size: ${vector?.length}`);
  console.log(`Embedding model ${localProvider.model} ready (${localProvider.dims} dims) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
