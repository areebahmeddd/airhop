import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import path from "path";
import { defineConfig } from "vite";
import { staticHtml } from "./plugins/static-html.ts";

const appJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../app.json"), "utf8"),
) as { expo: { version: string } };

export default defineConfig({
  plugins: [react(), tailwindcss(), staticHtml()],
  define: {
    __APP_VERSION__: JSON.stringify(appJson.expo.version),
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
