import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiOrigin = process.env.FEEDFOLD_DEV_API_ORIGIN ?? "http://127.0.0.1:43001";
const devPort = Number(process.env.FEEDFOLD_DEV_PORT ?? 45173);

export default defineConfig({
  base: "/feedfold/",
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        id: "/feedfold/",
        name: "feedfold",
        short_name: "feedfold",
        description: "A quiet, keyboard-first, self-hosted feed reader.",
        start_url: "/feedfold/",
        scope: "/feedfold/",
        display: "standalone",
        categories: ["news", "productivity"],
        background_color: "#0f1211",
        theme_color: "#0f1211",
        icons: [
          {
            src: "/feedfold/icons/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/feedfold/icons/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        shortcuts: [
          {
            name: "Unread articles",
            short_name: "Unread",
            url: "/feedfold/articles/unread",
            icons: [{ src: "/feedfold/icons/pwa-192.png", sizes: "192x192" }],
          },
          {
            name: "Starred articles",
            short_name: "Starred",
            url: "/feedfold/articles/starred",
            icons: [{ src: "/feedfold/icons/pwa-192.png", sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,webp}"],
        navigateFallback: "/feedfold/index.html",
        navigateFallbackDenylist: [/^\/feedfold\/(?:api|health)(?:\/|$)/],
        runtimeCaching: [
          {
            urlPattern: /\/feedfold\/(?:api|health)(?:\/|$)/,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: devPort,
    strictPort: true,
    proxy: {
      "/feedfold/api": {
        target: apiOrigin,
        rewrite: (path) => path.replace(/^\/feedfold/, ""),
      },
      "/feedfold/health": {
        target: apiOrigin,
        rewrite: (path) => path.replace(/^\/feedfold/, ""),
      },
    },
  },
});
