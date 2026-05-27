import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, App as AntApp } from 'antd'
import App from './App'
import { ThemeProvider, useTheme } from './context/ThemeContext'
import { BrandingProvider } from './context/BrandingContext'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
})

function ThemedApp() {
  const { theme } = useTheme()
  return (
    <ConfigProvider
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
