import { lookup } from "node:dns/promises";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
  ttlSeconds?: number;
}

export interface DnsResolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export class SystemDnsResolver implements DnsResolver {
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    const results = await lookup(hostname, { all: true, verbatim: true });
    return results.flatMap(({ address, family }) =>
      family === 4 || family === 6 ? [{ address, family }] : []
    );
  }
}
