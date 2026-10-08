import type { NextConfig } from "next";

/** Served at plinkocasi.com/qa, behind the same Caddy proxy as /index. */
const nextConfig: NextConfig = { basePath: "/qa" };

export default nextConfig;
