import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { useAppStore } from './store'
import LoginPage from '@/features/auth/LoginPage'
import AppLayout from '@/components/AppLayout'

const MapPage = lazy(() => import('@/features/map/MapPage'))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage'))
const ProjectDetailPage = lazy(() => import('@/features/projects/ProjectDetailPage'))
const DocumentsPage = lazy(() => import('@/features/documents/DocumentsPage'))
const UsersPage = lazy(() => import('@/features/users/UsersPage'))
const OrganisationsPage = lazy(() => import('@/features/organisations/OrganisationsPage'))
const AIChatPage = lazy(() => import('@/features/ai-chat/AIChatPage'))
const BasemapsPage = lazy(() => import('@/features/basemaps/BasemapsPage'))

function RequireAuth({ children }: { children: React.ReactNode }) {
  const user = useAppStore((s) => s.user)
  return user ? <>{children}</> : <Navigate to="/login" replace />
}

const Loading = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
    <Spin size="large" />
  </div>
)

export default function AppRoutes() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<MapPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="organisations" element={<OrganisationsPage />} />
          <Route path="ai-chat" element={<AIChatPage />} />
          <Route path="basemaps" element={<BasemapsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
