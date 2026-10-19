import type { Dimensions } from "./harness";

/** Canonical anchors (one Case 8, with two branches; controls are not new approved cases).
 * 03: AC-ID-060/061/070, D-078 — request ID echo.
 * 08: AC-ID-060/061/063/070, D-078/079 — request presentation vs resource anchor.
 * 13: AC-ID-002/050/058/060/070, D-082 — same-resource origin-ID dispute.
 * 24: AC-ID-032/060/062/070, D-088/089 — validated effective resource.
 * 30: AC-ID-014/015/060/070, D-091/092 — text vs independent measurement.
 * Human contract, written independently of current observations. No result generation.
 */
export const pilotContract: Readonly<Record<string, Dimensions>> = {
  "03": {
    identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT", admittedResources: 1,
    disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420,
    originsRejectedBeforeDedupe: 0, requestIdActuallyCopied: true
  },
  "08a": {
    identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT", admittedResources: 1,
    disappearanceDomain: "NONE", probe: "VERIFIED", originsRejectedBeforeDedupe: 0, requestPresentationActuallyCopied: true
  },
  "08b": {
    identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT", admittedResources: 1,
    disappearanceDomain: "NONE", probe: "VERIFIED", originsRejectedBeforeDedupe: 0
  },
  "08-negative": {
    identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT", admittedResources: 0,
    disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1
  },
  "13": {
    identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT", admittedResources: 1,
    disappearanceDomain: "NONE", probe: "VERIFIED", originsRejectedBeforeDedupe: 0
  },
  "13-negative": {
    identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT", admittedResources: 0,
    disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1
  },
  "24": {
    preProbeIdentityState: "UNKNOWN", identityState: "CORROBORATED", publicIdentityState: "CORROBORATED",
    disposition: "ADMIT", admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED",
    validatedEffectiveYear: 1994, originsRejectedBeforeDedupe: 0
  },
  "24-negative": {
    identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT", admittedResources: 0,
    disappearanceDomain: "IDENTITY", probe: "VERIFIED", validatedEffectiveYear: 1987, originsRejectedBeforeDedupe: 0
  },
  "30": {
    identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT", admittedResources: 1,
    disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420, originsRejectedBeforeDedupe: 0,
    trustedRuntimeActuallyReceived: true
  },
  "30-recall": {
    identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT", admittedResources: 1,
    disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420, originsRejectedBeforeDedupe: 0
  },
  "30-negative": {
    identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT", admittedResources: 0,
    disappearanceDomain: "IDENTITY", probe: "VERIFIED", measuredSeconds: 1200, originsRejectedBeforeDedupe: 0
  }
};

/** Eight approved additions only; controls remain neighbours, not new main cases.
 * 12/14: AC-ID-050/058/060/061/070, D-082.
 * 25/26/29: AC-ID-032/037/052/060/074, D-088/089.
 * 27: AC-ID-036/060/062/070, D-090 (non-empty query caps a sole basename anchor).
 * 49: AC-ID-053/073/074, post-probe decision/reason attribution.
 * 52: AC-ID-054/075, D-099/100, hostile privacy surfaces.
 */
export const extensionContract: Readonly<Record<string, Dimensions>> = {
  "12": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, resourcePublicStreams: 1, probe: "VERIFIED", representativeUnmerged: true },
  "14": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 1, resourcePublicStreams: 0, disappearanceDomain: "IDENTITY", probe: "VERIFIED",
    validatedEffectiveSeason: 3, validatedEffectiveEpisode: 4, rejectionStage: "admitted" },
  "25": { preProbeIdentityState: "UNKNOWN", identityState: "CONTRADICTION", disposition: "REJECT",
    admittedResources: 0, publicIdentityState: "ABSENT", disappearanceDomain: "IDENTITY", probe: "VERIFIED",
    validatedEffectiveSeason: 3, validatedEffectiveEpisode: 4, rejectionStage: "admitted" },
  "26": { identityState: "UNKNOWN", disposition: "REJECT", admittedResources: 0, publicIdentityState: "ABSENT",
    disappearanceDomain: "URL_POLICY", probe: "route_rejected", effectiveIdentityFacts: 0,
    originsRejectedBeforeDedupe: 0 },
  "26-recall": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", validatedEffectiveSeason: 2, validatedEffectiveEpisode: 9 },
  "27": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", validatedEffectiveYear: 1994 },
  "27-clean": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", validatedEffectiveYear: 1994 },
  "27-independent": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", validatedEffectiveYear: 1994 },
  "29": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "VERIFIED", validatedEffectiveSeason: 3,
    validatedEffectiveEpisode: 4, rejectionStage: "admitted", originsRejectedBeforeDedupe: 0 },
  "49": { identityState: "CONTRADICTION", disposition: "REJECT", admittedResources: 1, resourcePublicStreams: 0,
    publicIdentityState: "ABSENT", disappearanceDomain: "IDENTITY", probe: "VERIFIED", measuredSeconds: 1200,
    rejectionStage: "admitted", rejectionReason: "MEASURED_RUNTIME_CONTRADICTION" },
  "52": { disposition: "ADMIT", admittedResources: 1, probe: "VERIFIED", publicIdentityState: "UNKNOWN",
    publicPrivacy: true, logPrivacy: true, observerPrivacy: true, providerDiagnosticsPrivacy: true,
    providersPrivacy: true, tracePrivacy: true, reporterPrivacy: true }
};

