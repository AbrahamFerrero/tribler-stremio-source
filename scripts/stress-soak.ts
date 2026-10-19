import { spawn } from "node:child_process";
import { syntheticStress } from "../tests/fixtures/synthetic-stress";

async function main(): Promise<void> {
  const cycles = Number(process.argv[2] ?? 100);
  if (!Number.isInteger(cycles) || cycles < 100 || cycles > 500 || process.argv.length > 3) {
    throw new Error("Usage: npm run qa:soak -- [100..500]");
  }
  process.stdout.write(`${JSON.stringify({ node: await syntheticStress(cycles) })}\n`);
  // Keep the host as isolated as workers; never inherit ambient Tribler settings.
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  if (process.platform === "win32" && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const child = spawn("python", ["tests/stress_harness.py", "--cycles", String(cycles)], {
    cwd: "python-adapter-host", env, stdio: "inherit", windowsHide: true
  });
  const stop = (): void => { child.kill(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Python soak failed")));
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Soak failed"}\n`);
  process.exitCode = 1;
});
