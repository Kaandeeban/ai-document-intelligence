import { buildApp } from './api/app.js';
import { ConfigError, loadConfig } from './config/env.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  const shutdown = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'Shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  // Logger may not exist yet (e.g. invalid config), so fall back to stderr.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
