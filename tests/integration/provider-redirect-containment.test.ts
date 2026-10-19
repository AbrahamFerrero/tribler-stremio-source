import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonCatalogProvider } from "../../src/catalog/json-provider";
import { ExternalUrlPolicy, fetchWithValidatedRedirects } from "../../src/network/url-policy";
import { ExternalHttpStreamProvider } from "../../src/streams/providers/external-http-stream-provider";
import { StreamProviderRegistry, StreamResolver } from "../../src/streams/resolver";
import { silentLogger } from "../helpers";

const statuses = [301, 302, 303, 307, 308];
const item = { id: "synthetic:2:3", kind: "episode" as const, title: "Synthetic Episode",
  seriesTitle: "Synthetic Series", year: 1987, season: 2, episode: 3, externalIds: { synthetic: "fixture" } };
const context = { signal: new AbortController().signal };
const credential = "SYNTHETIC_CATALOG_CREDENTIAL";
const payload = { items: [{ id: "fixture", name: "Synthetic Fixture" }],
  streams: [{ type: "https", url: "https://media.example/fixture.mp4" }] };
interface Hit { recipient: string; method: string; path: string; headers: IncomingHttpHeaders; body: string; status: number }
const servers: Server[] = [];

// Real receiving sockets; the existing exact-URL loopback policy protects each fixture.
async function origin(host = "127.0.0.1") {
  const hits: Hit[] = [];
  let connections = 0;
  const routes = new Map<string, { status: number; location?: string }>();
  let gate: Promise<void> | undefined;
  let arrived: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const path = req.url ?? "/";
    const redirect = routes.get(path);
    hits.push({ recipient: base, method: req.method ?? "", path, headers: req.headers, body,
      status: redirect?.status ?? 200 });
    arrived?.();
    if (gate) await gate;
    if (res.destroyed) return;
    if (redirect) {
      res.writeHead(redirect.status, redirect.location === undefined ? {} : { Location: redirect.location });
      res.end("SYNTHETIC_RESPONSE_SECRET");
    } else {
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(payload));
    }
  });
  servers.push(server);
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const base = `http://${host === "::1" ? "[::1]" : host}:${(server.address() as AddressInfo).port}`;
  return { base, hits, connections: () => connections,
    redirect: (path: string, status: number, location?: string) => { routes.set(path, { status, ...(location ? { location } : {}) }); },
    healthy: () => routes.clear(), hold: (promise: Promise<void>, onArrival: () => void) => { gate = promise; arrived = onArrival; } };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(async server => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }));
});
function policy(...urls: string[]) { return new ExternalUrlPolicy({ allowedLoopbackUrls: urls }); }
function external(url: string, urlPolicy: ExternalUrlPolicy, fetchImplementation?: typeof fetch) {
  return new ExternalHttpStreamProvider({ url, policy: urlPolicy, timeoutMs: 1_000,
    ...(fetchImplementation ? { fetchImplementation } : {}) });
}
function catalog(url: string, header?: string, urlPolicy?: ExternalUrlPolicy, fetchImplementation?: typeof fetch) {
  vi.stubEnv("PR19_SYNTHETIC_CREDENTIAL", credential);
  return new JsonCatalogProvider({ id: "synthetic", name: "Synthetic Catalog", type: "movie",
    catalogUrl: url, itemsPath: "items", pageSize: 1, cacheTtlMs: 60_000, requestTimeoutMs: 1_000,
    ...(header ? { headersFromEnv: { [header]: "PR19_SYNTHETIC_CREDENTIAL" } } : {}),
    ...(urlPolicy ? { urlPolicy } : {}), ...(fetchImplementation ? { fetchImplementation } : {}) });
}
const list = { type: "movie" as const, skip: 0 };
const catalogPath = "/catalog?type=movie&skip=0&limit=1";
function refusal(outcome: PromiseSettledResult<unknown>[]) {
  expect(outcome[0]?.status).toBe("rejected");
  const error = outcome[0]?.status === "rejected" ? String(outcome[0].reason) : "";
  expect(error).not.toMatch(/SYNTHETIC_|token=|unintended|127\.0\.0\.1|\[::1\]/);
}

