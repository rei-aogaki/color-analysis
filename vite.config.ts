import { defineConfig } from 'vite';

// The preview is local only. Relative assets also work under a Pages project path.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [{
    name: 'local-development-csp',
    transformIndexHtml(html, context) {
      // Vite HMR injects styles and opens a local WebSocket. Production keeps the strict policy.
      return context.server ? html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '') : html;
    },
  }],
  build: {
    target: 'es2022', sourcemap: false,
    rolldownOptions: { input: mode === 'pages' ? 'index.html' : { main: 'index.html', design: 'design.html' } },
  },
  worker: { format: 'es' },
}));
