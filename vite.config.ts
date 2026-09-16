import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'development-csp',
    transformIndexHtml(html) {
      return command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html;
    }
  }],
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { host: '127.0.0.1', strictPort: true }
}));
