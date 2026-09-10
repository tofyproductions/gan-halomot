import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build's own identity, and how a running tab learns it is out of date.
 *
 * There is deliberately no caching service worker in this app (see the comment
 * in index.html), so a RELOAD always fetches the new build. The problem was
 * never the cache — it was that nobody reloads. A tab left open on a staff
 * phone, or an installed home-screen app resumed a week later, keeps running
 * last Tuesday's bundle indefinitely and nothing on the screen says so.
 *
 * So each build stamps itself, and emits that stamp as a tiny file beside the
 * bundle. The running app fetches the file, compares it to the stamp compiled
 * INTO it, and when the two differ it says so at the top of the screen with a
 * button that reloads. A version number would need somebody to remember to
 * raise it; the build time cannot be forgotten.
 */
const BUILD_ID = new Date().toISOString();

const emitVersionFile = {
  name: 'emit-version-file',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ build: BUILD_ID }),
    });
  },
};

export default defineConfig({
  plugins: [react(), emitVersionFile],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
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
