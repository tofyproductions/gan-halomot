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

    /**
     * Which third-party code travels together.
     *
     * Screens are split by route (see App.jsx), which took the first download
     * from 4MB to 2.3MB — but the remainder is almost all library code, and it
     * was still one block. Two things follow from splitting it.
     *
     * The heavy, occasional ones stop riding along: the spreadsheet writer, the
     * PDF renderer and the chart library together are most of a megabyte, and
     * they are needed by the person exporting payroll to Excel, not by the
     * assistant opening the infant board on a phone. They now arrive with the
     * screen that asks for them.
     *
     * And the rest — React, MUI, the router — is the part that does NOT change
     * when we ship a design fix. Kept in its own file it keeps its cache across
     * deploys, so a staff member who has used the app before downloads the
     * changed screens and nothing else.
     */
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('xlsx')) return 'vendor-xlsx';
          if (id.includes('html2pdf') || id.includes('html2canvas') || id.includes('jspdf')) return 'vendor-pdf';
          if (id.includes('apexcharts')) return 'vendor-charts';
          if (id.includes('@dnd-kit')) return 'vendor-dnd';
          if (id.includes('signature')) return 'vendor-signature';
          if (id.includes('@mui') || id.includes('@emotion')) return 'vendor-mui';
          // React, the router and everything else unclaimed go in ONE bucket.
          // Splitting react out from a catch-all made the two depend on each
          // other — rollup warns "Circular chunk", and a circular chunk pair is
          // an initialisation-order bug waiting for the wrong load order.
          return 'vendor';
        },
      },
    },
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
