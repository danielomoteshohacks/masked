/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves this project from /masked/, not from the domain root.
  // A relative base makes every asset URL relative to index.html, so the same
  // build works on Pages, on `vite preview`, and if the repo is ever renamed.
  base: './',
  build: {
    outDir: 'dist',
    // Source maps help when debugging the audio engine in the deployed build.
    sourcemap: true,
  },
  test: {
    // The DSP code is pure math on arrays, so Node is enough; no browser
    // emulation is needed to test it.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
