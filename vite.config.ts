import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dts from "vite-plugin-dts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    // Emit declarations to dist/types (matching the package.json "exports"
    // map). CSS side-effect imports are stripped automatically. bundleTypes
    // rolls each entry into a single self-contained .d.ts so consumers under
    // Node16 module resolution have no unresolved relative imports, and the
    // cjs outDir adds matching .d.cts files for the "require" condition.
    dts({
      tsconfigPath: resolve(__dirname, "tsconfig.build.json"),
      entryRoot: resolve(__dirname, "src"),
      bundleTypes: true,
      outDirs: ["dist/types", { dir: "dist/types", moduleFormat: "cjs" }],
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        react: resolve(__dirname, "src/react.ts"),
      },
      name: "GeoLibrePluginTemplate",
      formats: ["es", "cjs"],
      fileName: (format, entryName) => {
        const ext = format === "es" ? "mjs" : "cjs";
        return `${entryName}.${ext}`;
      },
    },
    rollupOptions: {
      external: ["react", "react-dom", "maplibre-gl"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "maplibre-gl": "maplibregl",
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "style.css")
            return "geolibre-plugin-template.css";
          return assetInfo.name || "";
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    minify: false,
  },
});
