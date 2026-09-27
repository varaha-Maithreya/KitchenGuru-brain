import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) with only the traced
  // dependencies, so the production image doesn't carry node_modules.
  output: "standalone",
  // pg optionally requires native bindings; keep it out of the server bundle.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
