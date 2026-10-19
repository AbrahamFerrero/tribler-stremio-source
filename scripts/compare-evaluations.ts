import { compareEvaluations, formatEvaluationComparison, readEvaluationReport } from "../src/streams/evaluation-comparison";

try {
  const args = process.argv.slice(2);
  if ((args.length !== 4 && args.length !== 5) || args[0] !== "--baseline"
    || args[2] !== "--candidate" || (args.length === 5 && args[4] !== "--json")) {
    throw new Error("ARGUMENTS_INVALID");
  }
  const report = compareEvaluations(readEvaluationReport(args[1]!), readEvaluationReport(args[3]!));
  process.stdout.write(args.includes("--json")
    ? JSON.stringify(report) + "\n" : formatEvaluationComparison(report) + "\n");
} catch (error) {
  process.stderr.write("COMPARISON_FAILED: " +
    (error instanceof Error && ["ARGUMENTS_INVALID", "REPORT_INVALID", "REPORT_MISMATCH"].includes(error.message)
      ? error.message : "REPORT_INVALID") + "\n");
  process.exitCode = 1;
}
