/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL: process.env.VERCEL ?? "",
  },
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "tesseract.js", "tesseract.js-core"],
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
};

export default nextConfig;
