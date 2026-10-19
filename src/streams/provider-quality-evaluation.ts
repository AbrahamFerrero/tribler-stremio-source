import { extractInfohash } from "../source";
import type { StreamResolverTrace } from "./resolver";
import { isDeterministicProbeRejection } from "./resolver";
import type { NormalizedStreamSource } from "./types";

export interface ProviderQualityCounts {
  id: string;
  name: string;
  rawReturned: number;
  rawDirect: number;
  qualifiedDirect: number;
  dedupedDirect: number;
  selectedTurns: number;
  networkStarts: number;
  verified: number;
  uncertain: number;
  deterministicRejects: number;
  budgetExhausted: number;
  admittedDirect: number;
  finalDirect: number;
  contributingItems: number;
}

export interface ProviderQualityRow extends ProviderQualityCounts {
  deterministicRejectRate: number;
  verifiedYield: number;
  admittedYield: number;
  finalYield: number;
  contributingShare: number;
}

function direct(source: NormalizedStreamSource): boolean {
  return source.type === "http" || source.type === "https";
}

function safeName(name: string, id: string): string {
  // Configuration names are untrusted display text. Keep URLs, tokens and
  // control characters out of both table and JSON output.
  return /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name) ? name : id;
}

export class ProviderQualityEvaluation {
  private readonly counts = new Map<string, ProviderQualityCounts>();
  private items = 0;

  constructor(providers: readonly { id: string; name: string }[]) {
    for (const provider of providers) {
      this.counts.set(provider.id, {
        id: provider.id, name: safeName(provider.name, provider.id),
        rawReturned: 0, rawDirect: 0, qualifiedDirect: 0, dedupedDirect: 0,
        selectedTurns: 0, networkStarts: 0, verified: 0, uncertain: 0,
        deterministicRejects: 0, budgetExhausted: 0, admittedDirect: 0,
        finalDirect: 0, contributingItems: 0
      });
    }
  }

  rawStreams(providerId: string, streams: readonly unknown[]): void {
    const row = this.counts.get(providerId);
    if (!row) return;
    for (const value of streams) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const stream = value as Record<string, unknown>;
      const hash = stream.infoHash;
      const url = stream.url;
      let validUrl = false;
      if (typeof url === "string") {
        try {
          const parsed = new URL(url);
          validUrl = parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch { /* malformed raw entries do not count */ }
      }
      if (validUrl || (typeof hash === "string" && extractInfohash(hash) !== undefined))
        row.rawReturned += 1;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) row.rawDirect += 1;
    }
  }

  itemTrace(): StreamResolverTrace {
    const contributed = new Set<string>();
    const trace: StreamResolverTrace & { contributed: Set<string> } = {
      contributed,
      probeNetworkStart: (providerId) => {
        const row = this.counts.get(providerId);
        if (row) row.networkStarts += 1;
      },
      stage: (stage, sources) => {
        for (const source of sources) {
          if (!direct(source)) continue;
          const row = this.counts.get(source.providerId);
          if (!row) continue;
          if (stage === "normalized") row.qualifiedDirect += 1;
          else if (stage === "deduplicated") row.dedupedDirect += 1;
          else if (stage === "probed" && source.directHttp) {
            row.selectedTurns += 1;
            if (source.directHttp.status === "budget_exhausted") row.budgetExhausted += 1;
            else if (isDeterministicProbeRejection(source)) row.deterministicRejects += 1;
            else if (source.directHttp.verified) row.verified += 1;
            else row.uncertain += 1;
          } else if (stage === "admitted") row.admittedDirect += 1;
          else if (stage === "final") {
            row.finalDirect += 1;
            contributed.add(source.providerId);
          }
        }
      }
    };
    return trace;
  }

  finishItem(trace: StreamResolverTrace): void {
    // The trace itself exposes no candidates. Track contribution using a
    // per-item final-stage count rather than retaining any source payload.
    const touched = (trace as StreamResolverTrace & { contributed?: Set<string> }).contributed;
    for (const id of touched ?? []) this.counts.get(id)!.contributingItems += 1;
    this.items += 1;
  }

  report(): { evaluatedItems: number; providers: ProviderQualityRow[] } {
    const rate = (numerator: number, denominator: number): number =>
      denominator ? Number((numerator / denominator).toFixed(4)) : 0;
    return {
      evaluatedItems: this.items,
      providers: [...this.counts.values()].map((row) => ({
        ...row,
        deterministicRejectRate: rate(row.deterministicRejects, row.selectedTurns),
        verifiedYield: rate(row.verified, row.selectedTurns),
        admittedYield: rate(row.admittedDirect, row.selectedTurns),
        finalYield: rate(row.finalDirect, row.selectedTurns),
        contributingShare: rate(row.contributingItems, this.items)
      }))
    };
  }
}

export function formatProviderQualityTable(report: ReturnType<ProviderQualityEvaluation["report"]>): string {
  const headers = ["Provider", "Raw", "Qual", "Dedupe", "Turns", "Net", "Verified", "Uncertain", "Reject", "Budget", "Admit", "Final", "Items", "Reject%", "V/Turn", "A/Turn", "F/Turn", "Item%"];
  const rows = report.providers.map((p) => [
    p.name === p.id ? p.id : `${p.id} (${p.name})`,
    p.rawDirect, p.qualifiedDirect, p.dedupedDirect, p.selectedTurns, p.networkStarts,
    p.verified, p.uncertain, p.deterministicRejects, p.budgetExhausted,
    p.admittedDirect, p.finalDirect, `${p.contributingItems}/${report.evaluatedItems}`,
    `${(p.deterministicRejectRate * 100).toFixed(1)}%`, p.verifiedYield.toFixed(2),
    p.admittedYield.toFixed(2), p.finalYield.toFixed(2), `${(p.contributingShare * 100).toFixed(1)}%`
  ].map(String));
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]!.length)));
  return [headers, ...rows].map((row) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd()).join("\n");
}
