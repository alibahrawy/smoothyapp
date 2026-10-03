import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    // Distribution builds inject the service URL. Source builds use their own service.
    define: {
      __SMOOTHY_STOCK_SERVICE_URL__: JSON.stringify(process.env.SMOOTHY_STOCK_SERVICE_URL || '')
    },
    build: {
      rollupOptions: {
        external: ['ws', '@fugood/whisper.node', /^@fugood\/node-whisper-.*/]
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
})
