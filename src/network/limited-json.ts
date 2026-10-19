export async function readLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("json")) throw new Error("Remote response is not JSON");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumBytes) throw new Error("Remote JSON response is too large");
  if (!response.body) throw new Error("Remote JSON response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.length;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Remote JSON response is too large");
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
