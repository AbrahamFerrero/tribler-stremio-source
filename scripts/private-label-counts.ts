import { open } from "node:fs/promises";
import { DIAGNOSTIC_LIMITS } from "../src/diagnostics/recorder";
import { privateLabelCounts } from "../src/diagnostics/private-label-counts";

// Separate opt-in tool; ordinary diagnostic CLI/logging/telemetry are unchanged.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--private-local" || !args[1]) throw new Error();
  const file = await open(args[1], "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error();
    const bytes = Buffer.alloc(DIAGNOSTIC_LIMITS.dtoBytes + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > DIAGNOSTIC_LIMITS.dtoBytes) throw new Error();
    const counts = privateLabelCounts(JSON.parse(bytes.subarray(0, used).toString("utf8")));
    process.stdout.write(JSON.stringify(counts, null, 2) + "\n");
  } finally { await file.close(); }
}
void main().catch(() => {
  // Never echo paths, parser diagnostics or rejected input.
  process.stderr.write("PRIVATE_LABEL_COUNTS_FAILED\n"); process.exitCode = 1;
});
