import { defineConfig, loadEnv } from 'electron-vite'

export default defineConfig(({ mode }) => {
  // Distribution builds inject the service URL / provider key from the environment
  // or a local (gitignored) .env file. Source builds stay credential-free.
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const stockServiceUrl = process.env.SMOOTHY_STOCK_SERVICE_URL || fileEnv.SMOOTHY_STOCK_SERVICE_URL || ''
  const pixabayApiKey = process.env.SMOOTHY_PIXABAY_API_KEY || fileEnv.SMOOTHY_PIXABAY_API_KEY || ''
  return {
    main: {
      define: {
        __SMOOTHY_STOCK_SERVICE_URL__: JSON.stringify(stockServiceUrl),
        __SMOOTHY_PIXABAY_API_KEY__: JSON.stringify(pixabayApiKey)
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
  }
})
