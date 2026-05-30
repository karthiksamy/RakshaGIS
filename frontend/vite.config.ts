import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), cesium()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/tiles': { target: 'http://localhost:7800', changeOrigin: true },
      '/media': { target: 'http://localhost:8000', changeOrigin: true },
      '/terrain-tiles': { target: 'http://localhost:8765', changeOrigin: true },
    },
  },
  build: {
    outDir: '../staticfiles',
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/cesium')) return 'cesium'
          if (id.includes('node_modules/jspdf') || id.includes('node_modules/jspdf-autotable')) return 'pdf'
          if (id.includes('node_modules/xlsx')) return 'xlsx'
          if (id.includes('node_modules/ol/')) return 'ol'
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'react'
          if (id.includes('node_modules/antd/') || id.includes('node_modules/@ant-design/')) return 'antd'
          if (id.includes('node_modules/@turf/')) return 'turf'
          if (id.includes('node_modules/geotiff') || id.includes('node_modules/lerc') || id.includes('node_modules/zstd')) return 'geotiff'
        },
      },
    },
  },
  base: '/static/',
})
