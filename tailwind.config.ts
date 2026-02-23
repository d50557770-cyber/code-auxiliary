import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#ffffff",
          1: "#f8fafc",
          2: "#f1f5f9",
          3: "#e2e8f0",
        },
        ink: {
          primary: "#0f172a",
          secondary: "#334155",
          muted: "#64748b",
          ghost: "#f1f5f9",
        },
        accent: {
          cyan: "#06b6d4",
          green: "#10b981",
          amber: "#f59e0b",
          violet: "#8b5cf6",
        },
      },
      fontFamily: {
        sans: ['"Noto Sans JP"', "sans-serif"],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', "monospace"],
        code: ['"JetBrains Mono"', "monospace"],
      },
      borderRadius: {
        card: "10px",
      },
      animation: {
        "slide-in": "slideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)",
        "blink": "blink 1.1s step-end infinite",
        "pulse-dot": "pulseDot 2s ease-in-out infinite",
        "shimmer": "shimmer 1.5s ease-in-out infinite",
      },
      keyframes: {
        slideIn: {
          "0%": { opacity: "0", transform: "translateX(-8px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(0.85)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
