import React, { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Spin } from 'antd'
import { useAppStore } from './store'
import LoginPage from '@/features/auth/LoginPage'
import AppLayout from '@/components/AppLayout'

const DashboardPage = lazy(() => import('@/features/dashboard/DashboardPage'))
const MapPage = lazy(() => import('@/features/map/MapPage'))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage'))
const ProjectDetailPage = lazy(() => import('@/features/projects/ProjectDetailPage'))
const VersionComparePage = lazy(() => import('@/features/projects/VersionComparePage'))
const GanttPage = lazy(() => import('@/features/projects/GanttPage'))
const DocumentsPage = lazy(() => import('@/features/documents/DocumentsPage'))
const UsersPage = lazy(() => import('@/features/users/UsersPage'))
const OrganisationsPage = lazy(() => import('@/features/organisations/OrganisationsPage'))
const AIChatPage = lazy(() => import('@/features/ai-chat/AIChatPage'))
const BasemapsPage = lazy(() => import('@/features/basemaps/BasemapsPage'))
const ReportsPage = lazy(() => import('@/features/reports/ReportsPage'))
const AuditLogPage = lazy(() => import('@/features/audit/AuditLogPage'))
const StateMasterPage = lazy(() => import('@/features/master/StateMasterPage'))
const DistrictMasterPage = lazy(() => import('@/features/master/DistrictMasterPage'))
const TalukMasterPage = lazy(() => import('@/features/master/TalukMasterPage'))
const VillageMasterPage = lazy(() => import('@/features/master/VillageMasterPage'))
const BoundaryImportPage = lazy(() => import('@/features/master/BoundaryImportPage'))
const TerrainPage = lazy(() => import('@/features/terrain/TerrainPage'))
const BoundaryExtractionPage = lazy(() => import('@/features/ai-vision/BoundaryExtractionPage'))
const BackupPage = lazy(() => import('@/features/backups/BackupPage'))
const BrandingSettingsPage   = lazy(() => import('@/features/settings/BrandingSettingsPage'))
const QGISSyncPage           = lazy(() => import('@/features/qgis-sync/QGISSyncPage'))
const AIConfigPage           = lazy(() => import('@/features/ai-config/AIConfigPage'))
const ExternalDatabasePage   = lazy(() => import('@/features/admin/ExternalDatabasePage'))
const AccessRequestsPage = lazy(() => import('@/features/projects/AccessRequestsPage'))

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
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="map" element={<MapPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="projects/:id/compare" element={<VersionComparePage />} />
          <Route path="projects/:id/gantt" element={<GanttPage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="access-requests" element={<AccessRequestsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="organisations" element={<OrganisationsPage />} />
          <Route path="ai-chat" element={<AIChatPage />} />
          <Route path="basemaps" element={<BasemapsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="master/states" element={<StateMasterPage />} />
          <Route path="master/districts" element={<DistrictMasterPage />} />
          <Route path="master/taluks" element={<TalukMasterPage />} />
          <Route path="master/villages" element={<VillageMasterPage />} />
          <Route path="master/boundary-import" element={<BoundaryImportPage />} />
          <Route path="terrain" element={<TerrainPage />} />
          <Route path="ai-vision" element={<BoundaryExtractionPage />} />
          <Route path="backups" element={<BackupPage />} />
          <Route path="settings/branding"      element={<BrandingSettingsPage />} />
          <Route path="settings/ai-config"     element={<AIConfigPage />} />
          <Route path="settings/external-data" element={<ExternalDatabasePage />} />
          <Route path="qgis-sync" element={<QGISSyncPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
