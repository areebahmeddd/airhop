import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import path from "path";
import { defineConfig } from "vite";
import { staticHtml } from "./plugins/static-html.ts";

const appJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../app.json"), "utf8"),
) as { expo: { version: string; extra?: { releaseDate?: string } } };

const releaseDate = appJson.expo.extra?.releaseDate ?? "";

if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
  throw new Error(`app.json expo.extra.releaseDate must be YYYY-MM-DD, got "${releaseDate}"`);
}

export default defineConfig({
  plugins: [react(), tailwindcss(), staticHtml()],
  define: {
    __APP_VERSION__: JSON.stringify(appJson.expo.version),
    __RELEASE_DATE__: JSON.stringify(releaseDate),
  },
  build: {
    manifest: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
