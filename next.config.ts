import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  // Root cause of the live production PHOTO_HOST_NOT_PERMITTED follow-up
  // bug ("TypeError: Failed to fetch" from the extension, once host
  // permission was fixed): heic-convert -> heic-decode -> libheif-js loads
  // its actual decoder via a DYNAMIC require() of a .wasm binary
  // (libheif-js/libheif-wasm/libheif.wasm) that webpack itself already
  // flags at build time ("Critical dependency: require function is used in
  // a way in which dependencies cannot be statically extracted"). Next's
  // own Vercel file tracer has the identical blind spot: verified directly
  // against this repo's own build output — `route.js.nft.json` for
  // app/api/extension/batch/photos/[itemId]/[position]/route.ts (and,
  // separately, every other route that transitively imports heic-convert)
  // lists 60+ traced files with ZERO of them being the .wasm binary. On
  // Vercel, a missing traced file is simply never uploaded with the
  // serverless function — so `require()`-ing it at MODULE LOAD time (heic-
  // convert's own top-level import chain, not merely when a HEIC photo is
  // actually converted) crashes the function before it can ever construct
  // an HTTP response, which is exactly what makes the extension's own
  // fetch() see a raw connection failure ("Failed to fetch") instead of any
  // clean JSON error this route's own try/catch blocks would otherwise
  // return. Explicitly including the wasm file (and its sibling asset,
  // just in case) here is the standard Vercel/Next.js remedy for a
  // dynamically-required native/wasm dependency the tracer can't see on
  // its own.
  outputFileTracingIncludes: {
    "/api/extension/batch/photos/[itemId]/[position]": [
      "./node_modules/libheif-js/libheif-wasm/*.wasm",
      "./node_modules/libheif-js/libheif-wasm/*.js",
    ],
  },
};

export default nextConfig;
