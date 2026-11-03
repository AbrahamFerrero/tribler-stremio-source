import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { DiagnosticController } from "../../src/diagnostics/controller";
import { diagnosticHttp } from "../../src/diagnostics/http";
import { localRequestPolicy } from "../../src/local-request-policy";
import { silentLogger, syntheticAdminToken, testConfig } from "../helpers";

const auth = `Bearer ${syntheticAdminToken}`;
const options = { ttlMs: 1000, resolutions: 10, retainReport: false };
function fixture(token: string | undefined) {
  const c = new DiagnosticController(); const app = express();
  app.use(localRequestPolicy(token)); app.use("/diagnostics", diagnosticHttp(c));
  return { app, c };
}

describe("administrative diagnostic HTTP", () => {
  it("is mounted in createApp, starts OFF, and performs no upstream requests", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    try {
      const log = { ...silentLogger, error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
      const { app } = createApp(testConfig(), log, undefined, []);
      await request(app).get("/diagnostics/status").set("Authorization", auth).expect(200, { state: "OFF", reportAvailable: false });
      const malformed = await request(app).post("/diagnostics/start").set("Authorization", auth)
        .set("Content-Type", "application/json").send('{"private":"synthetic-private",').expect(400);
      const query = await request(app).post("/diagnostics/start?token=synthetic-private").set("Authorization", auth).send(options).expect(400);
      const exposure = JSON.stringify([malformed.body, query.body, log.error.mock.calls, log.warn.mock.calls, log.info.mock.calls, log.debug.mock.calls]);
      expect(exposure).not.toContain("synthetic-private"); expect(exposure).not.toContain(syntheticAdminToken);
      await request(app).post("/diagnostics/start").set("Authorization", auth).send(options).expect(200);
      await request(app).post("/diagnostics/stop").set("Authorization", auth).expect(200);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("protects all operations, disables administration without a token, and emits no CORS", async () => {
    const { app, c } = fixture(syntheticAdminToken); const disabled = fixture(undefined).app;
    for (const [method, path] of [["post", "start"], ["get", "status"], ["post", "stop"]] as const) {
      for (const credential of [undefined, `Bearer ${"b2".repeat(32)}`]) {
        const req = request(app)[method](`/diagnostics/${path}`);
        if (credential) req.set("Authorization", credential);
        const response = await req.expect(401);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined(); expect(response.headers["cache-control"]).toBe("no-store");
      }
      await request(disabled)[method](`/diagnostics/${path}`).set("Authorization", auth).expect(403);
      for (const headers of [{ Origin: "https://web.stremio.com" }, { Origin: "null" }, { Referer: "https://web.stremio.com/" },
        { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Mode": "cors" }, { "Sec-Fetch-Dest": "empty" }, { "Sec-Fetch-User": "?1" }]) {
        await request(app)[method](`/diagnostics/${path}`).set("Authorization", auth).set(headers).expect(403);
      }
      await request(app).options(`/diagnostics/${path}`).set("Authorization", auth).expect(403);
      await request(app)[method](`/diagnostics/${path}`).set("Host", "evil.example:7000").set("Authorization", auth).expect(403);
    }
    expect(c.status().state).toBe("OFF");
  });

  it("strictly validates methods, paths, bodies and parameters before effects", async () => {
    const { app, c } = fixture(syntheticAdminToken);
    for (const body of [{}, [], { ...options, resolutions: "1" }, { ...options, ttlMs: 300001 }, { ...options, resolutions: 11 },
      { ...options, retainReport: "true" }, { ...options, path: "synthetic-private" }]) {
      await request(app).post("/diagnostics/start").set("Authorization", auth).send(body).expect(400);
    }
    for (const body of ['{"secret":"synthetic-private",', JSON.stringify({ ...options, extra: "x".repeat(1100) })]) {
      const response = await request(app).post("/diagnostics/start").set("Authorization", auth).set("Content-Type", "application/json").send(body).expect(400);
      expect(response.text).not.toContain("synthetic-private");
    }
    await request(app).post("/diagnostics/start").set("Authorization", auth).type("text").send("private").expect(400);
    for (const path of ["start", "status", "stop"]) {
      const method = path === "status" ? "get" : "post";
      await request(app)[method](`/diagnostics/${path}?token=synthetic-private`).set("Authorization", auth).send(options).expect(400);
      await request(app).delete(`/diagnostics/${path}`).set("Authorization", auth).expect(405);
    }
    await request(app).head("/diagnostics/status").set("Authorization", auth).expect(405);
    await request(app).post("/diagnostics/stop").set("Authorization", auth).send({}).expect(400);
    await request(app).post("/diagnostics/Start").set("Authorization", auth).send(options).expect(404);
    expect(c.status().state).toBe("OFF");
    await request(app).post("/diagnostics/start").set("Authorization", auth).send(options).expect(200);
    await request(app).post("/diagnostics/start").set("Authorization", auth).send(options).expect(409);
    await request(app).post("/diagnostics/stop?token=synthetic-private").set("Authorization", auth).expect(400);
    expect(c.status().state).toBe("ON");
    await request(app).post("/diagnostics/stop").set("Authorization", auth).expect(200);
  });
});
