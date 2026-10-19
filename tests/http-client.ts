import request from "supertest";
import { syntheticAdminToken } from "./helpers";

/** Authorized synthetic operator/Desktop client. Negative boundary tests use raw supertest. */
export default function authorizedRequest(app: Parameters<typeof request>[0]) {
  return request.agent(app).use((test: request.Test) => {
    const path = new URL(test.url).pathname;
    if (/^\/(health|providers|resolve|downloads)(?:\/|$)/i.test(path)) {
      test.set("Authorization", `Bearer ${syntheticAdminToken}`);
    } else if (/^\/(catalog|meta|stream)\//.test(path)) {
      test.set("Origin", "https://web.stremio.com");
    }
  });
}
