import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const scanAll = process.argv.includes("--all");
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const allowedMagnets = new Set([
  "08ada5a7a6183aae1e09d831df6748d566095a10", // Sintel documentation fixture
  "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", // Big Buck Bunny fixture
  "0123456789abcdef0123456789abcdef01234567", // synthetic fixture
]);

function git(args: string[]): Buffer {
  return execFileSync("git", args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

interface IndexEntry {
  mode: string;
  oid: string;
  stage: string;
}

function nulList(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function indexEntries(): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const record of nulList(git(["ls-files", "--stage", "-z"]))) {
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !oid || !stage) throw new Error("Cannot classify Git index entry");
    const path = record.slice(tab + 1);
    if (entries.has(path)) throw new Error(`${path}: unresolved Git index entries`);
    entries.set(path, { mode, oid, stage });
  }
  return entries;
}

const root = resolve(git(["rev-parse", "--show-toplevel"]).toString("utf8").trim());
process.chdir(root);

function listedFiles(entries: Map<string, IndexEntry>): string[] {
  return scanAll
    ? [...new Set([...entries.keys(), ...nulList(git(["ls-files", "--others", "--exclude-standard", "-z"]))])]
    : nulList(git(["diff", "--cached", "--name-only", "--diff-filter=ACMRTU", "-z"]));
}

function registeredWorktrees(): Set<string> {
  return new Set(nulList(git(["worktree", "list", "--porcelain", "-z"]))
    .filter((field) => field.startsWith("worktree "))
    .map((field) => resolve(field.slice("worktree ".length))));
}

function contentFor(path: string, entry: IndexEntry | undefined, worktrees: Set<string>): Buffer | undefined {
  // Git symlinks and gitlinks must never be interpreted as ordinary blobs, even on
  // Windows checkouts with core.symlinks=false. The staged hook uses index metadata.
  if (entry && (entry.stage !== "0" || !["100644", "100755"].includes(entry.mode))) {
    throw new Error(`unsupported Git entry (mode ${entry.mode}, stage ${entry.stage})`);
  }
  if (!scanAll) {
    if (!entry) throw new Error("missing Git index entry");
    const size = Number(git(["cat-file", "-s", entry.oid]).toString("ascii").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("cannot classify Git blob size");
    if (size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
    return git(["cat-file", "blob", entry.oid]);
  }

  const local = path.endsWith("/") ? path.slice(0, -1) : path;
  const absolute = resolve(root, local);
  const rel = relative(root, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path escapes repository root");
  }
  const parts = rel.split(sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]!);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      // Only missing tracked files are intentional working-tree deletions.
      if (entry && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`cannot classify filesystem entry (${(error as NodeJS.ErrnoException).code ?? "unknown"})`);
    }
    if (stat.isSymbolicLink()) throw new Error("symbolic link/reparse point is not a publishable regular file");
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error("non-directory ancestor");
      if (worktrees.has(current)) throw new Error("path enters another registered worktree");
      continue;
    }
    if (stat.isDirectory()) {
      if (!entry && worktrees.has(absolute)) return undefined;
      throw new Error("unrecognized directory; expected a regular file or registered worktree");
    }
    if (!stat.isFile()) throw new Error("non-regular filesystem entry");
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  return readFileSync(absolute);
}

function unsafePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (normalized === ".env.example") return undefined;
  const rules: Array<[RegExp, string]> = [
    [/(^|\/)\.env($|\.)/i, "environment file"],
    [/(^|\/)inspection-input(\/|$)|(^|\/)\.inspection-work(\/|$)/i, "inspection material"],
    [/(^|\/)kodi-addons(\/|$)|(^|\/)kodi-data(\/|$)/i, "Kodi addon/profile data"],
    [/(^|\/)settings\.json$/i, "private settings filename"],
    [/\.(zip|rar|7z|log|db|sqlite|sqlite3|pem|key|p12|pfx)$/i, "sensitive/binary artifact"],
    [/(^|\/)(\.npmrc|\.pypirc|\.netrc)$/i, "credential-bearing config"],
  ];
  return rules.find(([pattern]) => pattern.test(normalized))?.[1];
}

function inspectText(path: string, text: string): string[] {
  const failures: string[] = [];
  if (/C:\\Users\\[^\\\s]+|\/Users\/[^/\s]+/.test(text)) failures.push("personal home path");
  const highConfidence = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bghp_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  if (highConfidence.some((pattern) => pattern.test(text))) failures.push("high-confidence credential");

  for (const match of text.matchAll(/TRIBLER_API_KEY\s*=\s*["']?([^\s"'#]+)/g)) {
    const value = match[1];
    if (value && !/^(replace-|TU_CLAVE|example|placeholder)/i.test(value)) {
      failures.push("non-placeholder Tribler API key");
    }
  }

  for (const match of text.matchAll(/magnet:\?[^\s"'`]*?xt=urn:btih:([0-9a-fA-F]{40})/g)) {
    const value = match[1];
    if (!value) continue;
    const hash = value.toLowerCase();
    const syntheticRepeated = /^([a-f0-9])\1{39}$/.test(hash);
    if (!allowedMagnets.has(hash) && !syntheticRepeated) failures.push("unapproved magnet fixture");
  }
  return failures.map((reason) => `${path}: ${reason}`);
}

const failures: string[] = [];
try {
  const entries = indexEntries();
  const worktrees = scanAll ? registeredWorktrees() : new Set<string>();
  for (const path of listedFiles(entries)) {
    const reason = unsafePath(path);
    if (reason) {
      failures.push(`${path}: ${reason}`);
      continue;
    }
    try {
      const content = contentFor(path, entries.get(path), worktrees);
      if (!content) continue;
      if (content.length > MAX_FILE_BYTES) {
        failures.push(`${path}: file exceeds ${MAX_FILE_BYTES} bytes`);
        continue;
      }
      if (content.includes(0)) continue;
      failures.push(...inspectText(path, content.toString("utf8")));
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : "cannot safely inspect entry"}`);
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : "cannot enumerate repository entries");
}

if (failures.length) {
  process.stderr.write(`Repository safety check failed:\n- ${[...new Set(failures)].join("\n- ")}\n`);
  process.exit(1);
}

process.stdout.write(`Repository safety check passed (${scanAll ? "all publishable files" : "staged files"}).\n`);
