import { describe, expect, it } from "vitest";
import { classifyRuntimeAudit } from "../scripts/privacy-runtime-audit-classifier";

const playback = {
  bridgePidKnown: true,
  realTriblerPlayback: true,
  effectiveHops: 2,
  httpStatus: 206,
  playbackBytesObserved: true,
  auditDurationSeconds: 35,
  loopbackTcpObserved: true,
  nonLoopbackTcpObserved: false
};

describe("privacy runtime audit classifier", () => {
  it("reports a critical failure when the audited bridge PID has public TCP", () => {
    expect(classifyRuntimeAudit({ ...playback, nonLoopbackTcpObserved: true })).toEqual({
      evidenceLevel: "LOCAL_RUNTIME_OBSERVED", result: "FAIL", severity: "CRITICAL"
    });
  });

  it("requires real playback evidence before reporting a sampled TCP pass", () => {
    expect(classifyRuntimeAudit(playback)).toEqual({ evidenceLevel: "LOCAL_RUNTIME_OBSERVED", result: "PASS" });
    expect(classifyRuntimeAudit({ ...playback, playbackBytesObserved: false })).toEqual({
      evidenceLevel: "INCONCLUSIVE", result: "INCONCLUSIVE"
    });
  });
});
