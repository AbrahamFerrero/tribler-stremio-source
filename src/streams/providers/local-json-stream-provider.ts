import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { ManualStreamProvider } from "./manual-stream-provider";
import type { NormalizedStreamSource } from "../types";

export class LocalJsonStreamProvider extends ManualStreamProvider {
  override readonly id = "local_json";
  override readonly name = "Local JSON streams";

  constructor(filePath: string, allowedDirectory: string) {
    const allowed = realpathSync(allowedDirectory);
    const candidate = realpathSync(isAbsolute(filePath) ? filePath : resolve(allowed, filePath));
    const pathFromAllowed = relative(allowed, candidate);
    if (pathFromAllowed.startsWith("..") || isAbsolute(pathFromAllowed) || dirname(candidate) === candidate) {
      throw new Error("Local stream JSON file is outside the configured directory");
    }
    const payload = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("Local stream JSON must be an object keyed by media id");
    }
    const sources: Record<string, NormalizedStreamSource[]> = {};
    for (const [id, value] of Object.entries(payload as Record<string, unknown>)) {
      if (Array.isArray(value)) sources[id] = value as NormalizedStreamSource[];
    }
    super(sources);
  }
}
