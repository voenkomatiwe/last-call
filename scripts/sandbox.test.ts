import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifiedWasm, WASM_PATH } from "./sandbox";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

test("the committed wasm matches its sha256 file", async () => {
  const wasm = await verifiedWasm();
  expect(wasm.byteLength).toBe(Bun.file(WASM_PATH).size);
});

test("a wasm that does not match fails with both hashes in the message", async () => {
  dir = await mkdtemp(join(tmpdir(), "lastcall-wasm-"));
  const wasm = join(dir, "last_call.wasm");
  const sha = join(dir, "last_call.wasm.sha256");
  await copyFile(WASM_PATH, wasm);
  await writeFile(sha, `${"0".repeat(64)}  last_call.wasm\n`);
  await expect(verifiedWasm({ wasm, sha256: sha })).rejects.toThrow(/has sha256 [0-9a-f]{64}, expected 0{64}/);
});
