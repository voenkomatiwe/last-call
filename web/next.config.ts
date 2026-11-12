import type { NextConfig } from "next";

const config: NextConfig = {
  // The repository's own AGENTS.md governs agents; Next must not write another one into the workspace.
  agentRules: false,
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
