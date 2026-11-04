import "dotenv/config";
import type { Server } from "node:http";
import { logger, safeErrorDetails } from "./logger";

async function main(): Promise<void> {
  const { createApp } = await import("./app");
  const { loadConfig } = await import("./config");
  const config = loadConfig();
  const { app, service } = createApp(config, logger);
  service.startCleanup();

  const server: Server = app.listen(config.port, config.host, () => {
    logger.info("Tribler Stremio bridge listening", {
      address: `${config.publicBaseUrl}/manifest.json`,
      host: config.host,
      tribler: config.triblerUrl
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    service.stopCleanup();
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        logger.error("Shutdown failed", { error: safeErrorDetails(error) });
        process.exitCode = 1;
      }
    })();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  logger.error("Startup failed", { error: safeErrorDetails(error) });
  process.exitCode = 1;
});
