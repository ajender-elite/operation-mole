import { existsSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { isLoopbackHost, loadServerConfig } from './config/server-config.ts';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
const loaded = loadServerConfig(process.env, process.argv, repoRoot);
if (!loaded.ok) {
  console.error(loaded.error.message);
  process.exit(1);
}
const config = loaded.value;
if (!isLoopbackHost(config.host)) {
  console.warn(
    `OM listens on ${config.host}: anyone who can reach that address can read the repositories and folders OM holds.`,
  );
}

const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
const staticDir = config.isProduction && existsSync(webDist) ? webDist : undefined;

const app = buildApp({
  logger: true,
  dataDir: config.dataDir,
  limits: config.limits,
  cacheMaxBytes: config.cacheMaxBytes,
  ...(staticDir === undefined ? {} : { staticDir }),
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