/** Twelve approved intake/provenance additions. Static HTTP fixture responses
 * demonstrate producer independence; no magic provenance/confidence fields.
 * 01/02/04/05/06/07: AC-ID-001/002/004/031/060/061/067/070, D-031/078/084/093.
 * 09/10/11: AC-ID-060/061/064/066/070, D-081.
 * 15/16/17: AC-ID-005/018/019/060/061/063/068/070, D-047/083.
 * Negative controls are neighbours, not additional main inventory cases.
 */
export const intakeContract: Readonly<Record<string, Dimensions>> = {
  "01": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 },
  "02": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "04": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 },
  "05": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420,
    validatedEffectiveYear: 1987, originsRejectedBeforeDedupe: 0 },
  "05-negative": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "06": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "07": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 },
  "09": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 },
  "10": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 },
  "11": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 },
  "15": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "16": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 1800 },
  "16-negative": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "17": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420 }
};

/** Fifteen approved year/episode/runtime cases, D-084/086/087/089/092/093/095.
 * AC-ID-004/006/007/008/027/028/035/036/039/040/041/042/050/060/061/062/070.
 * Explicit independent contracts; controls distinguish ambiguity, missing anchors
 * and strict threshold equality. Runtime compatibility never identifies content.
 */
export const resourceRuntimeContract: Readonly<Record<string, Dimensions>> = {
  "18": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "19": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", validatedEffectiveYear: "NOT_OBSERVABLE", effectiveIdentityFacts: 0 },
  "20": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", validatedEffectiveYear: 1994 },
  "21": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", effectiveIdentityFacts: 0 },
  "21-negative": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", originsRejectedBeforeDedupe: 1 },
  "22": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", requestPresentationActuallyCopied: true },
  "23": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", validatedEffectiveYear: 1987, validatedEffectiveSeason: 2, validatedEffectiveEpisode: 9 },
  "23-recall": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", validatedEffectiveYear: 1987, validatedEffectiveSeason: 2, validatedEffectiveEpisode: 9 },
  "28": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", effectiveIdentityFacts: 0 },
  "31": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 7800, trustedRuntimeActuallyReceived: true },
  "31-negative": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "VERIFIED", measuredSeconds: 7860, rejectionStage: "admitted" },
  "32": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 6420, trustedRuntimeActuallyReceived: false },
  "33": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT",
    admittedResources: 0, disappearanceDomain: "IDENTITY", probe: "VERIFIED", measuredSeconds: 1200, rejectionStage: "admitted" },
  "34": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, disappearanceDomain: "NONE", probe: "VERIFIED", measuredSeconds: 6420,
    validatedEffectiveYear: 1994, originsRejectedBeforeDedupe: 0 },
  "34-recall": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 6420, validatedEffectiveYear: 1994 },
  "35": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 6420 },
  "35-recall": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 6420 },
  "36": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 6420 },
  "37": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 1200, trustedRuntimeActuallyReceived: false },
  "38": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", measuredSeconds: 1800 }
};

/** Final inventory, block A: D-096/097; AC-ID-043/044/045/046/047/053/074.
 * Confidence is independent of transport disappearance and useful-result bounds.
 */
