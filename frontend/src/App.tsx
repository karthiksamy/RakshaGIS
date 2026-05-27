import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Spin } from 'antd'
import AppRoutes from './app/routes'
import { useAppStore } from './app/store'
import api from './services/api'
import { qk } from './services/queryKeys'
import type { User } from './types'

export default function App() {
  const user = useAppStore((s) => s.user)
  const setUser = useAppStore((s) => s.setUser)

  const hasToken = !!localStorage.getItem('access_token')

  const { data, isLoading, isError } = useQuery<User>({
    queryKey: qk.me(),
    queryFn: () => api.get('/accounts/users/me/').then((r) => r.data),
    enabled: hasToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (data) setUser(data)
  }, [data, setUser])

  useEffect(() => {
    if (isError) {
      // Token is invalid/expired — clear it so RequireAuth redirects to login
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
      setUser(null)
    }
  }, [isError, setUser])

  // Show spinner while we're waiting to know the auth state:
  // - token exists but query hasn't resolved yet (isLoading)
  // - token exists, query succeeded, but store hasn't been updated yet (data set, user still null)
  if (hasToken && (isLoading || (data && !user))) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#050510' }}>
        <Spin size="large" tip="Loading RakshaGIS..." />
      </div>
    )
  }

  return <AppRoutes />
}
