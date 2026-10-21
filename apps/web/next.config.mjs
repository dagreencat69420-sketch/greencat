/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // BUGSWEEP-2026-10-07 WEB-01: no framing (clickjacking of Bet / Claim / admin buttons from another site),
  // no MIME sniffing, no full-URL referrers to third parties. Kept deliberately small: no script CSP
  // (wallet adapters inject scripts), only frame-ancestors.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
  // Cat Fight, community chat and the wheel removed Oct 12, 2026 by owner.
  async redirects() {
    return [{ source: "/fight", destination: "/", permanent: false }, { source: "/fight/:path*", destination: "/", permanent: false }, { source: "/chat", destination: "/", permanent: false }, { source: "/wheel", destination: "/", permanent: false }, { source: "/wheel/:path*", destination: "/", permanent: false }, { source: "/chat/:path*", destination: "/", permanent: false }];
  },
  transpilePackages: [
    "@greencat/sdk",
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-react-ui",
    "@solana/wallet-adapter-phantom",
    "@solana/web3.js",
  ],
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;
