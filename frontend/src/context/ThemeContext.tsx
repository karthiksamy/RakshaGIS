import React, { createContext, useContext, useState, useCallback } from 'react'
import { theme as antTheme } from 'antd'
import type { ThemeConfig } from 'antd'

export type ThemeKey =
  | 'dark'
  | 'light'
  | 'navy'
  | 'forest'
  | 'midnight'
  | 'saffron'

export interface ThemeDefinition {
  key: ThemeKey
  label: string
  algorithm: typeof antTheme.darkAlgorithm | typeof antTheme.defaultAlgorithm
  token: ThemeConfig['token']
  // CSS variables written to :root for non-AntD surfaces
  cssVars: Record<string, string>
}

export const THEMES: Record<ThemeKey, ThemeDefinition> = {
  dark: {
    key: 'dark',
    label: 'Dark (Default)',
    algorithm: antTheme.darkAlgorithm,
    token: { colorPrimary: '#1890ff', borderRadius: 4 },
    cssVars: {
      '--bg-base': '#0a0a1a',
      '--bg-card': '#0e0e1e',
      '--bg-surface': '#0e1a2e',
      '--border-color': '#1a1a2e',
      '--text-primary': '#e8e8e8',
      '--text-secondary': '#aaaaaa',
      '--accent': '#4fc3f7',
    },
  },
  light: {
    key: 'light',
    label: 'Light',
    algorithm: antTheme.defaultAlgorithm,
    token: { colorPrimary: '#1890ff', borderRadius: 4 },
    cssVars: {
      '--bg-base': '#f0f2f5',
      '--bg-card': '#ffffff',
      '--bg-surface': '#fafafa',
      '--border-color': '#d9d9d9',
      '--text-primary': '#1a1a1a',
      '--text-secondary': '#666666',
      '--accent': '#1890ff',
    },
  },
  navy: {
    key: 'navy',
    label: 'Navy Blue',
    algorithm: antTheme.darkAlgorithm,
    token: { colorPrimary: '#4096ff', borderRadius: 4,
      colorBgBase: '#0d1b3e', colorBgContainer: '#112244' },
    cssVars: {
      '--bg-base': '#0d1b3e',
      '--bg-card': '#112244',
      '--bg-surface': '#1a2d55',
      '--border-color': '#1e3a6e',
      '--text-primary': '#e0eaff',
      '--text-secondary': '#8aa8d0',
      '--accent': '#4096ff',
    },
  },
  forest: {
    key: 'forest',
    label: 'Forest Green',
    algorithm: antTheme.darkAlgorithm,
    token: { colorPrimary: '#52c41a', borderRadius: 4,
      colorBgBase: '#0a1a0d', colorBgContainer: '#0f2214' },
    cssVars: {
      '--bg-base': '#0a1a0d',
      '--bg-card': '#0f2214',
      '--bg-surface': '#162e1c',
      '--border-color': '#1a3d22',
      '--text-primary': '#d4f0d8',
      '--text-secondary': '#7ab88a',
      '--accent': '#73d13d',
    },
  },
  midnight: {
    key: 'midnight',
    label: 'Midnight Purple',
    algorithm: antTheme.darkAlgorithm,
    token: { colorPrimary: '#9b59b6', borderRadius: 4,
      colorBgBase: '#12011e', colorBgContainer: '#1a0a2e' },
    cssVars: {
      '--bg-base': '#12011e',
      '--bg-card': '#1a0a2e',
      '--bg-surface': '#22103a',
      '--border-color': '#2d1050',
      '--text-primary': '#e8d8ff',
      '--text-secondary': '#9d7bbf',
      '--accent': '#b37feb',
    },
  },
  saffron: {
    key: 'saffron',
    label: 'Saffron (DGDE)',
    algorithm: antTheme.darkAlgorithm,
    token: { colorPrimary: '#fa8c16', borderRadius: 4,
      colorBgBase: '#1a0f00', colorBgContainer: '#241500' },
    cssVars: {
      '--bg-base': '#1a0f00',
      '--bg-card': '#241500',
      '--bg-surface': '#2e1c00',
      '--border-color': '#3d2500',
      '--text-primary': '#fff1d0',
      '--text-secondary': '#bf8840',
      '--accent': '#ffa940',
    },
  },
}

function applyCssVars(vars: Record<string, string>) {
  const root = document.documentElement
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v))
}

interface ThemeContextValue {
  themeKey: ThemeKey
  theme: ThemeDefinition
  setTheme: (key: ThemeKey) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  themeKey: 'dark',
  theme: THEMES.dark,
  setTheme: () => {},
})

const STORAGE_KEY = 'rakshagis-theme'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeKey, setThemeKey] = useState<ThemeKey>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeKey | null
    return saved && THEMES[saved] ? saved : 'dark'
  })

  const setTheme = useCallback((key: ThemeKey) => {
    setThemeKey(key)
    localStorage.setItem(STORAGE_KEY, key)
    applyCssVars(THEMES[key].cssVars)
  }, [])

  // Apply CSS vars on first render
  React.useEffect(() => {
    applyCssVars(THEMES[themeKey].cssVars)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ThemeContext.Provider value={{ themeKey, theme: THEMES[themeKey], setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
