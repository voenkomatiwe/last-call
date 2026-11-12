import type { Metadata } from "next";

import { BarHarness } from "@/game/bar/bar-harness";

export const metadata: Metadata = { title: "Bar harness" };

export default function BarHarnessPage() {
  return <BarHarness />;
}
