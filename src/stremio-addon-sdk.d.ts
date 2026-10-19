declare module "stremio-addon-sdk" {
  import type { Router } from "express";

  export interface AddonInterface {
    manifest: Record<string, unknown>;
    get(args: Record<string, unknown>): Promise<unknown>;
  }

  export class addonBuilder {
    constructor(manifest: Record<string, unknown>);
    defineStreamHandler(handler: (args: { type: string; id: string }) => Promise<unknown>): void;
    defineCatalogHandler(handler: (args: {
      type: string;
      id: string;
      extra?: { skip?: string; search?: string };
    }) => Promise<unknown>): void;
    defineMetaHandler(handler: (args: { type: string; id: string }) => Promise<unknown>): void;
    getInterface(): AddonInterface;
  }

  export function getRouter(addonInterface: AddonInterface): Router;
}
