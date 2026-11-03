import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { get, request, createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runDiagnosticCli } from "../../src/diagnostics/cli";
import { validateDiagnosticReport } from "../../src/diagnostics/report-model";
import { syntheticAdminToken } from "../helpers";

it.each(["ttl", "quota", "owner", "interrupt", "export-failure"])("runs the actual no-argument entrypoint with its own bridge, EOF and %s export", async finish => {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-entrypoint-"));
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const address = reservation.address(); if (!address || typeof address === "string") throw new Error();
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  await mkdir(join(root, "config"));
  await writeFile(join(root, "config/diagnostic.local.json"), JSON.stringify({ next: 5, ttlSeconds: finish === "ttl" ? 1 : 10 }));
  await writeFile(join(root, "config/catalog-sources.local.json"), JSON.stringify({ version: 1,
    providers: [{ kind: "static", id: "synthetic", name: "Invented fixture", items: [] }] }));
  // Test-only signal delivery over a private parent/child channel. Windows kill(SIGINT)
  // terminates processes rather than exercising async handlers; no production hook is added.
  const control = join(root, "control.cjs");
  await writeFile(control, 'process.on("message", message => { if (message === "interrupt") { process.emit("SIGINT"); process.emit("SIGINT"); } }); process.channel.unref();');
  const inherited: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[key]) inherited[key] = process.env[key]!;
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(process.cwd(), "node_modules/tsx/dist/loader.mjs")).href,
    "--import", pathToFileURL(control).href, join(process.cwd(), "scripts/diagnostic.ts")], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...inherited, BRIDGE_PORT: String(port), BRIDGE_ADMIN_TOKEN: syntheticAdminToken,
      TRIBLER_URL: "http://127.0.0.1:1", STREAM_PROVIDERS: "manual", CI: "1" } });
  let stdout = "", stderr = "";
  let ready: (() => void) | undefined;
  const armed = new Promise<void>(resolve => { ready = resolve; });
  let saved: (() => void) | undefined;
  const exported = new Promise<void>(resolve => { saved = resolve; });
  child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; if (stdout.includes("Capture armed.")) ready?.(); if (stdout.includes("Bridge remains running;")) saved?.(); });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const closed = once(child, "close");
  child.stdin!.end(); // A real closed pipe must not finish the session.
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    if (finish === "quota") {
      await Promise.race([armed, closed.then(() => { throw new Error(`Fixture exited before capture: ${stderr}`); })]);
      for (let i = 0; i < 5; i++) {
        const status = await new Promise<number | undefined>((resolve, reject) => {
          get(`http://127.0.0.1:${port}/stream/movie/synthetic-local-fixture.json`,
            { headers: { Origin: "https://web.stremio.com" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
        });
        expect(status).toBe(200);
      }
    }
    if (finish === "owner" || finish === "export-failure") {
      await Promise.race([armed, closed.then(() => { throw new Error("Fixture exited before capture"); })]);
      const administrative = (path: string, authorized: boolean) => new Promise<number | undefined>((resolve, reject) => {
        const body = path.endsWith("start") ? JSON.stringify({ ttlMs: 10000, resolutions: 1, retainReport: true }) : undefined;
        const req = request({ hostname: "127.0.0.1", port, path: `/diagnostics/${path}`, method: "POST",
          headers: { ...(authorized ? { Authorization: `Bearer ${syntheticAdminToken}` } : {}),
            ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) } },
        res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject); req.end(body);
      });
      expect(await administrative("start", false)).toBe(401);
      if (finish === "export-failure") await rm(join(root, ".cache/diagnostic-reports"), { recursive: true });
      expect(await administrative("stop", true)).toBe(200);
      // An unconditional legacy start would erase the owned retained report here.
      expect(await administrative("start", true)).toBe(409);
      expect(await administrative("private/start", true)).toBe(409);
    }
    if (finish === "interrupt") {
      await Promise.race([armed, closed.then(() => { throw new Error("Fixture exited before capture"); })]);
      child.send("interrupt");
      expect((await closed)[0]).toBe(130);
    } else {
      await Promise.race([exported, closed.then(() => { throw new Error(`Service exited after capture: ${stderr}`); })]);
      expect(child.exitCode).toBeNull();
      if (finish === "export-failure") {
        expect(stderr).toContain("EXPORT_FAILED:");
        await vi.waitFor(() => expect(stderr).toContain("The owned bridge remains available."));
      } else expect(stderr).toBe("");
      const json = (path: string, admin = false) => new Promise<unknown>((resolve, reject) => {
        get(`http://127.0.0.1:${port}${path}`, { headers: admin ? { Authorization: `Bearer ${syntheticAdminToken}` } : { Origin: "https://web.stremio.com" } }, res => {
          let body = ""; res.setEncoding("utf8"); res.on("data", (chunk: string) => { body += chunk; });
          res.on("end", () => { try { expect(res.statusCode).toBe(200); resolve(JSON.parse(body) as unknown); } catch (error) { reject(error instanceof Error ? error : new Error("Invalid synthetic JSON response")); } });
        }).on("error", reject);
      });
      expect(await json("/diagnostics/status", true)).toEqual({ state: "OFF", reportAvailable: true });
      const before = await json("/diagnostics/report", true);
      expect(await json("/stream/movie/synthetic-after-export.json")).toMatchObject({ streams: [] });
      expect(await json("/diagnostics/report", true)).toEqual(before);
      expect(await json("/diagnostics/status", true)).toEqual({ state: "OFF", reportAvailable: true });
    }
    const directory = join(root, ".cache/diagnostic-reports");
    if (finish === "export-failure") {
      await mkdir(directory);
      const errors: string[] = [];
      expect(await runDiagnosticCli(["export", "--format", "html", "--output", join(directory, "recovered.html"),
        "--bridge", `http://127.0.0.1:${port}`], { BRIDGE_ADMIN_TOKEN: syntheticAdminToken },
        { out: () => undefined, error: line => errors.push(line) })).toBe(0);
      expect(errors).toEqual([]);
    }
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const html = await readFile(join(directory, files[0]!), "utf8");
    const report = validateDiagnosticReport(JSON.parse(/<script id="diagnostic-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!) as unknown);
    expect(report.reason).toBe(finish === "ttl" ? "EXPIRED" : "STOPPED");
    expect(report.resolutions).toHaveLength(finish === "quota" ? 5 : 0);
    if (finish !== "export-failure") expect(stdout).toContain(join(directory, files[0]!));
    for (const text of [stdout, stderr, html]) expect(text).not.toContain(syntheticAdminToken);
    if (finish !== "interrupt") {
      child.send("interrupt");
      expect((await closed)[0]).toBe(finish === "export-failure" ? 5 : 130);
    }
    expect(await readdir(directory)).toEqual(files);
    expect(stdout.match(/Report exported\./g) ?? []).toHaveLength(finish === "export-failure" ? 0 : 1);
    // Only the explicit shutdown releases the owned TCP listener.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer(); probe.once("error", reject); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
