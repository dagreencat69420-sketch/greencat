import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        gc: {
          bg: "#070a08",
          panel: "#0d1410",
          lime: "#b8ff3c",
          limeDim: "#7ab82e",
          neon: "#d4ff6a",
          mute: "#8a9a8a",
          border: "#1e3a24",
        },
      },
      boxShadow: {
        neon: "0 0 20px rgba(184, 255, 60, 0.35)",
        neonSm: "0 0 10px rgba(184, 255, 60, 0.25)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