describe("provider redirect authority at actual receiving sockets", () => {
  it.each(statuses)("F2 identity POST refuses cross-origin %i before a connection", async status => {
    const a = await origin(), b = await origin();
    const target = `${b.base}/unintended?token=SYNTHETIC_LOCATION`;
    a.redirect("/resolve", status, target);
    const result = await Promise.allSettled([external(`${a.base}/resolve`, policy(`${a.base}/resolve`, target)).resolve(item, context)]);
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0); refusal(result);
    expect(a.hits).toHaveLength(1);
    expect(a.hits[0]).toMatchObject({ recipient: a.base, method: "POST", path: "/resolve", status, body: JSON.stringify({
      id: item.id, type: item.kind, title: item.title, seriesTitle: item.seriesTitle, year: item.year,
      season: item.season, episode: item.episode, externalIds: item.externalIds }) });
  });
  for (const header of ["Authorization", "X-Synthetic-Access"]) {
    for (const withPolicy of [true, false]) {
      it.each(statuses)(`F3 ${header}, policy=${withPolicy}, refuses cross-origin %i`, async status => {
        const a = await origin(), b = await origin();
        const target = `${b.base}/unintended?token=SYNTHETIC_LOCATION`;
        a.redirect(catalogPath, status, target);
        const c = catalog(`${a.base}/catalog`, header, withPolicy ? policy(`${a.base}${catalogPath}`, target) : undefined);
        const result = await Promise.allSettled([c.list(list)]);
        expect(b.hits).toEqual([]); expect(b.connections()).toBe(0); refusal(result);
        expect(a.hits).toHaveLength(1);
        expect(a.hits[0]).toMatchObject({ recipient: a.base, method: "GET", path: catalogPath, status, body: "" });
        expect(a.hits[0]?.headers[header.toLowerCase()]).toBe(credential);
      });
    }
  }
  it.each(statuses)("preserves same-origin POST payload and catalog authentication for %i", async status => {
    const a = await origin(); a.redirect("/resolve", status, "/resolved"); a.redirect(catalogPath, status, "/listed");
    const p = policy(`${a.base}/resolve`, `${a.base}/resolved`, `${a.base}${catalogPath}`, `${a.base}/listed`);
    expect(await external(`${a.base}/resolve`, p).resolve(item, context)).toEqual([{ ...payload.streams[0], providerId: "external_http" }]);
    const c = catalog(`${a.base}/catalog`, "Authorization", p);
    const listed = await c.list(list);
    expect(listed).toMatchObject([{ name: "Synthetic Fixture", id: "tribler:source:synthetic:Zml4dHVyZQ" }]);
    expect(await c.get(listed[0]!.id)).toEqual(listed[0]); // Existing record cache avoids a request.
    expect(a.hits.map(hit => [hit.method, hit.path, hit.body])).toEqual([
      ["POST", "/resolve", a.hits[0]!.body], ["POST", "/resolved", a.hits[0]!.body], ["GET", catalogPath, ""], ["GET", "/listed", ""]
    ]);
    expect(a.hits.slice(2).map(hit => hit.headers.authorization)).toEqual([credential, credential]);
  });
  it.each(statuses)("preserves anonymous catalog cross-origin GET for %i", async status => {
    const a = await origin(), b = await origin(); a.redirect(catalogPath, status, `${b.base}/listed`);
    expect(await catalog(`${a.base}/catalog`, undefined, policy(`${a.base}${catalogPath}`, `${b.base}/listed`)).list(list)).toHaveLength(1);
    expect(b.hits).toHaveLength(1); expect(b.hits[0]).toMatchObject({ method: "GET", body: "", status: 200 });
    expect(b.hits[0]?.headers.authorization).toBeUndefined();
  });
  it("refuses A -> A -> B -> A before B and repeats safely without a recovery cache", async () => {
    const a = await origin(), b = await origin(); a.redirect("/resolve", 302, "/middle");
    a.redirect("/middle", 307, `${b.base}/return`); b.redirect("/return", 308, `${a.base}/resolved`);
    const provider = external(`${a.base}/resolve`, policy(`${a.base}/resolve`, `${a.base}/middle`, `${b.base}/return`, `${a.base}/resolved`));
    for (let i = 0; i < 2; i += 1) refusal(await Promise.allSettled([provider.resolve(item, context)]));
    expect(a.hits.map(hit => hit.path)).toEqual(["/resolve", "/middle", "/resolve", "/middle"]);
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it.each([true, false])("injected native fetch obeys manual authority, policy=%s", async withPolicy => {
    const a = await origin(), b = await origin(); a.redirect("/resolve", 303, `${b.base}/unintended`);
    a.redirect(catalogPath, 308, `${b.base}/unintended`);
    const injected: typeof fetch = (url, init) => { expect(init?.redirect).toBe("manual"); return fetch(url, init); };
    const p = policy(`${a.base}/resolve`, `${a.base}${catalogPath}`, `${b.base}/unintended`);
    refusal(await Promise.allSettled([external(`${a.base}/resolve`, p, injected).resolve(item, context)]));
    refusal(await Promise.allSettled([catalog(`${a.base}/catalog`, "X-Synthetic-Access", withPolicy ? p : undefined, injected).list(list)]));
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it("allows authenticated no-policy same-origin redirects through native fetch", async () => {
    const a = await origin(); a.redirect(catalogPath, 303, "/listed");
    expect(await catalog(`${a.base}/catalog`, "X-Synthetic-Access").list(list)).toHaveLength(1);
    expect(a.hits.map(hit => hit.headers["x-synthetic-access"])).toEqual([credential, credential]);
  });
  it("contains IPv6 same-host different-port identity redirects", async () => {
    const a = await origin("::1"), b = await origin("::1"); a.redirect("/resolve", 307, `${b.base}/unintended`);
    refusal(await Promise.allSettled([external(`${a.base}/resolve`, policy(`${a.base}/resolve`, `${b.base}/unintended`)).resolve(item, context)]));
    expect(a.hits).toHaveLength(1); expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it.each(["https://127.0.0.1", "http://fixture:synthetic@127.0.0.1"])("refuses scheme/userinfo target %s without disclosure", async prefix => {
    const a = await origin(), b = await origin(); const port = new URL(b.base).port;
    a.redirect("/resolve", 302, `${prefix}:${port}/unintended?token=SYNTHETIC_LOCATION`);
    refusal(await Promise.allSettled([external(`${a.base}/resolve`, policy(`${a.base}/resolve`)).resolve(item, context)]));
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it("missing Location and malformed Location fail without revealing response values", async () => {
    const a = await origin(); const provider = external(`${a.base}/resolve`, policy(`${a.base}/resolve`));
    for (const location of [undefined, "http://[SYNTHETIC_LOCATION_SECRET"]) {
      a.redirect("/resolve", 302, location); refusal(await Promise.allSettled([provider.resolve(item, context)]));
    }
    expect(a.hits).toHaveLength(2);
  });
  it("same-origin loops retain the redirect cap", async () => {
    const a = await origin(); a.redirect("/resolve", 307, "/resolve");
    await expect(external(`${a.base}/resolve`, policy(`${a.base}/resolve`)).resolve(item, context)).rejects.toThrow("redirect limit");
    expect(a.hits).toHaveLength(4);
  });
  it("cancels a slow authorized receiver and never reaches its redirect", async () => {
    const a = await origin(), b = await origin(); a.redirect("/resolve", 307, `${b.base}/unintended`);
    let release!: () => void, arrived!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const received = new Promise<void>(resolve => { arrived = resolve; }); a.hold(gate, arrived);
    const controller = new AbortController();
    const pending = Promise.allSettled([external(`${a.base}/resolve`, policy(`${a.base}/resolve`, `${b.base}/unintended`))
      .resolve(item, { signal: controller.signal })]);
    await received; controller.abort(); const outcome = await pending; release();
    expect(outcome[0]?.status).toBe("rejected"); expect(a.hits).toHaveLength(1);
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it("registry isolates the refused provider and preserves a healthy sibling result", async () => {
    const a = await origin(), b = await origin(); a.redirect("/resolve", 307, `${b.base}/unintended`);
    const logs: unknown[] = [];
    const registry = new StreamProviderRegistry(1_500, { ...silentLogger, warn: (...args) => { logs.push(args); } });
    registry.register(external(`${a.base}/resolve`, policy(`${a.base}/resolve`, `${b.base}/unintended`)));
    registry.register({ id: "healthy", name: "Synthetic sibling", isEnabled: () => true,
      resolve: () => Promise.resolve([{ providerId: "healthy", type: "https", url: "https://media.example/healthy.mp4" }]) });
    const resolver = new StreamResolver(registry, new ExternalUrlPolicy({ resolver: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]) }));
    expect((await resolver.resolve(item)).map(source => source.url)).toEqual(["https://media.example/healthy.mp4"]);
    expect(resolver.diagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "external_http", status: "error" })]));
    expect(JSON.stringify(logs)).not.toMatch(/SYNTHETIC_|unintended|token=/);
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it("anonymous shared helper still validates a private redirect before a connection", async () => {
    const a = await origin(), b = await origin(); a.redirect("/public", 302, `${b.base}/blocked`);
    await expect(fetchWithValidatedRedirects(`${a.base}/public`, policy(`${a.base}/public`), {})).rejects.toThrow("private");
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it("same-origin signed queries remain internal and arrive unchanged", async () => {
    const a = await origin(); const next = "/resolved?token=SYNTHETIC_SIGNED_QUERY";
    a.redirect("/resolve", 307, next);
    expect(await external(`${a.base}/resolve`, policy(`${a.base}/resolve`, `${a.base}${next}`)).resolve(item, context)).toHaveLength(1);
    expect(a.hits.map(hit => hit.path)).toEqual(["/resolve", next]);
    expect(a.hits[1]?.body).toBe(a.hits[0]?.body);
  });
  it("no-policy catalog rejects same-origin userinfo without reflecting Location", async () => {
    const a = await origin(); const target = new URL("/listed", a.base); target.username = "SYNTHETIC_USERINFO_SECRET";
    a.redirect(catalogPath, 302, target.href);
    refusal(await Promise.allSettled([catalog(`${a.base}/catalog`, "X-Synthetic-Access").list(list)]));
    expect(a.hits).toHaveLength(1);
  });
  it("itemUrl credential redirects use the same authority gate without a URL policy", async () => {
    const a = await origin(), b = await origin(); a.redirect("/item/fixture", 308, `${b.base}/unintended`);
    vi.stubEnv("PR19_SYNTHETIC_CREDENTIAL", credential);
    const c = new JsonCatalogProvider({ id: "synthetic", name: "Synthetic Catalog", type: "movie", items: [],
      itemUrl: `${a.base}/item/{id}`, pageSize: 1, cacheTtlMs: 60_000, requestTimeoutMs: 1_000,
      headersFromEnv: { "X-Synthetic-Access": "PR19_SYNTHETIC_CREDENTIAL" } });
    refusal(await Promise.allSettled([c.get("tribler:source:synthetic:Zml4dHVyZQ")]));
    expect(a.hits[0]?.headers["x-synthetic-access"]).toBe(credential);
    expect(b.hits).toEqual([]); expect(b.connections()).toBe(0);
  });
  it("no-policy authenticated same-origin chains preserve the native 20-hop allowance", async () => {
    const a = await origin(); a.redirect(catalogPath, 302, "/hop/0");
    for (let i = 0; i < 4; i += 1) a.redirect(`/hop/${i}`, 302, `/hop/${i + 1}`);
    expect(await catalog(`${a.base}/catalog`, "Authorization").list(list)).toHaveLength(1);
    expect(a.hits).toHaveLength(6); expect(a.hits.every(hit => hit.headers.authorization === credential)).toBe(true);
  });
});
