import { config } from "dotenv";
import { parseDiagnosticCommand, runDiagnosticCli } from "../src/diagnostics/cli";

try {
  if (!["demo", "help"].includes(parseDiagnosticCommand(process.argv.slice(2)).operation)) config({ quiet: true });
} catch { /* The CLI reports argument errors without loading local secrets. */ }

void runDiagnosticCli(process.argv.slice(2), process.env, {
  out: line => { process.stdout.write(`${line}\n`); },
  error: line => { process.stderr.write(`${line}\n`); }
}).then(code => { process.exitCode = code; });
