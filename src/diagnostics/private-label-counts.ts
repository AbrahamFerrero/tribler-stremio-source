import { privateLabelReasons, validatePrivateReport } from "./private-context";

/** Explicit private-local analysis only; no labels, IDs, lengths or per-search breakdown. */
export function privateLabelCounts(input: unknown) {
  const report = validatePrivateReport(input);
  const withheldByReason = Object.fromEntries([...privateLabelReasons, "UNRECORDED"].map(k => [k, 0]));
  let withheld = 0, overLimit = 0, historicalStatusUnknown = 0, captured = 0, other = 0;
  let contextLimited = 0, reportLimited = 0;
  let contextsWithoutCandidates = 0, contextsWithoutCaptureStatus = 0;
  for (const context of report.context) {
    if (!context.candidates) contextsWithoutCandidates++;
    if (!context.metadataCapture) contextsWithoutCaptureStatus++;
    if (context.metadataCapture === "CONTEXT_LIMIT") contextLimited++;
    if (context.metadataCapture === "REPORT_LIMIT") reportLimited++;
    for (const candidate of context.candidates ?? []) {
      // Title only: do not mix name/Identity title into the source-title denominator.
      const status = candidate.labelStatus?.title;
      if (status === "WITHHELD") {
        withheld++; withheldByReason[candidate.labelReasons?.title ?? "UNRECORDED"]!++;
      } else if (status === "OVER_LIMIT") overLimit++;
      else if (status === "CAPTURED") captured++;
      else if (!status) historicalStatusUnknown++;
      else other++;
    }
  }
  return { scope: "RECORDED_SOURCE_TITLES_ONLY", truncated: report.report.state === "TRUNCATED",
    resolutionsWithoutContext: report.report.resolutions.length - report.context.length,
    contextsWithoutCandidates, contextsWithoutCaptureStatus,
    contextLimited, reportLimited, captured, withheld, overLimit, other, historicalStatusUnknown, withheldByReason };
}
