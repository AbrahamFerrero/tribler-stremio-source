import { randomBytes } from "node:crypto";
import { strongEtag, type RepresentationBinding } from "../network/http-privacy";

/** One bounded observation per existing playback token, with no enumerable private data. */
export class RepresentationState {
  #binding: Readonly<RepresentationBinding> | undefined;
  #generation = 0;
  readonly #active: () => boolean;

  constructor(active: () => boolean) { this.#active = active; }
  clear(): void { this.#binding = undefined; this.#generation += 1; }

  begin(ifRange: unknown) {
    const generation = ++this.#generation;
    const prior = this.#active() ? this.#binding : undefined;
    const binding = typeof ifRange === "string" && ifRange === prior?.opaqueEtag ? prior : undefined;
    const invalidate = (): void => { if (generation === this.#generation) this.#binding = undefined; };
    return {
      binding,
      active: this.#active,
      bindingActive: (): boolean => this.#active() && binding !== undefined && this.#binding === binding,
      invalidate,
      observe: (effectiveUrl: string, requestKey: string | undefined, rawEtag: string | null, canCreate: boolean): string | undefined => {
        const upstreamEtag = strongEtag(rawEtag);
        if (!this.#active() || effectiveUrl.length > 8_192 || !requestKey || requestKey.length !== 64 || !upstreamEtag) {
          invalidate(); return undefined;
        }
        const current = this.#binding;
        if (current?.effectiveUrl === effectiveUrl && current.requestKey === requestKey && current.upstreamEtag === upstreamEtag) return current.opaqueEtag;
        // A late response may stream, but cannot overwrite a newer request's observation.
        if (generation !== this.#generation) return undefined;
        if (!canCreate) { invalidate(); return undefined; }
        const opaqueEtag = `"${randomBytes(24).toString("base64url")}"`;
        this.#binding = Object.freeze({ effectiveUrl, requestKey, upstreamEtag, opaqueEtag });
        return opaqueEtag;
      }
    };
  }
}
