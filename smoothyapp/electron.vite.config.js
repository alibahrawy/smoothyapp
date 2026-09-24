import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
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
