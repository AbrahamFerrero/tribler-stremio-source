import { extname } from "node:path";
import { directVideoNames } from "./normalization";
import type { DirectHttpProbeStatus, NormalizedStreamSource } from "./types";

// Closed, low-cardinality observations only. Never retain names, MIME parameters or locators.
export const videoNames = ["ABSENT", "NO_EXTENSION", "OTHER", "mkv", "mp4", "webm", "m4v", "mov", "avi", "mpeg", "mpg", "ts", "m2ts", "mts", "vob", "ogv", "ogm", "wmv", "flv"] as const;
export const mediaMimes = ["ABSENT", "MALFORMED", "UNOBSERVED", "VIDEO_OTHER", "OTHER", "video/mp4", "video/x-matroska", "video/webm", "video/mp2t", "video/mpeg", "video/quicktime", "video/x-msvideo", "application/octet-stream", "application/mp4", "text/html", "text/plain", "application/json", "application/xml", "text/xml", "audio/mpeg", "audio/mp4"] as const;
export const mediaCauses = ["NONE", "MIME_ABSENT", "MIME_NOT_VIDEO", "HTTP_RESPONSE_NOT_ACCEPTED", "RANGE_NOT_VERIFIED", "EVIDENCE_UNDETERMINED"] as const;
export interface DirectMediaEvidence {
  filename: typeof videoNames[number];
  urlName: Exclude<typeof videoNames[number], "ABSENT">;
  mime: typeof mediaMimes[number];
  media: "ADMITTED" | "REJECTED";
  mediaCause: typeof mediaCauses[number];
  transport: DirectHttpProbeStatus | "UNOBSERVED";
  response: number;
  range: boolean;
  verified: boolean;
}

export function directMediaEvidence(source: NormalizedStreamSource, admitted: boolean, cause: DirectMediaEvidence["mediaCause"], header?: "ABSENT" | "MALFORMED" | "VALID"): DirectMediaEvidence {
  const names = directVideoNames(source);
  const name = (value: string | undefined, recognized: boolean): DirectMediaEvidence["filename"] => {
    if (!value) return "ABSENT";
    const extension = extname(value).toLowerCase().slice(1);
    if (recognized && videoNames.includes(extension as DirectMediaEvidence["filename"])) return extension as DirectMediaEvidence["filename"];
    return extension ? "OTHER" : "NO_EXTENSION";
  };
  const type = source.directHttp?.contentType;
  const mime = !type ? header === "ABSENT" || header === "MALFORMED" ? header : "UNOBSERVED" : mediaMimes.includes(type as DirectMediaEvidence["mime"]) ? type as DirectMediaEvidence["mime"]
    : type.startsWith("video/") ? "VIDEO_OTHER" : "OTHER";
  return { filename: name(names.filename, names.filenameVideo), urlName: names.urlName ? name(names.urlName, names.urlVideo) as DirectMediaEvidence["urlName"] : "NO_EXTENSION",
    mime, media: admitted ? "ADMITTED" : "REJECTED", mediaCause: cause,
    transport: source.directHttp?.status ?? "UNOBSERVED", range: source.directHttp?.rangeSupported === true, verified: source.directHttp?.verified === true,
    response: Number.isInteger(source.directHttp?.responseStatus) && source.directHttp!.responseStatus! >= 100 && source.directHttp!.responseStatus! <= 599 ? source.directHttp!.responseStatus! : 0 };
}
