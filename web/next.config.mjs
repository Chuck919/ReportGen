/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL: process.env.VERCEL ?? "",
  },
  experimental: {
    serverComponentsExternalPackages: [
      "pdf-parse",
      "pdfjs-dist",
      "tesseract.js",
      "tesseract.js-core",
      "@napi-rs/canvas",
    ],
    serverActions: {
      bodySizeLimit: "100mb",
    },
    outputFileTracingIncludes: {
      "/api/**/*": [
        "./node_modules/@napi-rs/canvas/**/*",
        "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*",
        "./node_modules/pdf-parse/**/*",
        "./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
        "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
        "./node_modules/tesseract.js/package.json",
        "./node_modules/tesseract.js/src/**/*",
        "./node_modules/tesseract.js/dist/**/*",
        "./node_modules/tesseract.js-core/**/*",
        "./node_modules/regenerator-runtime/**/*",
        "./node_modules/bmp-js/**/*",
        "./node_modules/wasm-feature-detect/**/*",
        "./node_modules/zlibjs/**/*",
        "./node_modules/is-url/**/*",
        "./node_modules/node-fetch/**/*",
        "./scripts/*.cjs",
      ],
    },
  },
};

export default nextConfig;
