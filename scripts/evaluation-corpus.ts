import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inputItems, parseEvaluationItems } from "./evaluation-input";
import type { NormalizedMediaItem } from "../src/streams/types";
import { effectivePolicyContentType } from "../src/streams/content-type-policy";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export type MediaClass = "movie" | "series" | "anime" | "all";
export type Cohort = "mainstream" | "long-tail" | "manual";
export interface EvaluationCase {
  id: string;
  mediaClass: MediaClass;
  cohort: Cohort;
  item: NormalizedMediaItem;
}
export interface EvaluationCorpus {
  id: string;
  version: 1;
  fingerprint: string;
  cases: EvaluationCase[];
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    return "{" + Object.keys(row).sort().map((key) =>
      JSON.stringify(key) + ":" + canonical(row[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function fingerprint(id: string, cases: EvaluationCase[]): string {
  return createHash("sha256").update(canonical({
    version: 1, id, cases: cases.map(({ id: caseId, mediaClass, cohort, item }) =>
      ({ id: caseId, mediaClass, cohort, item }))
  })).digest("hex");
}

export function loadEvaluationCases(path: string, mode: "--input" | "--corpus"): EvaluationCorpus {
  if (mode === "--input") {
    const cases = inputItems(path).map((item, index) => ({
      id: "manual-" + String(index + 1).padStart(3, "0"), mediaClass: "all" as const,
      cohort: "manual" as const, item
    }));
    return { id: "manual", version: 1, fingerprint: fingerprint("manual", cases), cases };
  }
  const raw = readFileSync(path);
  if (raw.length > 65_536) throw new Error("CORPUS_INVALID");
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("CORPUS_INVALID");
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some((key) => !["version", "id", "cases"].includes(key)))
    throw new Error("CORPUS_INVALID");
  if (envelope.version !== 1 || typeof envelope.id !== "string" || !SAFE_ID.test(envelope.id)
    || !Array.isArray(envelope.cases) || !envelope.cases.length || envelope.cases.length > 100) {
    throw new Error("CORPUS_INVALID");
  }
  const seen = new Set<string>();
  const cases = envelope.cases.map((rawCase): EvaluationCase => {
    if (typeof rawCase !== "object" || rawCase === null || Array.isArray(rawCase)) throw new Error("CORPUS_INVALID");
    const entry = rawCase as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["id", "mediaClass", "cohort", "item"].includes(key)))
      throw new Error("CORPUS_INVALID");
    if (typeof entry.id !== "string" || !SAFE_ID.test(entry.id) || seen.has(entry.id)
      || (entry.mediaClass !== "movie" && entry.mediaClass !== "series" && entry.mediaClass !== "anime")
      || (entry.cohort !== "mainstream" && entry.cohort !== "long-tail")) throw new Error("CORPUS_INVALID");
    seen.add(entry.id);
    const item = parseEvaluationItems([entry.item])[0]!;
    if (effectivePolicyContentType(item) !== entry.mediaClass) throw new Error("CORPUS_INVALID");
    return { id: entry.id, mediaClass: entry.mediaClass, cohort: entry.cohort, item };
  });
  return { id: envelope.id, version: 1, fingerprint: fingerprint(envelope.id, cases), cases };
}

export function caseSegments(value: EvaluationCase): string[] {
  if (value.mediaClass === "all") return ["all"];
  const segments = ["all", value.mediaClass, value.cohort, value.mediaClass + "/" + value.cohort];
  if (value.mediaClass === "anime" && (value.item.kind === "movie" || value.item.kind === "episode")) {
    segments.push("anime/" + value.item.kind, "anime/" + value.cohort + "/" + value.item.kind);
  }
  return segments;
}
