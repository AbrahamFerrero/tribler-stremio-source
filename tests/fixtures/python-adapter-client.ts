import { ExternalUrlPolicy } from "../../src/network/url-policy";
import { ExternalHttpStreamProvider } from "../../src/streams/providers/external-http-stream-provider";

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) throw new Error("Adapter URL is required");
  const provider = new ExternalHttpStreamProvider({
    id: "python_adapter",
    name: "Python Adapter Host",
    url,
    timeoutMs: 2_000,
    policy: new ExternalUrlPolicy({ allowedLoopbackUrls: [url] })
  });
  const streams = await provider.resolve(
    {
      id: "python-adapter:test",
      kind: "movie",
      title: "Big Buck Bunny",
      year: 2008,
      externalIds: { imdb: "tt1254207" }
    },
    { signal: new AbortController().signal }
  );
  process.stdout.write(JSON.stringify({ streams }));
}

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
