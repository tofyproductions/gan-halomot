import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /**
   * What a visitor can read.
   *
   * The bundle is downloaded to the browser to run, so it can always be read —
   * that is what a browser IS, and no setting changes it. What can be decided
   * is how much is handed over on top of that: source maps would rebuild the
   * original files, comments and all, from the minified bundle, and console
   * lines name internal functions and print what they were doing.
   *
   * Neither is generated. The parts worth protecting — how a salary is worked
   * out, what a customer is charged, who may see which child — run on the
   * server and are never sent anywhere.
   */
  build: {
    sourcemap: false,
    minify: 'esbuild',
  },
  esbuild: {
    drop: ['console', 'debugger'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
