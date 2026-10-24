import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const project = resolve(__dirname, "../..");
const scanner = join(project, "scripts/check-repository-safety.ts");
const temporary: string[] = [];
// Each sequential scan permits 15 s; reserve another 5 s for fixture Git/I/O.
const oneScanBudgetMs = 15_000 + 5_000;
const twoScanBudgetMs = 2 * 15_000 + 5_000;
const threeScanBudgetMs = 3 * 15_000 + 5_000;
// Four sequential scan() calls can each consume 15 s; allow 5 s for fixture Git/I/O.
const fourScanBudgetMs = 4 * 15_000 + 5_000;
// All repositories and linked checkouts below are disposable synthetic fixtures.
// No command targets the real project's Git metadata or its existing worktrees.
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "repository-qa-"));
  temporary.push(root);
  git(root, "init", "--quiet");
  put(root, "safe.txt", "synthetic public fixture\n");
  git(root, "add", "safe.txt");
  git(root, "-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--quiet", "-m", "fixture");
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function put(root: string, name: string, content = "synthetic\n"): void {
  writeFileSync(join(root, name), content);
}
function scan(root: string, all = true) {
  const result = spawnSync(process.execPath, [require.resolve("tsx/cli"), scanner, ...(all ? ["--all"] : [])], {
    cwd: root, encoding: "utf8", timeout: 15000
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
function fails(root: string, reason: RegExp, all = true): void {
  const result = scan(root, all);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toMatch(reason);
  expect(result.output).not.toContain("EISDIR");
  expect(result.output).not.toContain("check passed");
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository safety CLI integration (synthetic Git repositories)", () => {
  it.each(["tracked", "untracked", "large", "staged"] as const)("accepts regular tracked and publishable untracked files (%s)", (scenario) => {
    const root = fixture();
    if (scenario !== "tracked") put(root, "new public file.ts", "export const value = 1;\n");
    // A publishable blob between Git's former 1 MiB buffer and our 2 MiB limit.
    if (scenario === "large" || scenario === "staged") put(root, "large-public.txt", "x".repeat(1024 * 1024 + 1));
    if (scenario === "staged") git(root, "add", ".");
    expect(scan(root, scenario !== "staged").status).toBe(0);
  }, oneScanBudgetMs);

  it("skips only registered worktree roots without inspecting private contents", () => {
    const root = fixture();
    const checkout = join(root, "local checkouts", "linked");
    git(root, "worktree", "add", "--detach", checkout, "HEAD");
    put(checkout, ".env", "TRIBLER_API_KEY=" + "synthetic-private-value\n");
    expect(scan(root).status).toBe(0);
    put(root, "danger.txt", "ghp_" + "X".repeat(36));
    fails(root, /high-confidence credential/);
    // A worktree cannot mask a dangerous file beside it, even in .worktrees/.
    rmSync(join(root, "danger.txt"));
    mkdirSync(join(root, ".worktrees"));
    put(root, ".worktrees/danger.txt", "ghp_" + "X".repeat(36));
    fails(root, /high-confidence credential/);
  }, threeScanBudgetMs);

  it("rejects an unregistered nested Git repository rather than reading it", () => {
    const root = fixture();
    const nested = join(root, "unknown checkout");
    mkdirSync(nested);
    git(nested, "init", "--quiet");
    put(nested, "private.txt", "ghp_" + "X".repeat(36));
    fails(root, /unrecognized directory/);
  }, oneScanBudgetMs);

  it("rejects a tracked file replaced by an ordinary directory", () => {
    const root = fixture();
    rmSync(join(root, "safe.txt"));
    mkdirSync(join(root, "safe.txt"));
    fails(root, /unrecognized directory/);
  }, oneScanBudgetMs);

  it.each([true, false])("rejects sensitive filenames and credentials (all=%s)", (all) => {
    const root = fixture();
    put(root, ".env.private", "synthetic only");
    if (!all) git(root, "add", ".env.private");
    fails(root, /environment file/, all);
    rmSync(join(root, ".env.private"));
    if (!all) git(root, "reset", "--quiet");
    put(root, "credentials.txt", "ghp_" + "X".repeat(36));
    if (!all) git(root, "add", "credentials.txt");
    fails(root, /high-confidence credential/, all);
  }, twoScanBudgetMs);

  it("reads staged blobs even when working tree contents are safe or deleted", () => {
    const root = fixture();
    put(root, "safe.txt", "ghp_" + "X".repeat(36));
    git(root, "add", "safe.txt");
    put(root, "safe.txt", "safe again");
    fails(root, /high-confidence credential/, false);
    expect(scan(root).status).toBe(0);
    rmSync(join(root, "safe.txt"));
    fails(root, /high-confidence credential/, false);
    expect(scan(root).status).toBe(0);
  }, fourScanBudgetMs);

  it("handles deleted working tree files and staged deletions", () => {
    const root = fixture();
    rmSync(join(root, "safe.txt"));
    expect(scan(root).status).toBe(0);
    git(root, "add", "-u");
    expect(scan(root, false).status).toBe(0);
  }, twoScanBudgetMs);

  it.each(["space name.txt", "[special] # ü ' name.txt", "-option.txt"]) ("handles literal Git filename %s", (name) => {
    const root = fixture();
    put(root, name);
    expect(scan(root).status).toBe(0);
    git(root, "add", "--", name);
    expect(scan(root, false).status).toBe(0);
    put(root, name, "ghp_" + "X".repeat(36));
    fails(root, /high-confidence credential/);
    git(root, "add", "--", name);
    fails(root, /high-confidence credential/, false);
  }, fourScanBudgetMs);

  it.each([true, false])("rejects Git symlink mode even with an ordinary Windows checkout file (all=%s)", (all) => {
    const root = fixture();
    const oid = git(root, "rev-parse", "HEAD:safe.txt").trim();
    git(root, "update-index", "--add", "--cacheinfo", `120000,${oid},link.txt`);
    put(root, "link.txt", "safe.txt");
    fails(root, /unsupported Git entry \(mode 120000/, all);
  }, oneScanBudgetMs);

  // Both modes perform one scan; allow its 15 s limit plus 5 s for fixture Git/I/O.
  for (const all of [true, false]) {
    it(`rejects Git submodule/gitlink mode (all=${all})`, () => {
      const root = fixture();
      const oid = git(root, "rev-parse", "HEAD").trim();
      git(root, "update-index", "--add", "--cacheinfo", `160000,${oid},module`);
      fails(root, /unsupported Git entry \(mode 160000/, all);
    }, oneScanBudgetMs);
  }

  it("protects the hook against staged regular-file to symlink type changes", () => {
    const root = fixture();
    const oid = git(root, "rev-parse", "HEAD:safe.txt").trim();
    git(root, "update-index", "--cacheinfo", `120000,${oid},safe.txt`);
    fails(root, /unsupported Git entry \(mode 120000/, false);
  }, oneScanBudgetMs);

  it("fails clearly for unresolved index stages", () => {
    const root = fixture();
    const oid = git(root, "rev-parse", "HEAD:safe.txt").trim();
    git(root, "update-index", "--force-remove", "safe.txt");
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: root, input: `100644 ${oid} 1\tsafe.txt\n100644 ${oid} 2\tsafe.txt\n`
    });
    fails(root, /unresolved Git index entries/);
    fails(root, /unresolved Git index entries/, false);
  }, twoScanBudgetMs);

  // Two 15 s scans plus 5 s for two Git fixtures and junction/index I/O.
  it("rejects filesystem junctions before following their targets", () => {
    const root = fixture();
    const outside = fixture();
    put(outside, "private.txt", "ghp_" + "X".repeat(36));
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    fails(root, /symbolic link\/reparse point/);
    // Also check a symlink ancestor of a tracked file.
    git(root, "update-index", "--add", "--cacheinfo", `100644,${git(root, "rev-parse", "HEAD:safe.txt").trim()},linked/private.txt`);
    fails(root, /symbolic link\/reparse point/);
  }, 35_000);

  it.each(["settings.json", "artifact.zip", ".inspection-work/private.txt"]) ("keeps forbidden artifact/path protection for %s", (name) => {
    const root = fixture();
    if (name.includes("/")) mkdirSync(join(root, ".inspection-work"));
    put(root, name);
    fails(root, /private settings|sensitive\/binary artifact|inspection material/);
    git(root, "add", "--", name);
    fails(root, /private settings|sensitive\/binary artifact|inspection material/, false);
  }, 35_000);

  it.each([
    ["size limit", "x".repeat(2 * 1024 * 1024 + 1), /file exceeds/],
    ["Tribler key", "TRIBLER_API_KEY=" + "synthetic-not-placeholder", /non-placeholder Tribler/],
    ["private-key", "-----BEGIN " + "PRIVATE KEY-----", /high-confidence credential/],
    ["magnet", "magnet:?xt=urn:btih:" + "1234567890abcdef".repeat(2) + "12345678", /unapproved magnet/]
  ] as const)("keeps %s checks in working tree and staged blobs", (_name, content, reason) => {
    const root = fixture();
    put(root, "payload.txt", content);
    fails(root, reason);
    git(root, "add", "payload.txt");
    fails(root, reason, false);
  }, twoScanBudgetMs);
});

describe("ESLint project scope", () => {
  // Include cold TypeScript ESLint configuration loading (observed >9 s under load).
  it("ignores local checkouts and inspection material while retaining project sources", async () => {
    const eslint = new ESLint({ cwd: project });
    for (const path of [".worktrees/other/src/example.ts", ".inspection-work/private.ts", "python-adapter-host/.inspection-work/private.ts"]) {
      expect(await eslint.isPathIgnored(join(project, path)), path).toBe(true);
    }
    for (const path of ["src/app.ts", "scripts/check-repository-safety.ts", "tests/security/repository-safety.test.ts"]) {
      expect(await eslint.isPathIgnored(join(project, path)), path).toBe(false);
    }
    expect(readFileSync(join(project, ".githooks/pre-commit"), "utf8")).toContain("tsx scripts/check-repository-safety.ts");
  }, 15_000);
});
