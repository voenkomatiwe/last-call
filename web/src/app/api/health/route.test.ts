import { expect, test } from "bun:test";

import { GET } from "./route";

test("GET /api/health reports the running service without caching", async () => {
  const response = GET();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok", service: "last-call-web" });
});