export const boundsContract: Readonly<Record<string, Dimensions>> = {
  "39": { identityState: "CORROBORATED", disposition: "REJECT", disappearanceDomain: "URL_POLICY",
    publicIdentityState: "ABSENT", admittedResources: 0, identityRejections: 0, probe: "route_rejected" },
  "39-negative": { identityState: "CORROBORATED", disposition: "REJECT", disappearanceDomain: "TRANSPORT",
    publicIdentityState: "ABSENT", admittedResources: 0, identityRejections: 0, probe: "route_rejected" },
  "39-recall": { disposition: "ADMIT", admittedResources: 1, identityRejections: 0, probe: "unreachable" },
  "40": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT",
    admittedResources: 1, probe: "VERIFIED", identityRejections: 0 },
  "41": { disposition: "REJECT", admittedResources: 1, resourcePublicStreams: 0,
    disappearanceDomain: "IDENTITY", probe: "NOT_REACHED", identityRejections: 1 },
  "42": { disposition: "ADMIT", admittedResources: 1, probe: "VERIFIED", measuredSeconds: 6420, identityRejections: 1 },
  "42-negative": { admittedResources: 0, resourcePublicStreams: 0, disappearanceDomain: "PROBE_BUDGET", identityRejections: 2 },
  "43": { disposition: "ADMIT", admittedResources: 50, resourcePublicStreams: 1, identityRejections: 1 },
  "44": { disposition: "ADMIT", admittedResources: 1, probe: "timeout", identityRejections: 0, transportSummaryCorrect: true },
  "44-negative": { admittedResources: 0, probe: "budget_exhausted", disappearanceDomain: "PROBE_BUDGET", identityRejections: 0 }
};

/** Final block B: D-098/100, AC-ID-070/072/073/074/075/076.
 * Public routes, candidate attribution and safety; no formatter oracle.
 */
export const publicTraceContract: Readonly<Record<string, Dimensions>> = {
  "45": { identityState: "CORROBORATED", publicIdentityState: "CORROBORATED", disposition: "ADMIT", probe: "VERIFIED" },
  "45-recall": { identityState: "UNKNOWN", publicIdentityState: "UNKNOWN", disposition: "ADMIT", probe: "VERIFIED" },
  "45-independent": { identityState: "SUSPICIOUS", publicIdentityState: "SUSPICIOUS", disposition: "ADMIT", probe: "VERIFIED" },
  "45-negative": { identityState: "CONTRADICTION", publicIdentityState: "ABSENT", disposition: "REJECT", admittedResources: 0 },
  "46": { disposition: "ADMIT", probe: "VERIFIED", transportSummaryCorrect: true, publicIdentityState: "UNKNOWN" },
  "46-recall": { disposition: "ADMIT", transportSummaryCorrect: true, publicIdentityState: "UNKNOWN" },
  "46-independent": { disposition: "ADMIT", probe: "VERIFIED", transportSummaryCorrect: true, publicIdentityState: "UNKNOWN" },
  "46-clean": { disposition: "ADMIT", transportSummaryCorrect: true, publicIdentityState: "UNKNOWN" },
  "46-negative": { disposition: "ADMIT", probe: "unreachable", transportSummaryCorrect: true, publicIdentityState: "UNKNOWN" },
  "47": { admittedResources: 2, confidenceRankingNeutral: true },
  "47-recall": { admittedResources: 2, confidenceRankingNeutral: true },
  "48": { identityState: "CONTRADICTION", disposition: "REJECT", publicIdentityState: "ABSENT",
    preProbeDecision: "REJECT", laterStagesNotReached: true, disappearanceDomain: "IDENTITY",
    rejectionReason: "EPISODE_COORDINATE_CONFLICT", probe: "NOT_REACHED" },
  "50": { disappearanceDomain: "DEDUPE", admittedResources: 3, resourcePublicStreams: 1, identityRejections: 0 },
  "50-negative": { disappearanceDomain: "PROBE_BUDGET", admittedResources: 1, resourcePublicStreams: 0, identityRejections: 0 },
  "50-clean": { disappearanceDomain: "PROVIDER_QUOTA", admittedResources: 50, resourcePublicStreams: 0, identityRejections: 0 },
  "50-recall": { disappearanceDomain: "NONE", disposition: "ADMIT", admittedResources: 1, resourcePublicStreams: 1, identityRejections: 0 },
  "51": { disposition: "ADMIT", probe: "VERIFIED", publicPrivacy: true, observerPrivacy: true, logPrivacy: true,
    providerDiagnosticsPrivacy: true, providersPrivacy: true, tracePrivacy: true, reporterPrivacy: true },
  "53": { disposition: "REJECT", admittedResources: 1, resourcePublicStreams: 0, disappearanceDomain: "IDENTITY",
    probe: "VERIFIED", measuredSeconds: 1200, rejectReviewAvailable: true }
};
