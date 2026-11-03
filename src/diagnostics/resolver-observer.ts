import { getBridgeIdentityState, type StreamCandidateRef, type StreamResolverObservation, type StreamResolverTrace } from "../streams/resolver";
import type { DiagnosticCapture, DiagnosticController } from "./controller";
import { projectDiagnosticEvent, type DiagnosticEvent, type DiagnosticScores, type DiagnosticStage } from "./events";
import { DIAGNOSTIC_LIMITS as L } from "./recorder";
import { streamHeight } from "../streams/details";
import { safeContextLabel, sourceDeclarations } from "./private-context";
import type { NormalizedStreamSource } from "../streams/types";

const stages = { provider: "PROVIDER", normalized: "NORMALIZED", deduplicated: "DEDUPLICATED", probed: "PROBED", admitted: "ADMITTED", final: "FINAL" } as const;

function observedHeight(source: NormalizedStreamSource): number {
  const projected: NormalizedStreamSource = { providerId: "", type: "https" };
  for (const field of ["resolution", "quality", "filename", "title"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor && !("value" in descriptor)) return 0;
    const value: unknown = descriptor?.value;
    if (typeof value !== "string") continue;
    if (value.length > 256) return 0;
    projected[field] = value;
    const height = streamHeight(projected);
    if (height > 0) return height;
  }
  return 0;
}

