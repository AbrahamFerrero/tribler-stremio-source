import { createRequire } from "node:module";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const lint = new ESLint({ cwd: root });

describe("lint tooling security migration", () => {
  it("keeps critical typed rules effective on synthetic violations", async () => {
    const results = await lint.lintText(`
      export function unsafe(value: any) {
        const unused = 1;
        const assigned: string = value;
        value.call();
        Promise.resolve(assigned);
        [1].filter(async () => true);
        return value;
      }
      export async function invalidAwait() { await 42; }
    `, { filePath: path.join(root, "tests/lint-tooling.test.ts") });
    const messages = results.flatMap(result => result.messages);
    expect(messages.filter(message => message.fatal)).toEqual([]);
    for (const rule of [
      "no-explicit-any", "no-unused-vars", "no-unsafe-assignment",
      "no-unsafe-call", "no-unsafe-member-access", "no-unsafe-return",
      "no-floating-promises", "no-misused-promises", "await-thenable"
    ]) {
      expect(messages.some(message => message.ruleId === `@typescript-eslint/${rule}`
        && message.severity === 2), rule).toBe(true);
    }
  }, 30_000);

  it("accepts a typed safe counterpart and retains base JS rules", async () => {
    const results = await lint.lintText(`
      export async function safe(value: string): Promise<string> {
        await Promise.resolve(value);
        return value;
      }
    `, { filePath: path.join(root, "tests/lint-tooling.test.ts") });
    expect(results.flatMap(result => result.messages)).toEqual([]);
    const js = await lint.lintText("missingSyntheticGlobal();", {
      filePath: path.join(root, "vitest.coverage.config.mjs")
    });
    expect(js.flatMap(result => result.messages).some(message => message.ruleId === "no-undef"
      && message.severity === 2)).toBe(true);
  }, 30_000);

  it("resolves patched named exports from every actual Minimatch consumer", () => {
    const require = createRequire(path.join(root, "package.json"));
    for (const consumer of ["eslint", "@eslint/config-array", "@typescript-eslint/typescript-estree"]) {
      const consumerRequire = createRequire(require.resolve(consumer));
      // Exercise the CommonJS entry used by ESLint and TypeScript ESLint.
      const api = consumerRequire("minimatch") as typeof import("minimatch");
      const manifest = consumerRequire("minimatch/package.json") as { version: string };
      expect(Number(manifest.version.split(".")[0])).toBeGreaterThanOrEqual(11);
      expect(api.minimatch("src/example.ts", "**/*.ts")).toBe(true);
      expect(api.minimatch("src/example.js", "**/*.ts")).toBe(false);
      const matcher = new api.Minimatch("**/*.ts", { dot: true, matchBase: true });
      expect(matcher.match(".synthetic/example.ts")).toBe(true);
      expect(matcher.match("src/example.js")).toBe(false);
      expect(matcher.match(".synthetic", true)).toBe(true);
      expect(matcher.set.length).toBeGreaterThan(0);
    }
  });
});

