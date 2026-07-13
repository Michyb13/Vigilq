import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export: the engine's Fastify server serves these files directly,
  // so the dashboard and the API share one process and one port. No server
  // component data fetching, no dynamic routes ([id] segments) — every page
  // is a plain client component fetching from the same-origin API at
  // runtime, same as any other API consumer.
  output: "export",

  // Every existing engine API route (/jobs, /pools/depths, etc.) already
  // occupies the root path space, so the dashboard is mounted under its own
  // prefix to avoid any collision.
  basePath: "/dashboard",

  // Directory + index.html output (e.g. jobs/index.html) instead of flat
  // jobs.html — this is what plain static file servers (like
  // @fastify/static) resolve automatically for a request to /dashboard/jobs.
  trailingSlash: true,

  images: {
    unoptimized: true, // next/image's optimizer needs a server; static export has none
  },
};

export default nextConfig;
