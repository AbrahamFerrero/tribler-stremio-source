import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/config";
import { createStreamMediaItem } from "../src/addon";
import { createCatalogProviders } from "../src/catalog/factory";
import type { Logger } from "../src/logger";
import { StremioMovieMetadataLookup } from "../src/metadata/movie-metadata";
import { DirectTransport } from "../src/network/outbound-transport";
import { requestPinned } from "../src/network/url-policy";
import { createProviderEndpointPolicy, createStreamResolver, createUrlPolicy } from "../src/streams/factory";
import { CONTENT_TRUTHS, RejectedSourceReview, RULE_VERDICTS } from "../src/qa/rejected-source-review";
import { IdentityDiagnostics, formatIdentityDiagnostics } from "../src/qa/identity-diagnostics";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function main(): Promise<void> {
  const id = process.argv[2];
  if (process.argv.length !== 3 || !id || !/^tt\d{7,10}$/.test(id) || !process.stdin.isTTY) {
    console.error("Run interactively: npx.cmd tsx scripts/review-rejected-source.ts tt1234567");
    process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  const policy = createUrlPolicy(config);
  let mediaHttpRequests = 0;
  const transport = new DirectTransport(policy, config.httpPrivacy, quiet, (target, init) => {
    mediaHttpRequests += 1;
    return requestPinned(target, init);
  });
  const lookup = new StremioMovieMetadataLookup({ baseUrl: config.stremioMovieMetadataBaseUrl ?? "https://v3-cinemeta.strem.io",
    endpointPolicy: url => createProviderEndpointPolicy(config, url) });
  const metadata = await lookup.lookup(id);
  const item = { ...createStreamMediaItem("movie", id), ...(metadata ?? {}) };
  const review = new RejectedSourceReview(transport, item);
  const diagnostics = new IdentityDiagnostics(item, review);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const interrupt = (): void => { terminal.close(); void review.close(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const resolver = createStreamResolver(createCatalogProviders(config, policy), config, quiet, policy, transport, undefined, diagnostics.trace);
    await resolver.resolve(item, review.signal); // Single real resolution; no autoplay or bulk discovery.
    const summaries = review.summaries();
    if (!summaries.length) {
      console.log(formatIdentityDiagnostics(diagnostics.report(resolver.directProbeDiagnostics(), mediaHttpRequests, resolver.diagnostics())));
      console.log("No eligible review; these observations do not establish content truth or provider health.");
      return;
    }
    console.log(JSON.stringify(summaries, null, 2));
    const choice = (await terminal.question("Paste one temporary candidate ID (blank cancels): ", { signal: review.signal })).trim();
    if (!choice) return;
    const handle = await review.select(choice);
    console.log("Open this temporary localhost handle in a local player; session expires within 5 minutes:");
    console.log(handle); // Explicit playback capability only, never an upstream locator or a persisted report.
    console.log("Content truth: " + CONTENT_TRUTHS.join(" / "));
    const contentTruth = (await terminal.question("CONTENT TRUTH (no default): ", { signal: review.signal })).trim();
    console.log("Rule verdict: " + RULE_VERDICTS.join(" / "));
    const ruleVerdict = (await terminal.question("RULE VERDICT (no default): ", { signal: review.signal })).trim();
    if (!CONTENT_TRUTHS.some(value => value === contentTruth) || !RULE_VERDICTS.some(value => value === ruleVerdict)) {
      throw new Error("Explicit valid verdicts required");
    }
    review.adjudicate(choice, contentTruth as typeof CONTENT_TRUTHS[number], ruleVerdict as typeof RULE_VERDICTS[number]);
    console.log(JSON.stringify(review.adjudication()));
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    terminal.close();
    await review.close();
  }
}
void main().catch(() => { console.error("Local review failed or cancelled; no upstream details emitted."); process.exitCode = 1; });
