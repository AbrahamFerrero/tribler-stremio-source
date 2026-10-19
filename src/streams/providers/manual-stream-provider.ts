import type { NormalizedMediaItem, NormalizedStreamSource, StreamProvider } from "../types";

export class ManualStreamProvider implements StreamProvider {
  readonly id: string = "manual";
  readonly name: string = "Manual streams";

  constructor(private readonly sources: Readonly<Record<string, NormalizedStreamSource[]>>, private readonly enabled = true) {}

  isEnabled(): boolean { return this.enabled; }

  resolve(item: NormalizedMediaItem): Promise<NormalizedStreamSource[]> {
    return Promise.resolve((this.sources[item.id] ?? []).map((source) => ({ ...source, providerId: this.id })));
  }
}
