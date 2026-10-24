/** Unknown stays distinct from known zero. Never coerce, round or truncate. */
export function validSeedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
