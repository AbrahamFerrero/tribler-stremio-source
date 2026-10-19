import type { NormalizedStreamSource } from "../streams/types";
import type { OutboundTransport } from "../network/outbound-transport";
import type { RepresentationState } from "./representation";

export interface PlayableStream {
  kind: "direct" | "redirect";
  source?: NormalizedStreamSource;
  url?: string;
  transport?: OutboundTransport;
  representation?: RepresentationState;
}

export interface PlaybackBackend {
  readonly id: string;
  canHandle(source: NormalizedStreamSource): boolean;
  prepare(source: NormalizedStreamSource, signal?: AbortSignal): Promise<PlayableStream>;
}
