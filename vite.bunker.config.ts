import { defineConfig } from "vite";
export default defineConfig({
  root: "proof", publicDir: "../public", base: "/",
  define: { __PASSKEY_EXTENSION__: "false", __PASSKEY_LOCAL_BUNKER__: "true" },
  build: { outDir: "../bunker-dist", emptyOutDir: true, sourcemap: false },
});
