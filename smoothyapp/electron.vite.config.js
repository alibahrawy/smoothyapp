import { defineConfig } from 'electron-vite'

export default defineConfig(({ command }) => ({
  main: {
    // Distribution builds inject the service URL. Source builds use their own service;
    // `npm run dev` defaults to the official one so the dev app matches release behavior.
    define: {
      __SMOOTHY_STOCK_SERVICE_URL__: JSON.stringify(process.env.SMOOTHY_STOCK_SERVICE_URL || (command === 'serve' ? 'https://smoothyedit.com/api/stock/pixabay' : ''))
    },
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', 'assets-worker': 'src/main/assets-worker.ts' },
        external: ['unpdf', 'mammoth', 'ws', 'sharp', 'onnxruntime-node', '@fugood/whisper.node', /^@fugood\/node-whisper-.*/]
      }
    }
  },
  preload: {},
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 5174
    }
  }
}))
