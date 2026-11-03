import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticController } from "../../src/diagnostics/controller";
import { diagnosticHttp } from "../../src/diagnostics/http";
import { localRequestPolicy } from "../../src/local-request-policy";
import { DIAGNOSTIC_LIMITS as L } from "../../src/diagnostics/recorder";
import { syntheticAdminToken } from "../helpers";
const auth = `Bearer ${syntheticAdminToken}`;
function fixture(c = new DiagnosticController(), token: string | undefined = syntheticAdminToken) {
  const app = express(); app.use(localRequestPolicy(token)); app.use("/diagnostics", diagnosticHttp(c)); return { app, c };
}
describe("protected diagnostic report reads", () => {
  it("uses the unchanged administrative boundary before reading", async () => {
    const { app, c } = fixture(); const read = vi.spyOn(c, "readReport");
    await request(app).get("/diagnostics/report").expect(401);
    await request(app).get("/diagnostics/report").set("Authorization", `Bearer ${"b2".repeat(32)}`).expect(401);
    const disabled = express().use(localRequestPolicy()).use("/diagnostics", diagnosticHttp(c));
    await request(disabled).get("/diagnostics/report").set("Authorization", auth).expect(403);
    for (const headers of [{ Origin: "https://web.stremio.com" }, { Origin: "null" }, { Referer: "https://web.stremio.com/" },
      { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Mode": "cors" }, { "Sec-Fetch-Dest": "empty" }, { "Sec-Fetch-User": "?1" }]) {
      const r = await request(app).get("/diagnostics/report").set("Authorization", auth).set(headers).expect(403);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined(); expect(r.headers["cache-control"]).toBe("no-store");
    }
    await request(app).get("/diagnostics/report").set("Host", "evil.example:7000").set("Authorization", auth).expect(403);
    await request(app).options("/diagnostics/report").set("Authorization", auth).expect(403);
    expect(read).not.toHaveBeenCalled();
  });
  it("strictly rejects query, body and all methods except GET", async () => {
    const { app, c } = fixture(); const read = vi.spyOn(c, "readReport");
    for (const method of ["post", "put", "delete", "head", "patch"] as const) await request(app)[method]("/diagnostics/report").set("Authorization", auth).expect(405);
    await request(app).get("/diagnostics/report?lang=es").set("Authorization", auth).expect(400);
    await request(app).get("/diagnostics/report").set("Authorization", auth).send({}).expect(400);
    expect(read).not.toHaveBeenCalled();
  });
  it("distinguishes absent, active and expired reports, copies data and never renews retention", async () => {
    let now = 0; const { app, c } = fixture(new DiagnosticController(() => now));
    const get = () => request(app).get("/diagnostics/report").set("Authorization", auth);
    await get().expect(404).expect(({ body }) => expect(body).toMatchObject({ code: "DIAGNOSTIC_REPORT_NOT_FOUND" }));
    c.start({ ttlMs: 1000, resolutions: 1, retainReport: true }); await get().expect(409);
    const h = c.beginResolution()!; h.record({ kind: "STAGE", stage: "FINAL", count: 1 }); h.finish(); c.stop();
    const original = c.report();
    for (now of [0, 1000, 100000, L.ttlMs - 1]) {
      const r = await get().expect(200); expect(r.body).toEqual(original);
      expect(r.headers["content-type"]).toMatch(/^application\/json/); expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      (r.body as { resolutions: unknown[] }).resolutions.length = 0; expect(c.report()).toEqual(original);
    }
    now = L.ttlMs; await get().expect(410).expect(({ body }) => expect(body).toMatchObject({ code: "DIAGNOSTIC_REPORT_EXPIRED" }));
    expect(c.report()).toBeUndefined(); c.start({ ttlMs: 1000, resolutions: 1, retainReport: false }); c.stop(); await get().expect(404);
  });
  it("handles delayed capture expiry without extending the report window", () => {
    let now = 0; const c = new DiagnosticController(() => now);
    c.start({ ttlMs: 1000, resolutions: 1, retainReport: true }); now = 1000 + L.ttlMs;
    expect(c.readReport()).toEqual({ state: "EXPIRED" }); expect(new DiagnosticController().readReport()).toEqual({ state: "ABSENT" });
  });
  it("refuses invalid or oversized controller data without disclosing payloads", async () => {
    const { app, c } = fixture();
    vi.spyOn(c, "readReport").mockReturnValue({ state: "AVAILABLE", report: { version: 1, id: "private-canary".repeat(200000), state: "CLOSED", reason: "STOPPED", reserved: 0, skippedConcurrent: 0, events: 0, resolutions: [] } });
    const r = await request(app).get("/diagnostics/report").set("Authorization", auth).expect(500);
    expect(r.text).not.toContain("private-canary");
  });
});
