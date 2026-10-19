export interface RuntimeAuditEvidence {
  bridgePidKnown: boolean;
  realTriblerPlayback: boolean;
  effectiveHops: number | null;
  httpStatus: number | null;
  playbackBytesObserved: boolean;
  auditDurationSeconds: number;
  loopbackTcpObserved: boolean;
  nonLoopbackTcpObserved: boolean;
}

export interface RuntimeAuditClassification {
  evidenceLevel: "LOCAL_RUNTIME_OBSERVED" | "INCONCLUSIVE";
  result: "PASS" | "FAIL" | "INCONCLUSIVE";
  severity?: "CRITICAL";
}

export function classifyRuntimeAudit(evidence: RuntimeAuditEvidence): RuntimeAuditClassification {
  if (evidence.nonLoopbackTcpObserved) {
    return { evidenceLevel: "LOCAL_RUNTIME_OBSERVED", result: "FAIL", severity: "CRITICAL" };
  }
  const hops = evidence.effectiveHops;
  if (evidence.bridgePidKnown && evidence.realTriblerPlayback &&
      Number.isSafeInteger(hops) && hops !== null && hops >= 1 &&
      evidence.httpStatus === 206 && evidence.playbackBytesObserved &&
      evidence.auditDurationSeconds >= 30 && evidence.loopbackTcpObserved) {
    return { evidenceLevel: "LOCAL_RUNTIME_OBSERVED", result: "PASS" };
  }
  return { evidenceLevel: "INCONCLUSIVE", result: "INCONCLUSIVE" };
}
