import express from "express";
import request from "supertest";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DiagnosticController } from "../../src/diagnostics/controller";
import { diagnosticHttp } from "../../src/diagnostics/http";
import { observeResolution } from "../../src/diagnostics/resolver-observer";
import { localRequestPolicy } from "../../src/local-request-policy";
import { runDiagnosticCli } from "../../src/diagnostics/cli";
import { validatePrivateReport, anonymizeDiagnosticExport } from "../../src/diagnostics/private-context";
import { syntheticAdminToken } from "../helpers";

const options = { ttlMs: 1000, resolutions: 1, retainReport: true };
const auth = `Bearer ${syntheticAdminToken}`;
function application(c: DiagnosticController, token: string | undefined = syntheticAdminToken) {
  const app = express(); app.use(localRequestPolicy(token)); app.use("/diagnostics", diagnosticHttp(c)); return app;
}
function capture(c: DiagnosticController) {
  const observation = observeResolution(c.beginResolution()!);
  observation.request!({ id: "query-not-exported", kind: "episode", title: "Private episode title canary", season: 2, episode: 3, externalIds: {} });
  observation.registry!.configured(0, "registered_name_canary", "Private provider name canary", true);
  observation.registry!.state(0, "INVOKED"); observation.registry!.counts(0, 0, 0); observation.registry!.state(0, "RETURNED_ZERO");
  observation.finish(false);
}
describe("explicit private diagnostic authority", () => {
  it("protects private operations with the identical native Bearer/context boundary and no CORS", async () => {
    const c = new DiagnosticController(); const app = application(c);
    for (const path of ["/private/start", "/private/report"]) {
      const method = path.endsWith("start") ? "post" : "get";
      await request(app)[method]("/diagnostics" + path).expect(401);
      for (const headers of [{ Origin: "https://web.stremio.com" }, { Referer: "https://web.stremio.com/" }, { "Sec-Fetch-Site": "none" }]) {
        const response = await request(app)[method]("/diagnostics" + path).set("Authorization", auth).set(headers).expect(403);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
      await request(application(new DiagnosticController(), undefined))[method]("/diagnostics" + path).expect(401);
    }
    const noToken = express(); noToken.use(localRequestPolicy()); noToken.use("/diagnostics", diagnosticHttp(c));
    await request(noToken).get("/diagnostics/private/report").set("Authorization", auth).expect(403);
    expect(c.status().state).toBe("OFF");
  });

  it("validates methods/query/body; normal endpoints cannot opt into or reveal private context", async () => {
    const c = new DiagnosticController(); const app = application(c);
    await request(app).get("/diagnostics/private/start").set("Authorization", auth).expect(405);
    await request(app).head("/diagnostics/private/report").set("Authorization", auth).expect(405);
    await request(app).get("/diagnostics/private/report?private=true").set("Authorization", auth).expect(400);
    await request(app).get("/diagnostics/private/report").set("Authorization", auth).send({ private: true }).expect(400);
    await request(app).post("/diagnostics/start").set("Authorization", auth).send({ ...options, private: true }).expect(400);
    await request(app).post("/diagnostics/private/start").set("Authorization", auth).send(options).expect(200);
    capture(c); await request(app).post("/diagnostics/stop").set("Authorization", auth).expect(200);
    const normal = await request(app).get("/diagnostics/report").set("Authorization", auth).expect(200);
    const privateResponse = await request(app).get("/diagnostics/private/report").set("Authorization", auth).expect(200);
    const privateReport = validatePrivateReport(privateResponse.body);
    expect(privateReport.context[0]).toMatchObject({ title: "Private episode title canary", season: 2, episode: 3, providers: [{ id: "registered_name_canary" }] });
    expect(anonymizeDiagnosticExport(privateReport)).toEqual(normal.body);
    for (const response of [normal, await request(app).get("/diagnostics/status").set("Authorization", auth).expect(200)]) {
      for (const value of ["Private episode title canary", "Private provider name canary", "registered_name_canary", "query-not-exported"]) expect(response.text).not.toContain(value);
    }
    expect(privateResponse.headers["cache-control"]).toBe("no-store"); expect(privateResponse.headers["access-control-allow-origin"]).toBeUndefined();
    expect(privateResponse.headers.etag).toBeUndefined();
  });

  it("refuses retroactive context and clears private retention on deadline or next anonymous session", async () => {
    let now = 0; const c = new DiagnosticController(() => now); const app = application(c);
    await request(app).post("/diagnostics/start").set("Authorization", auth).send(options).expect(200); capture(c); c.stop();
    await request(app).get("/diagnostics/private/report").set("Authorization", auth).expect(404);
    await request(app).post("/diagnostics/private/start").set("Authorization", auth).send(options).expect(200); capture(c); c.stop();
    const first = await request(app).get("/diagnostics/private/report").set("Authorization", auth).expect(200);
    const repeat = await request(app).get("/diagnostics/private/report").set("Authorization", auth).expect(200); expect(repeat.body).toEqual(first.body);
    now = 300000; await request(app).get("/diagnostics/private/report").set("Authorization", auth).expect(410);
    await request(app).post("/diagnostics/start").set("Authorization", auth).send(options).expect(200); c.stop();
    await request(app).get("/diagnostics/private/report").set("Authorization", auth).expect(404);
  });

  it("supports one-command private capture and explicit anonymous/private advanced export without leaking context to default CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-private-")); const c = new DiagnosticController(); const app = express();
    app.use((req, _res, next) => { if (req.path === "/diagnostics/status" && c.status().state === "ON" && c.status().reserved === 0) capture(c); next(); });
    app.use(application(c)); const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const run = async (args: string[]) => {
      const out: string[] = [], errors: string[] = [];
      const code = await runDiagnosticCli([...args, "--bridge", `http://127.0.0.1:${address.port}`], { BRIDGE_ADMIN_TOKEN: syntheticAdminToken }, { out: s => out.push(s), error: s => errors.push(s) });
      expect([...out, ...errors].join()).not.toContain("Private episode title canary"); return { code, out, errors };
    };
    try {
      const output = join(root, "private.html"); expect((await run(["capture", "--next", "1", "--ttl", "10", "--mode", "private", "--output", output])).code).toBe(0);
      const html = await readFile(output, "utf8"); expect(html).toContain("Private episode title canary"); expect(html).toContain("PRIVATE LOCAL REPORT");
      expect((await run(["export", "--format", "json", "--output", join(root, "anonymous.json")])).code).toBe(0);
      expect((await run(["export", "--format", "json", "--mode", "private", "--output", join(root, "private.json")])).code).toBe(0);
      const privateReport = validatePrivateReport(JSON.parse(await readFile(join(root, "private.json"), "utf8")) as unknown);
      expect(anonymizeDiagnosticExport(privateReport)).toEqual(JSON.parse(await readFile(join(root, "anonymous.json"), "utf8")));
      expect((await run(["report"])).code).toBe(0); expect((await run(["report", "--mode", "private"])).out.join()).toContain("PRIVATE LOCAL REPORT");
      expect((await run(["start", "--next", "1", "--ttl", "10", "--retain", "--mode", "invalid"])).code).toBe(2);
      expect((await readdir(root)).sort()).toEqual(["anonymous.json", "private.html", "private.json"]);
    } finally { c.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
});