/** Per invocation. Owns only empty occurrence references, integer slots and sanitized DTOs. */
export function observeResolution(capture: DiagnosticCapture): StreamResolverObservation {
  let references = new WeakMap<StreamCandidateRef, number>();
  let nextSlot = 0;
  let previous = new Set<number>();
  const rejected = new Set<number>();
  let ranking: Array<DiagnosticScores | undefined> = [];
  let rankingCount = -1;
  let closed = false;
  let origins: readonly number[] = [];
  const providerOrigins = new Map<number, number>();
  const clear = () => { references = new WeakMap(); previous.clear(); rejected.clear(); ranking = []; origins = []; providerOrigins.clear(); };
  const guarded = (action: () => void) => {
    if (closed) return;
    try {
      if (!capture.isActive()) { clear(); return; }
      action();
    } catch {
      closed = true; clear();
      try { capture.finish(true); } catch { /* No observer failure may escape. */ }
    }
  };
  const gap = (candidate: number, stage: DiagnosticStage, context: "CONTINUITY" | "RANKING" | "IDENTITY_GROUP", reason: "INSUFFICIENT_EVIDENCE" | "UNOBSERVED") =>
    capture.record({ kind: "GAP", candidate, stage, context, reason });

  const trace: StreamResolverTrace = {
    directMedia: event => guarded(() => {
      const slot = references.get(event.candidate);
      if (slot === undefined) { gap(-1, "ADMITTED", "CONTINUITY", "UNOBSERVED"); return; }
      capture.record({ kind: "DIRECT_MEDIA", candidate: slot, stage: "ADMITTED", ...event.evidence });
    }),
    stage: (stage, sources, refs) => guarded(() => {
      const name = stages[stage];
      const examined = Math.min(sources.length, L.candidates);
      let observed = 0;
      for (let index = 0; index < examined; index++) {
        const ref = refs?.[index];
        if (ref && (stage === "provider" || references.has(ref))) observed++;
      }
      capture.record({ kind: "SNAPSHOT", stage: name, count: sources.length, observed });
      const current = new Set<number>();
      for (let index = 0; index < examined && capture.isActive(); index++) {
        const ref = refs?.[index];
        if (!ref) { gap(-1, name, "CONTINUITY", "UNOBSERVED"); continue; }
        let slot = references.get(ref);
        if (slot === undefined && stage === "provider" && nextSlot < L.candidates) {
          slot = nextSlot++; references.set(ref, slot);
        }
        if (slot === undefined) { gap(-1, name, "CONTINUITY", "UNOBSERVED"); continue; }
        current.add(slot);
        const source = sources[index]!;
        if (stage === "provider" || stage === "final") {
          const type = source.type;
          const transport = type === "http" ? "HTTP" : type === "https" ? "HTTPS" : type === "magnet" ? "MAGNET" : type === "torrent" ? "TORRENT" : "UNOBSERVED";
          // Provider-stage provenance comes from the registry occurrence, never a claimed providerId.
          if (stage === "provider") providerOrigins.set(slot, origins[index] ?? -1);
          capture.record({ kind: "SOURCE", candidate: slot, provider: providerOrigins.get(slot) ?? -1, transport, height: observedHeight(source) });
        }
        if (stage === "provider" && capture.privateCandidate && capture.isActive()) capture.privateCandidate(slot, sourceDeclarations(source));
        capture.record({ kind: "OBSERVATION", candidate: slot, stage: name,
          identity: getBridgeIdentityState(source) ?? "UNCLASSIFIED", probe: source.directHttp?.status ?? "UNOBSERVED" });
        if (stage === "final") {
          const scores = ranking[index];
          if (rankingCount === sources.length && scores) capture.record({ kind: "RANKING", candidate: slot, position: index + 1, ...scores });
          else gap(slot, name, "RANKING", "UNOBSERVED");
        }
      }
      for (const slot of previous) if (!current.has(slot) && !rejected.has(slot)) gap(slot, name, "CONTINUITY", "INSUFFICIENT_EVIDENCE");
      previous = current;
      if (stage === "final") {
        // Existing hooks expose state, but not the comparator's effective group value.
        gap(-1, name, "IDENTITY_GROUP", "UNOBSERVED");
        ranking = [];
      }
      if (sources.length > L.candidates) capture.truncate();
    }),
    preProbeIdentity: event => guarded(() => {
      const slot = references.get(event.candidate);
      if (slot === undefined) { gap(-1, "NORMALIZED", "CONTINUITY", "UNOBSERVED"); return; }
      capture.record({ kind: "PRE_PROBE", candidate: slot, decision: event.decision, identity: event.identityState ?? "UNCLASSIFIED" });
    }),
    exclusion: event => guarded(() => {
      const slot = references.get(event.candidate);
      if (slot === undefined) { gap(-1, stages[event.stage], "CONTINUITY", "UNOBSERVED"); return; }
      capture.record({ kind: "EXCLUSION", candidate: slot, stage: stages[event.stage], reason: event.reason,
        ...(event.stage === "admitted" && event.reason === "DETERMINISTIC_PROBE_REJECTION" && event.probeCause !== undefined
          ? { probeCause: event.probeCause, ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}) } : {}),
        ...(event.stage === "admitted" && event.reason === "HLS_NOT_VERIFIED" && event.hlsCause !== undefined
          ? { hlsCause: event.hlsCause, ...(event.hlsPhase !== undefined ? { hlsPhase: event.hlsPhase } : {}), ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}) } : {}) });
      rejected.add(slot);
    }),
    rejection: event => guarded(() => {
      const slot = references.get(event.candidate);
      if (slot === undefined) { gap(-1, stages[event.stage], "CONTINUITY", "UNOBSERVED"); return; }
      capture.record({ kind: "REJECTION", candidate: slot, stage: stages[event.stage], reason: event.reason, identity: event.identityState });
      rejected.add(slot);
    }),
    ranking: candidates => guarded(() => {
      rankingCount = candidates.length;
      ranking = [];
      for (let index = 0; index < Math.min(candidates.length, L.candidates); index++) {
        const entry = candidates[index]!;
        // Copy only seven bounded numbers; never keep the ranking entry or components object.
        const projected = projectDiagnosticEvent({ kind: "RANKING", candidate: 0, position: 1,
          score: entry.score, availability: entry.components.availability, resolution: entry.components.resolution,
          size: entry.components.size, codec: entry.components.codec, metadata: entry.components.metadata, transport: entry.components.transport });
        if (projected?.kind === "RANKING") {
          ranking.push({ score: projected.score, availability: projected.availability, resolution: projected.resolution,
            size: projected.size, codec: projected.codec, metadata: projected.metadata, transport: projected.transport });
        } else ranking.push(undefined);
      }
    })
  };
  return { trace,
    request: item => guarded(() => {
      const mediaKind = ["movie", "series", "episode"].includes(item.kind) ? item.kind : "UNOBSERVED";
      capture.record({ kind: "REQUEST", mediaKind });
      if (capture.privateContext) {
        const coordinate = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9999 ? n : null;
        capture.privateContext({ metadataCapture: "WITHIN_LIMITS", title: item.title === item.id ? "" : safeContextLabel(item.title), mediaKind,
          ...(item.kind === "episode" ? { seriesTitle: item.seriesTitle === item.id ? "" : safeContextLabel(item.seriesTitle) } : {}),
          season: coordinate(item.season), episode: coordinate(item.episode), providers: [] });
      }
    }),
    registry: {
      captureNames: capture.privateProvider !== undefined,
      configured: (provider, id, name, enabled) => guarded(() => {
        if (provider >= 64) { capture.truncate(); return; }
        capture.record({ kind: "PROVIDER_STATE", provider, status: enabled ? "ENABLED" : "DISABLED" });
        capture.privateProvider?.({ provider, id: safeContextLabel(id, 96), name: safeContextLabel(name, 96) });
      }),
      state: (provider, status) => guarded(() => capture.record({ kind: "PROVIDER_STATE", provider, status })),
      failure: (provider, category) => guarded(() => capture.record({ kind: "PROVIDER_FAILURE", provider, category })),
      counts: (provider, received, delivered) => guarded(() => capture.record({ kind: "PROVIDER_COUNTS", provider, received, delivered, limited: received - delivered })),
      origins: slots => guarded(() => { origins = slots.slice(0, L.candidates); })
    },
    finish: (interrupted, cancelled = false) => {
    if (closed) return;
    guarded(() => capture.record({ kind: "END", outcome: cancelled ? "CANCELLED" : interrupted ? "FAILED" : "SUCCEEDED" } satisfies DiagnosticEvent));
    closed = true; clear();
    try { capture.finish(interrupted || cancelled); } catch { /* Observer-only failure. */ }
  } };
}

/** An OFF/quota-exhausted controller allocates no adapter or diagnostic references. */
export function diagnosticObserverFactory(controller: Pick<DiagnosticController, "beginResolution">): () => StreamResolverObservation | undefined {
  return () => {
    const capture = controller.beginResolution();
    if (!capture) return;
    try { return observeResolution(capture); }
    catch { try { capture.finish(true); } catch { /* Observer-only failure. */ } return; }
  };
}
