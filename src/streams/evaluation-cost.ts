export interface LatencySummary {
  count: number; totalMs: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number;
}
export function latencySummary(values: readonly number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0;
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return { count: sorted.length, totalMs: Number(totalMs.toFixed(3)),
    meanMs: sorted.length ? Number((totalMs / sorted.length).toFixed(3)) : 0,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? 0 };
}

export class EvaluationCost {
  private readonly rows = new Map<string, {
    evaluations: number; requests: number; responses: number; errors: number; latency: number[];
  }>();
  constructor(ids: readonly string[]) {
    for (const id of ids) this.rows.set(id, { evaluations: 0, requests: 0, responses: 0,
      errors: 0, latency: [] });
  }
  request(id: string): void { const row = this.rows.get(id); if (row) row.requests += 1; }
  response(id: string): void { const row = this.rows.get(id); if (row) row.responses += 1; }
  evaluation(id: string, status: "ok" | "error", latencyMs?: number): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.evaluations += 1;
    if (status === "error") row.errors += 1;
    if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs >= 0) row.latency.push(latencyMs);
  }
  report() {
    return [...this.rows].map(([id, row]) => ({ id, evaluations: row.evaluations,
      requests: row.requests, responses: row.responses, errors: row.errors,
      latency: latencySummary(row.latency) }));
  }
}
