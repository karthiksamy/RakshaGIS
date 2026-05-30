import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, App as AntApp } from 'antd'
import App from './App'
import { ThemeProvider, useTheme } from './context/ThemeContext'
import { BrandingProvider } from './context/BrandingContext'
import './index.css'
import './i18n'  // initialise i18next before any component uses useTranslation

import { useTranslation } from 'react-i18next'
import enUS from 'antd/locale/en_US'
import hiIN from 'antd/locale/hi_IN'
import type { Locale } from 'antd/lib/locale'

const ANTD_LOCALE_MAP: Record<string, Locale> = {
  hi: hiIN,
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
})

function ThemedApp() {
  const { theme } = useTheme()
  const { i18n } = useTranslation()
  const antdLocale: Locale = ANTD_LOCALE_MAP[i18n.language] ?? enUS

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: theme.algorithm,
        token: {
          borderRadius: 4,
          fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
          ...theme.token,
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrandingProvider>
            <ThemedApp />
          </BrandingProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
)
