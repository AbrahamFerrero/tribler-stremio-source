import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { logger, safeErrorDetails } from "./logger";

// Preserve synchronous CLI helper exports and their ordinary import contract.
// Only an executable in scripts/ owns this process-exit boundary. Its remaining
// static imports reuse the successfully initialized CommonJS policy module.
const entrypoint = process.argv[1];
if (entrypoint && dirname(resolve(entrypoint)) === resolve(__dirname, "../scripts")) {
  try {
    createRequire(__filename)("./streams/ranking-policy");
  } catch (error) {
    logger.error("Startup failed", { error: safeErrorDetails(error) });
    process.exit(1);
  }
}
