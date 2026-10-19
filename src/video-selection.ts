import { extname } from "node:path";
import type { TriblerFile } from "./types";

const preferredExtensions = new Map([
  [".mkv", 3],
  [".mp4", 2],
  [".webm", 1]
]);
const fallbackVideoExtensions = new Set([
  ".m4v", ".mov", ".avi", ".mpeg", ".mpg", ".ts", ".m2ts", ".mts", ".vob", ".ogv", ".ogm", ".wmv", ".flv"
]);
const dangerousExtensions = new Set([
  ".exe", ".com", ".msi", ".msp", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse",
  ".wsf", ".wsh", ".scr", ".dll", ".cpl", ".hta", ".lnk", ".reg", ".jar", ".app", ".dmg", ".pkg",
  ".deb", ".rpm", ".sh", ".command"
]);
const secondaryNamePattern = /(^|[._ /-])(sample|trailer|preview|extras?)([._ /-]|$)/i;

export function inferVideoHeight(name: string): number | undefined {
  const explicit = /(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)p?(?:[^0-9]|$)/i.exec(name);
  if (explicit) return Number(explicit[1]);
  if (/(?:^|[._ /-])(4k|uhd)(?:[._ /-]|$)/i.test(name)) return 2160;
  return undefined;
}

export function isVideoFile(file: TriblerFile): boolean {
  const extension = extname(file.name).toLowerCase();
  return preferredExtensions.has(extension) || fallbackVideoExtensions.has(extension);
}

export function isDangerousFile(file: TriblerFile): boolean {
  const normalizedName = file.name.trimEnd().replace(/[. ]+$/, "");
  return dangerousExtensions.has(extname(normalizedName).toLowerCase());
}

export function selectMainVideo(files: TriblerFile[]): TriblerFile | undefined {
  const preferred = files.filter((file) => preferredExtensions.has(extname(file.name).toLowerCase()));
  const candidates = preferred.length > 0 ? preferred : files.filter(isVideoFile);

  return [...candidates].sort((left, right) => {
    const leftSecondary = secondaryNamePattern.test(left.name) ? 1 : 0;
    const rightSecondary = secondaryNamePattern.test(right.name) ? 1 : 0;
    if (leftSecondary !== rightSecondary) return leftSecondary - rightSecondary;
    if (left.size !== right.size) return right.size - left.size;
    const leftRank = preferredExtensions.get(extname(left.name).toLowerCase()) ?? 0;
    const rightRank = preferredExtensions.get(extname(right.name).toLowerCase()) ?? 0;
    if (leftRank !== rightRank) return rightRank - leftRank;
    return left.index - right.index;
  })[0];
}

export function listVideoFiles(files: TriblerFile[]): TriblerFile[] {
  return files.filter(isVideoFile).sort((left, right) => {
    const leftSecondary = secondaryNamePattern.test(left.name) ? 1 : 0;
    const rightSecondary = secondaryNamePattern.test(right.name) ? 1 : 0;
    if (leftSecondary !== rightSecondary) return leftSecondary - rightSecondary;
    const leftHeight = inferVideoHeight(left.name) ?? 0;
    const rightHeight = inferVideoHeight(right.name) ?? 0;
    if (leftHeight !== rightHeight) return rightHeight - leftHeight;
    if (left.size !== right.size) return right.size - left.size;
    const leftRank = preferredExtensions.get(extname(left.name).toLowerCase()) ?? 0;
    const rightRank = preferredExtensions.get(extname(right.name).toLowerCase()) ?? 0;
    if (leftRank !== rightRank) return rightRank - leftRank;
    return left.index - right.index;
  });
}
