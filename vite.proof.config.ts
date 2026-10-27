import { defineConfig } from "vite";
export default defineConfig({ root: "proof", base: "/", define: { __PASSKEY_EXTENSION__: "false" }, build: { outDir: "../proof-dist", emptyOutDir: true, sourcemap: false } });
