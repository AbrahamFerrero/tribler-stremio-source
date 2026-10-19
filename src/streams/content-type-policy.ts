import type { NormalizedMediaItem } from "./types";

export type PolicyContentType = "movie" | "series" | "anime";
export type ContentTypePolicy = Readonly<Record<PolicyContentType, boolean>>;

export function effectivePolicyContentType(item: NormalizedMediaItem): PolicyContentType {
  if (item.classifications?.includes("anime") || item.stremio?.type === "anime") return "anime";
  return item.kind === "movie" ? "movie" : "series";
}

export function allowsContentType(policy: ContentTypePolicy | undefined, item: NormalizedMediaItem): boolean {
  return policy?.[effectivePolicyContentType(item)] ?? true;
}
