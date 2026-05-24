import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Spin } from 'antd'
import AppRoutes from './app/routes'
import { useAppStore } from './app/store'
import api from './services/api'
import { qk } from './services/queryKeys'
import type { User } from './types'

export default function App() {
  const setUser = useAppStore((s) => s.setUser)

  const hasToken = !!localStorage.getItem('access_token')

  const { data, isLoading } = useQuery<User>({
    queryKey: qk.me(),
    queryFn: () => api.get('/accounts/users/me/').then((r) => r.data),
    enabled: hasToken,
    retry: false,
  })

  useEffect(() => {
    if (data) setUser(data)
  }, [data, setUser])

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" tip="Loading RakshaGIS..." />
      </div>
    )
  }

  return <AppRoutes />
}
