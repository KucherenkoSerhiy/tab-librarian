import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: "src",
  publicDir: r("public"),
  preview: { cors: true },
  build: {
    outDir: r("dist"),
    emptyOutDir: true,
    target: "chrome120",
    // extension pages reject <link rel="modulepreload"> ("cross-world resource
    // mismatch" warnings in chrome://extensions); the chunks load fine without it
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: r("src/sidepanel.html"),
        background: r("src/background.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
