import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const clientEntry = (name: string) => fileURLToPath(new URL(`../src/plugins/${name}/client/index.ts`, import.meta.url));

// Development-only bridge: plugin clients are built as separate entries in
// production; Vite serves their sources through the same stable URL.
function devPluginClients(): Plugin {
  return {
    name: 'imbrex-dev-plugin-clients',
    configureServer(server) {
      server.middlewares.use('/admin/plugins', (request, response, next) => {
        const match = /^\/([a-z][a-z0-9_-]{0,63})\/entry\.js(?:\?.*)?$/.exec(request.url ?? '');
        if (!match) { next(); return; }
        const entry = fileURLToPath(new URL(`../src/plugins/${match[1]}/client/index.ts`, import.meta.url));
        response.statusCode = 302;
        response.setHeader('location', '/admin/@fs/' + entry);
        response.end();
      });
    },
  };
}

export default defineConfig({
  root,
  base: '/admin/',
  plugins: [vue(), tailwindcss(), devPluginClients()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Plugin entries are imported by the shell at runtime, so their per-chunk
    // CSS would never be injected. Ship one stylesheet with the shell.
    cssCodeSplit: false,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        'plugin-admin': clientEntry('admin'),
        'plugin-api-rest': clientEntry('api-rest'),
        'plugin-onebot-v11': clientEntry('onebot-v11'),
        'plugin-agent-chat': clientEntry('agent-chat'),
      },
      output: {
        entryFileNames: (chunk) => chunk.name.startsWith('plugin-')
          ? `plugins/${chunk.name.slice('plugin-'.length)}/entry.js`
          : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    fs: {
      allow: [repository],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        configure(proxy) {
          // 仅本地开发：admin 要求 Origin 等于实际监听 origin。
          proxy.on('proxyReq', (request) => {
            request.setHeader('origin', 'http://127.0.0.1:8080');
          });
        },
      },
    },
  },
});
