import express from "express";
import { localRequestPolicy } from "../local-request-policy";
import type { Server } from "node:http";
import { DiagnosticCliError } from "./cli-errors";

/** Own the listener in this process: no subprocess, token arguments, IPC secrets or orphan. */
export async function startDiagnosticBridge(bridge: URL, token: string, ownerId: string): Promise<() => Promise<void>> {
  try {
    const { loadConfig } = await import("../config");
    const config = loadConfig();
    if (config.port !== Number(bridge.port || 80) || config.bridgeAdminToken !== token) throw new Error();
    const { createApp } = await import("../app");
    // Runtime diagnostic output never contains upstream/provider/private context.
    const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    const { app, service } = createApp(config, quiet);
    const listenerApp = express();
    listenerApp.disable("x-powered-by");
    const authorize = localRequestPolicy(token);
    listenerApp.use((req, res, next) => {
      if (!/^\/diagnostics\/(?:private\/)?start$/i.test(req.path)) { next(); return; }
      // An owned listener cannot acquire another administrator's capture before shutdown.
      // Authenticate first, then restrict starts to the foreground CLI's in-memory owner.
      authorize(req, res, () => {
        if (req.headers["x-diagnostic-owner"] !== ownerId) { res.status(409).json({ error: "Diagnostic listener is owned" }); return; }
        next();
      });
    });
    listenerApp.use(app);
    let server: Server;
    try {
      server = await new Promise<Server>((resolve, reject) => {
        const listener = listenerApp.listen(config.port, config.host, () => { listener.removeListener("error", reject); resolve(listener); });
        listener.once("error", reject);
      });
    } catch { service.stopCleanup(); throw new Error(); }
    service.startCleanup();
    let closing: Promise<void> | undefined;
    return () => closing ??= (async () => {
      service.stopCleanup();
      await new Promise<void>((resolve, reject) => {
        // Close only this listener; draining real requests has a bounded grace period.
        const timer = setTimeout(() => server.closeAllConnections(), 2000);
        server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      });
    })();
  } catch { throw new DiagnosticCliError("BRIDGE_START_FAILED", 3); }
}
