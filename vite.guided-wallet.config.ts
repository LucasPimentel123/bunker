import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'bunker-dist/designs/assets/runtime', emptyOutDir: false,
    lib: { entry: 'src/prototype/guided-wallet.ts', formats: ['es'], fileName: () => 'guided-wallet.js' },
    sourcemap: false,
  },
});
