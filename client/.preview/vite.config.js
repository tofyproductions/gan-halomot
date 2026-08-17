import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  server: { port: 5210 },
  resolve: {
    alias: [
      // The real components import '../../api/parentClient'. Point that at the
      // fixture instead, so nothing here can reach the live database.
      { find: /^\.\.\/\.\.\/api\/parentClient$/, replacement: `${__dirname}/mockParentClient.js` },
    ],
  },
});
