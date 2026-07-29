import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/echovale/",
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        id: "/echovale/",
        name: "Echovale",
        short_name: "Echovale",
        description: "A quiet, keyboard-first, self-hosted feed reader.",
        start_url: "/echovale/",
        scope: "/echovale/",
        display: "standalone",
        categories: ["news", "productivity"],
        background_color: "#121312",
        theme_color: "#121312",
        icons: [
          {
            src: "/echovale/icons/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/echovale/icons/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        shortcuts: [
          {
            name: "Unread articles",
            short_name: "Unread",
            url: "/echovale/articles/unread",
            icons: [{ src: "/echovale/icons/pwa-192.png", sizes: "192x192" }],
          },
          {
            name: "Starred articles",
            short_name: "Starred",
            url: "/echovale/articles/starred",
            icons: [{ src: "/echovale/icons/pwa-192.png", sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png}"],
        navigateFallback: "/echovale/index.html",
        navigateFallbackDenylist: [/^\/echovale\/(?:api|health)(?:\/|$)/],
        runtimeCaching: [
          {
            urlPattern: /\/echovale\/(?:api|health)(?:\/|$)/,
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
    port: 45173,
    strictPort: true,
    proxy: {
      "/echovale/api": {
        target: "http://127.0.0.1:43001",
        rewrite: (path) => path.replace(/^\/echovale/, ""),
      },
      "/echovale/health": {
        target: "http://127.0.0.1:43001",
        rewrite: (path) => path.replace(/^\/echovale/, ""),
      },
    },
  },
});
