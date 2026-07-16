/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
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
  },
};

export default nextConfig;
