import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import { resolve } from 'path'

// Lightweight replacement for vite-plugin-cesium used when Cesium assets are
// already cached in staticfiles/cesium/ (SKIP_CESIUM_COPY=1 from build.sh).
// Transforms imports at source level so Rollup never touches the cesium bundle.
function cesiumSkipCopyPlugin(): Plugin {
  return {
    name: 'cesium-skip-copy',
    enforce: 'pre',
    // Stub out any direct cesium module/asset imports that survive the transform
    resolveId(id) {
      if (id === 'cesium' || id.startsWith('cesium/')) return '\0cesium-stub'
    },
    load(id) {
      if (id === '\0cesium-stub') return ''
    },
    // Replace import statements before Rollup resolves them
    transform(code, id) {
      if (id.startsWith('\0') || id.includes('node_modules')) return null
      if (!code.includes('cesium')) return null
      let out = code
      // import * as Cesium from 'cesium'  →  const Cesium = window.Cesium
      out = out.replace(
        /import\s*\*\s*as\s+(\w+)\s+from\s+['"]cesium['"]\s*;?/g,
        'const $1 = window.Cesium;',
      )
      // import 'cesium/Build/...'  (side-effect CSS/asset imports)
      out = out.replace(/import\s+['"]cesium\/[^'"]+['"]\s*;?/g, '')
      return out === code ? null : { code: out, map: null }
    },
    // Inject CESIUM_BASE_URL + Cesium.js script + widgets CSS into the HTML
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          injectTo: 'head' as const,
          children: "window.CESIUM_BASE_URL = '/static/cesium/';",
        },
        {
          tag: 'link',
          attrs: { rel: 'stylesheet', href: '/static/cesium/Widgets/widgets.css' },
          injectTo: 'head' as const,
        },
        {
          tag: 'script',
          attrs: { src: '/static/cesium/Cesium.js' },
          injectTo: 'head' as const,
        },
      ]
    },
  }
}

const skipCesium = process.env.SKIP_CESIUM_COPY === '1'

export default defineConfig({
  plugins: [react(), skipCesium ? cesiumSkipCopyPlugin() : cesium()],
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
    reportCompressedSize: false,
    sourcemap: false,
    // esnext target: skip legacy-syntax down-compilation, saves a few seconds
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // cesium chunk only when vite-plugin-cesium is active (skipCesium=false)
          if (!skipCesium && id.includes('node_modules/cesium')) return 'cesium'
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
