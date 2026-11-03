import express, { type RequestHandler } from "express";
import { DiagnosticController, validDiagnosticStart } from "./controller";
import { DIAGNOSTIC_LIMITS } from "./recorder";
import { diagnosticId, serializeDiagnosticReport } from "./report-model";
import { validatePrivateReport } from "./private-context";

/** Mount only after localRequestPolicy. No caller-supplied paths or export actions. */
export function diagnosticHttp(controller: DiagnosticController): RequestHandler {
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Diagnostic-Protocol", "owned-session-v1");
    const expected = ["/status", "/report", "/private/report"].includes(req.path) ? "GET" : ["/start", "/stop", "/private/start"].includes(req.path) ? "POST" : undefined;
    if (!expected) { res.status(404).json({ error: "Not found" }); return; }
    if (req.method !== expected) { res.setHeader("Allow", expected); res.status(405).json({ error: "Method not allowed" }); return; }
    if (req.url.includes("?") || (!["/start", "/private/start"].includes(req.path) &&
        (req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")))) {
      res.status(400).json({ error: "Invalid diagnostic parameters" }); return;
    }
    next();
  });
  router.use(express.json({ limit: "1kb", strict: true }));
  router.post(["/start", "/private/start"], (req, res) => {
    if (!req.is("application/json") || !validDiagnosticStart(req.body)) {
      res.status(400).json({ error: "Invalid diagnostic parameters" }); return;
    }
    const preserve = req.headers["x-diagnostic-preserve-report"];
    if (preserve !== undefined && preserve !== "true") { res.status(400).json({ error: "Invalid diagnostic parameters" }); return; }
    // Synchronous check/start prevents a guided session from erasing a retained report.
    if (preserve && controller.status().reportAvailable) { res.status(409).json({ error: "Retained report exists" }); return; }
    const result = controller.start(req.body, req.path === "/private/start");
    res.status(result === "ACTIVE" ? 409 : 200).json(controller.status());
  });
  router.get("/status", (_req, res) => { res.json(controller.status()); });
  router.get(["/report", "/private/report"], (req, res) => {
    const privateReport = req.path === "/private/report";
    const result = privateReport ? controller.readPrivateReport() : controller.readReport();
    if (result.state !== "AVAILABLE") {
      const errors = {
        ACTIVE: [409, "DIAGNOSTIC_CAPTURE_ACTIVE", "Capture is still active"],
        ABSENT: [404, "DIAGNOSTIC_REPORT_NOT_FOUND", "No retained report"],
        EXPIRED: [410, "DIAGNOSTIC_REPORT_EXPIRED", "Retained report expired"]
      } as const;
      const [status, code, error] = errors[result.state];
      res.status(status).json({ error, code }); return;
    }
    let json: string;
    try { json = privateReport ? JSON.stringify(validatePrivateReport(result.report)) : serializeDiagnosticReport(result.report); }
    catch { res.status(500).json({ error: "Report unavailable", code: "DIAGNOSTIC_REPORT_UNAVAILABLE" }); return; }
    if (Buffer.byteLength(json) > DIAGNOSTIC_LIMITS.dtoBytes) {
      res.status(500).json({ error: "Report unavailable", code: "DIAGNOSTIC_REPORT_UNAVAILABLE" }); return;
    }
    if (privateReport) {
      // Do not generate an Express ETag derived from sensitive private context.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", Buffer.byteLength(json));
      res.end(json);
    } else res.type("application/json").send(json);
  });
  router.post("/stop", (req, res) => {
    const expected = req.headers["x-diagnostic-session"];
    if (expected !== undefined) {
      if (!diagnosticId(expected)) { res.status(400).json({ error: "Invalid diagnostic parameters" }); return; }
      const current = controller.status();
      if (current.state === "ON" && current.id !== expected) { res.status(409).json({ error: "Session changed" }); return; }
    }
    controller.stop(); res.json(controller.status());
  });
  // Parser failures have a fixed response and never log request content.
  router.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "Invalid diagnostic parameters" });
  });
  return router;
}
