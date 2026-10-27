import { defineConfig } from 'vite';
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'bunker-dist/designs/assets/runtime', emptyOutDir: true,
    lib: { entry: 'src/prototype/guided-discovery.ts', name: 'PicnicGuidedDiscovery', formats: ['iife'], fileName: () => 'guided-discovery.js' },
    sourcemap: false,
  },
});
