import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiOrigin = process.env.FEEDFOLD_DEV_API_ORIGIN ?? "http://127.0.0.1:43001";
const devPort = Number(process.env.FEEDFOLD_DEV_PORT ?? 45173);
const configuredBasePath = process.env.FEEDFOLD_BASE_PATH ?? "/";
if (!configuredBasePath.startsWith("/")) {
  throw new Error("FEEDFOLD_BASE_PATH must start with /");
}
const appBasePath = configuredBasePath === "/" ? "" : configuredBasePath.replace(/\/+$/, "");
const appBaseUrl = `${appBasePath}/`;
const appUrl = (path: string) => `${appBasePath}${path}`;
const appBasePattern = appBasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const apiPathPattern = `${appBasePattern}/(?:api|health)(?:/|$)`;
const stripBasePath = (path: string) => path.slice(appBasePath.length) || "/";

export default defineConfig({
  base: appBaseUrl,
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        id: appBaseUrl,
        name: "feedfold",
        short_name: "feedfold",
        description: "A quiet, keyboard-first, self-hosted feed reader.",
        start_url: appBaseUrl,
        scope: appBaseUrl,
        display: "standalone",
        categories: ["news", "productivity"],
        background_color: "#0f1211",
        theme_color: "#0f1211",
        icons: [
          {
            src: appUrl("/icons/pwa-192.png"),
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: appUrl("/icons/pwa-512.png"),
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        shortcuts: [
          {
            name: "Unread articles",
            short_name: "Unread",
            url: appUrl("/articles/unread"),
            icons: [{ src: appUrl("/icons/pwa-192.png"), sizes: "192x192" }],
          },
          {
            name: "Starred articles",
            short_name: "Starred",
            url: appUrl("/articles/starred"),
            icons: [{ src: appUrl("/icons/pwa-192.png"), sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,webp}"],
        navigateFallback: appUrl("/index.html"),
        navigateFallbackDenylist: [new RegExp(`^${apiPathPattern}`)],
        runtimeCaching: [
          {
            urlPattern: new RegExp(apiPathPattern),
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
      [appUrl("/api")]: {
        target: apiOrigin,
        rewrite: stripBasePath,
      },
      [appUrl("/health")]: {
        target: apiOrigin,
        rewrite: stripBasePath,
      },
    },
  },
});
