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
  /**
   * Both ports are overridable, because this repo is worked on in several git
   * worktrees at once (a branch per feature, each with its own demo server)
   * and two of them on 5173 means the second one silently serves the first
   * one's build. VITE_API_TARGET has to move with the port for the same
   * reason: a dev server on 3005 behind a proxy pointing at 3001 answers with
   * whatever else happens to be listening there.
   *
   * Unset, these are exactly the values they have always been.
   */
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
