import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = process.cwd();
const marker = "SYNTH_STARTUP_CAUSE_STACK_152";
const entrypoints = [
  "src/index.ts", "scripts/diagnose-episodic-streams.ts", "scripts/evaluate-kodi-sources.ts",
  "scripts/evaluate-stremio-providers.ts", "scripts/identity-live-smoke.ts",
  "scripts/privacy-runtime-tribler-playback.ts", "scripts/privacy-tracker-observation.mjs",
  "scripts/qa-identity-conflict-review.ts", "scripts/review-rejected-source.ts", "scripts/stress-soak.ts"
];
let directory: string;
let hook: string;
let compiled: string;

function environment(): NodeJS.ProcessEnv {
  const system = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"];
  return {
    ...Object.fromEntries(system.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    NODE_PATH: join(root, "node_modules"),
    DOTENV_CONFIG_PATH: join(directory, "synthetic.env")
  };
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "startup-initialization-"));
  hook = join(directory, "failure.mjs");
  writeFileSync(hook, `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).replaceAll('\\\\', '/').endsWith('/config/stream-ranking.default.json')) {
        const error = new Error('synthetic policy read failure');
        error.stack = '${marker}'; throw error;
      }
      return read.call(this, file, ...args);
    };
    syncBuiltinESMExports();
  `);
  writeFileSync(join(directory, "synthetic.env"), [
    "TRIBLER_URL=http://127.0.0.1:9999", "TRIBLER_API_KEY=placeholder-startup-key",
    "BRIDGE_HOST=127.0.0.1", "BRIDGE_PORT=7007", "PUBLIC_BASE_URL=http://127.0.0.1:7007"
  ].join("\n"));
  // Compile the real production program, independently of pre-existing dist/.
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json"),
    "--outDir", join(directory, "dist")], { cwd: root, timeout: 30_000, stdio: "pipe" });
  compiled = join(directory, "dist/index.js");
  mkdirSync(join(directory, "config"));
  copyFileSync(join(root, "config/stream-ranking.default.json"), join(directory, "config/stream-ranking.default.json"));
}, 40_000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

describe("controlled startup imports", () => {
  it.each([...entrypoints, "compiled index"])("sanitizes policy initialization failure: %s", entrypoint => {
    const source = entrypoint !== "compiled index";
    const args = source ? ["--import", pathToFileURL(require.resolve("tsx")).href] : [];
    args.push("--import", pathToFileURL(hook).href, source ? resolve(root, entrypoint) : compiled);
    const result = spawnSync(process.execPath, args, { cwd: directory, env: environment(), encoding: "utf8", timeout: 15_000 });
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    const diagnostic = JSON.parse(result.stderr) as { error: unknown };
    expect(diagnostic).toMatchObject({ level: "error", message: "Startup failed" });
    expect(diagnostic.error).toEqual({ type: "Error" });
    for (const secret of [marker, "synthetic policy read failure", directory, "[cause]", "unhandledRejection"])
      expect(result.stdout + result.stderr).not.toContain(secret);
  }, 20_000);

  it.each(["SIGINT", "SIGTERM"])("loads dotenv, listens and shuts down once for repeated %s", async signal => {
    const control = join(directory, `lifecycle-${signal}.mjs`);
    writeFileSync(control, `
      import {Server} from 'node:net';
      globalThis.fetch = async () => new Response('{"downloads":[]}', {headers:{'content-type':'application/json'}});
      const listen = Server.prototype.listen;
      Server.prototype.listen = function(...args) {
        console.log(JSON.stringify({fixture:'listen', port:args[0], host:args[1]}));
        args[0] = 0; return listen.apply(this,args);
      };
      process.on('message', signal => { if (signal === 'SIGINT' || signal === 'SIGTERM') {
        process.emit(signal, signal); process.emit(signal, signal);
      }});
      process.channel.unref();
    `);
    const child = spawn(process.execPath, ["--import", pathToFileURL(control).href, compiled], {
      cwd: directory, env: environment(), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true
    });
    let stdout = "", stderr = "", sent = false;
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!sent && stdout.includes("Tribler Stremio bridge listening")) { sent = true; child.send(signal); }
    });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    let timer: NodeJS.Timeout | undefined;
    try {
      const exit = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject); child.once("close", resolveExit);
        timer = setTimeout(() => reject(new Error("Synthetic startup lifecycle timed out")), 15_000);
      });
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      const lines = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toContainEqual({ fixture: "listen", port: 7007, host: "127.0.0.1" });
      expect(lines.filter(line => line.message === "Shutting down")).toHaveLength(1);
      expect(lines.find(line => line.message === "Shutting down")).toMatchObject({ signal });
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 20_000);
});
