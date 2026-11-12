import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import HomePage from "./page";

const saved = process.env.NEXT_PUBLIC_CONTRACT_ID;
afterEach(() => {
  process.env.NEXT_PUBLIC_CONTRACT_ID = saved;
});

test("a missing contract ID shows a configuration error instead of crashing", () => {
  process.env.NEXT_PUBLIC_CONTRACT_ID = "";
  const html = renderToStaticMarkup(HomePage());
  expect(html).toContain('role="alert"');
  expect(html).toContain("NEXT_PUBLIC_CONTRACT_ID is not set");
});

test("an invalid contract ID names the variable", () => {
  process.env.NEXT_PUBLIC_CONTRACT_ID = "Not A Valid Id";
  expect(renderToStaticMarkup(HomePage())).toContain("NEXT_PUBLIC_CONTRACT_ID is not a valid NEAR account ID");
});

test("a valid contract ID renders the game screen", () => {
  process.env.NEXT_PUBLIC_CONTRACT_ID = "v1.last-call.testnet";
  const html = renderToStaticMarkup(HomePage());
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("Loading");
});
