import React, { createContext, useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'

export interface BrandingConfig {
  app_title: string
  app_subtitle: string
  login_tagline: string
  primary_color: string
  logo_url: string
}

const DEFAULTS: BrandingConfig = {
  app_title: 'RakshaGIS',
  app_subtitle: 'DGDE — Defence Estates GIS Platform',
  login_tagline: 'Precision mapping for Defence Estate management',
  primary_color: '#1890ff',
  logo_url: '',
}

const BrandingContext = createContext<BrandingConfig>(DEFAULTS)

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { data } = useQuery<BrandingConfig>({
    queryKey: ['branding'],
    queryFn: () => axios.get('/api/core/branding/').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  // Reflect the configured application title in the browser tab.
  React.useEffect(() => {
    if (data?.app_title) document.title = data.app_title
  }, [data?.app_title])

  return (
    <BrandingContext.Provider value={data ?? DEFAULTS}>
      {children}
    </BrandingContext.Provider>
  )
}

export function useBranding() {
  return useContext(BrandingContext)
}
