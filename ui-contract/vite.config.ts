import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const pluginsDir = new URL('../src/plugins/', import.meta.url);

/** 每个自带浏览器入口的插件，靠扫描发现，永不枚举。 */
const pluginModules = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(new URL(name + '/client/index.ts', pluginsDir)))
  .sort();

const clientEntry = (name: string) =>
  fileURLToPath(new URL(`../src/plugins/${name}/client/index.ts`, import.meta.url));

// 仅开发期：生产里插件客户端是独立入口，Vite 开发期通过同一 URL 提供源码。
function devPluginClients(): Plugin {
  return {
    name: 'imbrex-dev-plugin-clients',
    configureServer(server) {
      server.middlewares.use('/admin/plugins', (request, response, next) => {
        const match = /^\/([a-z][a-z0-9_-]{0,63})\/entry\.js(?:\?.*)?$/.exec(request.url ?? '');
        if (!match || !pluginModules.includes(match[1]!)) { next(); return; }
        response.statusCode = 302;
        response.setHeader('location', '/admin/@fs/' + clientEntry(match[1]!));
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
    // 插件入口由 Shell 在运行时裸 import()，按分块拆分的 CSS 永远不会被注入，
    // 所以 Shell 与全部插件视图共用一张样式表。
    cssCodeSplit: false,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: Object.fromEntries([
        ['index', fileURLToPath(new URL('index.html', import.meta.url))],
        ...pluginModules.map((name) => ['plugin-' + name, clientEntry(name)]),
      ]),
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
    fs: { allow: [repository] },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => {
            request.setHeader('origin', 'http://127.0.0.1:8080');
          });
        },
      },
    },
  },
});
