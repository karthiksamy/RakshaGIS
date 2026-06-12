import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  Layout, Menu, Tooltip, Avatar, Dropdown, Button, Space, Modal, Form, Input,
  message, Badge, Drawer, List, Typography, Empty, AutoComplete, Descriptions, Tag,
} from 'antd'
import {
  GlobalOutlined, FolderOutlined, FileOutlined, TeamOutlined, BankOutlined,
  RobotOutlined, AppstoreOutlined, UserOutlined, LogoutOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined, DatabaseOutlined, KeyOutlined,
  BellOutlined, DashboardOutlined, BarChartOutlined, AuditOutlined, ApartmentOutlined,
  CheckCircleOutlined, SearchOutlined, BgColorsOutlined, EyeOutlined, EnvironmentOutlined,
  ShareAltOutlined, ImportOutlined, CompassOutlined, SafetyOutlined, CloudServerOutlined,
  SafetyCertificateOutlined, ClockCircleOutlined, WarningOutlined, BookOutlined, ToolOutlined,
} from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/app/store'
import api from '@/services/api'
import { useTheme, THEMES, type ThemeKey } from '@/context/ThemeContext'
import { useBranding } from '@/context/BrandingContext'
import { sha512hex } from '@/utils/crypto'
import LanguageSwitcher from './LanguageSwitcher'

const { Text } = Typography
const { Header, Sider, Content } = Layout

const NAV_ITEMS = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
  { key: '/drilldown', icon: <ApartmentOutlined />, label: 'Office Drilldown' },
  { key: '/map', icon: <GlobalOutlined />, label: 'Map' },
  { key: '/terrain', icon: <CompassOutlined />, label: '3D Terrain' },
  { key: '/drone', icon: <CloudServerOutlined />, label: 'Drone Survey' },
  { key: '/field', icon: <EnvironmentOutlined />, label: 'Field Companion' },
  { key: '/encroachments', icon: <WarningOutlined />, label: 'Encroachments' },
  { key: '/field-diary', icon: <BookOutlined />, label: 'Field Diary (DPR)' },
  { key: '/equipment', icon: <ToolOutlined />, label: 'Equipment Register' },
  { key: '/projects', icon: <FolderOutlined />, label: 'Projects' },
  { key: '/documents', icon: <FileOutlined />, label: 'Documents' },
  { key: '/basemaps', icon: <AppstoreOutlined />, label: 'Basemaps' },
  { key: '/access-requests', icon: <ShareAltOutlined />, label: 'Data Access' },
  { key: '/ai-chat', icon: <RobotOutlined />, label: 'AI Assistant' },
  { key: '/ai-vision', icon: <EyeOutlined />, label: 'AI Vision' },
]

const ADMIN_NAV_ITEMS = [
  { key: '/users', icon: <TeamOutlined />, label: 'Users' },
  { key: '/organisations', icon: <BankOutlined />, label: 'Organisations' },
  { key: '/reports', icon: <BarChartOutlined />, label: 'Reports' },
  { key: '/sla', icon: <ClockCircleOutlined />, label: 'SLA Tracker' },
  { key: '/audit', icon: <AuditOutlined />, label: 'Audit Logs' },
  { key: '/backups', icon: <SafetyOutlined />, label: 'Backups' },
  { key: '/qgis-sync', icon: <CheckCircleOutlined />, label: 'QGIS Sync' },
  { key: '/verify', icon: <SafetyCertificateOutlined />, label: 'Verify Provenance' },
]

const MASTER_NAV_ITEMS = [
  { key: '/master/states', icon: <DatabaseOutlined />, label: 'States' },
  { key: '/master/districts', icon: <DatabaseOutlined />, label: 'Districts' },
  { key: '/master/taluks', icon: <DatabaseOutlined />, label: 'Taluks' },
  { key: '/master/villages', icon: <DatabaseOutlined />, label: 'Villages' },
  { key: '/master/boundary-import', icon: <ImportOutlined />, label: 'Boundary Import' },
]

const SETTINGS_NAV_ITEMS = [
  { key: '/settings/branding',       icon: <BgColorsOutlined />,    label: 'Branding'           },
  { key: '/settings/ai-config',      icon: <RobotOutlined />,       label: 'AI Config'          },
  { key: '/settings/external-data',  icon: <CloudServerOutlined />, label: 'External Data'      },
  { key: '/settings/security',       icon: <SafetyOutlined />,      label: 'Security / 2FA'     },
]

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const [pwdModalOpen, setPwdModalOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [searchOpts, setSearchOpts] = useState<{ value: string; label: React.ReactNode }[]>([])
  const [searchAreaMap, setSearchAreaMap] = useState<Record<string, any>>({})
  const [areaViewModal, setAreaViewModal] = useState<any | null>(null)
  const [pwdForm] = Form.useForm()
  const navigate = useNavigate()
  const location = useLocation()
  const { user, setUser } = useAppStore()
  const qc = useQueryClient()
  const { themeKey, setTheme } = useTheme()
  const branding = useBranding()
  const { t } = useTranslation()

  // Derive if we are on a light (non-dark) theme for text contrast
  const isLight = themeKey === 'light'
  const bgBase = `var(--bg-base)`
  const bgCard = `var(--bg-card)`
  const bgSurface = `var(--bg-surface)`
  const borderColor = `var(--border-color)`
  const textPrimary = `var(--text-primary)`
  const textSecondary = `var(--text-secondary)`
  const accent = `var(--accent)`

  const { data: unreadData } = useQuery<{ unread: number }>({
    queryKey: ['notif-unread'],
    queryFn: () => api.get('/workflow/notifications/unread_count/').then(r => r.data),
    refetchInterval: 30_000,
  })
  const unread = unreadData?.unread ?? 0

  const isAdmin = user && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)
  const { data: pendingAccessData } = useQuery<any[]>({
    queryKey: ['access-requests', { direction: 'incoming', status: 'PENDING' }],
    queryFn: () =>
      api.get('/projects/access-requests/?direction=incoming&status=PENDING').then((r) => r.data),
    enabled: !!isAdmin,
    refetchInterval: 60_000,
  })
  const pendingAccessCount = pendingAccessData?.length ?? 0

  const { data: notifsData } = useQuery<{ results: any[] }>({
    queryKey: ['notifications', notifOpen],
    queryFn: () => api.get('/workflow/notifications/?is_read=false&page_size=20').then(r => r.data),
    enabled: notifOpen,
  })

  async function handleSearch(q: string) {
    if (q.length < 2) { setSearchOpts([]); return }
    const res = await api.get(`/dashboard/search/?q=${encodeURIComponent(q)}`).then(r => r.data)
    const opts: { value: string; label: React.ReactNode }[] = []
    res.projects?.forEach((p: any) => opts.push({
      value: `/projects/${p.id}`,
      label: (
        <div>
          <Text style={{ color: accent, fontSize: 12 }}>{p.project_number}</Text>{' '}
          <Text style={{ fontSize: 12 }}>{p.name}</Text>
        </div>
      ),
    }))
    res.survey_areas?.forEach((a: any) => opts.push({
      value: `__area__${a.id}`,
      label: (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <EnvironmentOutlined style={{ color: '#52c41a', marginRight: 4, fontSize: 11 }} />
            <Text style={{ fontSize: 12 }}>{a.name}</Text>
            {a.area_code && <Text style={{ fontSize: 10, color: textSecondary, marginLeft: 4 }}>({a.area_code})</Text>}
            <Text style={{ fontSize: 10, color: textSecondary, marginLeft: 4 }}>— {a.project_number}</Text>
          </div>
          <EyeOutlined style={{ color: '#1890ff', fontSize: 12 }} />
        </div>
      ),
    }))
    res.features?.forEach((f: any) => opts.push({
      value: `/projects/${f.project_id}`,
      label: (
        <div>
          <Text style={{ fontSize: 11, color: textSecondary }}>Feature:</Text>{' '}
          <Text style={{ fontSize: 12 }}>{f.feature_id || f.layer_name}</Text>
        </div>
      ),
    }))
    res.users?.forEach((u: any) => opts.push({
      value: `/users`,
      label: (
        <div>
          <Text style={{ fontSize: 11, color: textSecondary }}>User:</Text>{' '}
          <Text style={{ fontSize: 12 }}>{u.full_name || u.username}</Text>
        </div>
      ),
    }))
    const areaMap: Record<string, any> = {}
    ;(res.survey_areas ?? []).forEach((a: any) => { areaMap[`__area__${a.id}`] = a })
    setSearchAreaMap(areaMap)
    setSearchOpts(opts)
  }

  function markAllRead() {
    api.post('/workflow/notifications/mark_all_read/').then(() => {
      qc.invalidateQueries({ queryKey: ['notif-unread'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
    })
  }

  const isSuperAdmin = user?.role === 'SUPERADMIN'

  // Which main-nav keys each role group needs
  const FIELD_NAV_KEYS  = new Set(['/dashboard', '/map', '/projects', '/field', '/ai-chat', '/documents'])
  const REVIEW_NAV_KEYS = new Set(['/dashboard', '/map', '/projects', '/ai-chat', '/documents', '/ai-vision'])
  const VIEWER_NAV_KEYS = new Set(['/dashboard', '/drilldown', '/map'])

  const isFieldUser  = user?.role === 'SDO' || user?.role === 'SURVEYOR'
  const isReviewer   = user?.role === 'CHECKER' || user?.role === 'APPROVER'
  const isViewerOnly = user?.role === 'VIEWER' || user?.role === 'PDDE_VIEWER'

  function handleLogout() {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    setUser(null)
    navigate('/login')
  }

  async function handleChangePassword(values: { old_password: string; new_password: string }) {
    try {
      const old_password_sha512 = await sha512hex(values.old_password)
      const new_password_sha512 = await sha512hex(values.new_password)
      await api.post('/accounts/users/change-my-password/', { old_password_sha512, new_password_sha512 })
      message.success('Password changed successfully')
      setPwdModalOpen(false)
      pwdForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Failed to change password')
    }
  }

  const themeMenu = {
    items: Object.values(THEMES).map((t) => ({
      key: t.key,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 12, height: 12, borderRadius: '50%',
              background: (t.token?.colorPrimary ?? '#1890ff') as string,
              border: t.key === themeKey ? '2px solid currentColor' : '2px solid transparent',
              display: 'inline-block',
            }}
          />
          {t.label}
          {t.key === themeKey && <CheckCircleOutlined style={{ color: '#52c41a', marginLeft: 'auto' }} />}
        </span>
      ),
      onClick: () => setTheme(t.key as ThemeKey),
    })),
  }

  const userMenu = {
    items: [
      {
        key: 'profile',
        icon: <UserOutlined />,
        label: user?.full_name || user?.username,
        disabled: true,
      },
      { type: 'divider' as const },
      {
        key: 'change-password',
        icon: <KeyOutlined />,
        label: 'Change Password',
        onClick: () => setPwdModalOpen(true),
      },
      { type: 'divider' as const },
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: 'Sign Out',
        onClick: handleLogout,
        danger: true,
      },
    ],
  }

  // Translated nav items (re-computed when language changes)
  const translatedNavItems = NAV_ITEMS.map(item => ({ ...item, label: t(`nav.${item.key.slice(1).replace(/-/g,'_')}`, item.label) }))
  const translatedAdminItems = ADMIN_NAV_ITEMS.map(item => ({ ...item, label: t(`nav.${item.key.slice(1).replace(/-/g,'_')}`, item.label) }))
  const translatedMasterItems = MASTER_NAV_ITEMS.map(item => ({ ...item, label: t(`nav.${item.key.replace('/master/','').replace(/-/g,'_')}`, item.label) }))
  const translatedSettingsItems = SETTINGS_NAV_ITEMS.map(item => ({ ...item, label: t(`nav.${item.key.replace('/settings/','').replace(/-/g,'_')}`, item.label) }))

  // Filter nav items based on the logged-in user's role
  const roleFilteredNavItems = translatedNavItems.filter(item => {
    if (isFieldUser)  return FIELD_NAV_KEYS.has(item.key)
    if (isReviewer)   return REVIEW_NAV_KEYS.has(item.key)
    if (isViewerOnly) return VIEWER_NAV_KEYS.has(item.key)
    return true // admins and superadmin see everything
  })

  const navItemsWithBadgeTranslated = roleFilteredNavItems.map(item => {
    if (item.key === '/access-requests' && pendingAccessCount > 0) {
      return { ...item, label: <Badge count={pendingAccessCount} size="small" offset={[6, 0]}>{item.label}</Badge> }
    }
    return item
  })

  const navItems = [
    ...navItemsWithBadgeTranslated,
    ...(isAdmin ? [{ type: 'divider' as const }, ...translatedAdminItems] : []),
    ...(isSuperAdmin
      ? [
          { type: 'divider' as const },
          { key: 'master-header', label: t('nav.master_data', 'Master Data'), type: 'group', children: translatedMasterItems },
          { type: 'divider' as const },
          { key: 'settings-header', label: t('common.settings', 'Settings'), type: 'group', children: translatedSettingsItems },
        ]
      : []),
  ]

  const selectedKey = location.pathname.startsWith('/master/') || location.pathname.startsWith('/settings/')
    ? location.pathname
    : `/${location.pathname.split('/')[1]}`

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          height: 48,
          lineHeight: '48px',
          background: bgBase,
          borderBottom: `1px solid ${borderColor}`,
          zIndex: 100,
          flex: 'none',
        }}
      >
        <Space size={12}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{ color: textSecondary }}
          />
          <span
            style={{ color: accent, fontWeight: 700, fontSize: 16, letterSpacing: 1, cursor: 'pointer' }}
            onClick={() => navigate('/')}
          >
            {branding.app_title}
          </span>
          <span style={{ color: textSecondary, fontSize: 11 }}>{user?.organisation_name || 'DGDE'}</span>
        </Space>

        <Space size={8}>
          {/* Global search */}
          <AutoComplete
            options={searchOpts}
            onSearch={handleSearch}
            onSelect={(val: string) => {
              if (val.startsWith('__area__')) {
                const area = searchAreaMap[val]
                if (area) setAreaViewModal(area)
              } else {
                navigate(val)
              }
            }}
            style={{ width: 260 }}
            dropdownStyle={{ background: bgSurface, border: `1px solid ${borderColor}` }}
          >
            <Input
              size="small"
              placeholder="Search projects, features…"
              prefix={<SearchOutlined style={{ color: textSecondary }} />}
              style={{
                background: bgSurface,
                borderColor: borderColor,
                color: textPrimary,
              }}
            />
          </AutoComplete>

          {user && (
            <span
              style={{
                background: isLight ? '#e6f4ff' : '#1a2a3a',
                color: accent,
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 2,
                fontWeight: 600,
                border: `1px solid ${borderColor}`,
              }}
            >
              {user.role}
            </span>
          )}

          {/* Language switcher */}
          <LanguageSwitcher />

          {/* Theme switcher */}
          <Dropdown menu={themeMenu} placement="bottomRight" trigger={['click']}>
            <Tooltip title="Switch Theme">
              <Button type="text" icon={<BgColorsOutlined />} style={{ color: textSecondary }} />
            </Tooltip>
          </Dropdown>

          {/* Notifications bell */}
          <Tooltip title="Notifications">
            <Badge count={unread} size="small" offset={[-2, 2]}>
              <Button
                type="text"
                icon={<BellOutlined />}
                style={{ color: unread > 0 ? '#fa8c16' : textSecondary }}
                onClick={() => setNotifOpen(true)}
              />
            </Badge>
          </Tooltip>

          <Dropdown menu={userMenu} placement="bottomRight">
            <Avatar
              size={30}
              style={{ background: accent, cursor: 'pointer', fontSize: 13, color: isLight ? '#fff' : '#fff' }}
              icon={<UserOutlined />}
            />
          </Dropdown>
        </Space>
      </Header>

      <Layout style={{ flex: 1, overflow: 'hidden' }}>
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          width={220}
          collapsedWidth={52}
          style={{
            background: bgCard,
            borderRight: `1px solid ${borderColor}`,
            overflow: 'auto',
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            style={{ background: 'transparent', border: 'none', marginTop: 8 }}
            items={navItems as any}
            onClick={({ key }) => {
              if (key !== 'master-header') navigate(key)
            }}
          />
        </Sider>

        <Content style={{
          height: 'calc(100vh - 48px)',
          overflowY: 'auto',
          overflowX: 'hidden',
          position: 'relative',
        }}>
          <Outlet />
        </Content>
      </Layout>

      <Modal
        title="Change Password"
        open={pwdModalOpen}
        onCancel={() => { setPwdModalOpen(false); pwdForm.resetFields() }}
        onOk={() => pwdForm.submit()}
        okText="Change"
      >
        <Form form={pwdForm} layout="vertical" onFinish={handleChangePassword} style={{ marginTop: 16 }}>
          <Form.Item name="old_password" label="Current Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="New Password"
            rules={[{ required: true }, { min: 8, message: 'Minimum 8 characters' }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      {/* Notifications Drawer */}
      <Drawer
        title={
          <Space>
            <span>Notifications</span>
            {unread > 0 && (
              <Button size="small" type="link" onClick={markAllRead}>
                Mark all read
              </Button>
            )}
          </Space>
        }
        placement="right"
        width={360}
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        styles={{
          body: { padding: 0, background: bgSurface },
          header: { background: bgSurface, borderBottom: `1px solid ${borderColor}` },
          wrapper: { background: bgSurface },
        }}
      >
        {(!notifsData?.results || notifsData.results.length === 0) ? (
          <Empty description="No unread notifications" style={{ marginTop: 80 }} />
        ) : (
          <List
            dataSource={notifsData.results}
            renderItem={(notif: any) => (
              <List.Item
                style={{
                  padding: '12px 16px',
                  borderBottom: `1px solid ${borderColor}`,
                  cursor: notif.project ? 'pointer' : 'default',
                }}
                onClick={() => {
                  if (notif.project) {
                    navigate(`/projects/${notif.project}`)
                    setNotifOpen(false)
                  }
                  api.patch(`/workflow/notifications/${notif.id}/`, { is_read: true }).then(() => {
                    qc.invalidateQueries({ queryKey: ['notif-unread'] })
                    qc.invalidateQueries({ queryKey: ['notifications'] })
                  })
                }}
              >
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <Text strong style={{ color: textPrimary, fontSize: 13 }}>{notif.title}</Text>
                    <Text style={{ color: textSecondary, fontSize: 11 }}>
                      {new Date(notif.created_at).toLocaleDateString()}
                    </Text>
                  </div>
                  <Text style={{ color: textSecondary, fontSize: 12 }}>{notif.message}</Text>
                </div>
              </List.Item>
            )}
          />
        )}
      </Drawer>

      {/* Survey Area Attribute Modal (from global search) */}
      <Modal
        title={
          <Space>
            <EnvironmentOutlined style={{ color: '#52c41a' }} />
            <span>Survey Area — {areaViewModal?.name}</span>
          </Space>
        }
        open={!!areaViewModal}
        onCancel={() => setAreaViewModal(null)}
        footer={[
          <Button key="project" type="default" onClick={() => { navigate(`/projects/${areaViewModal?.project_id}`); setAreaViewModal(null) }}>
            Open Project
          </Button>,
          <Button key="close" onClick={() => setAreaViewModal(null)}>Close</Button>,
        ]}
        width={520}
      >
        {areaViewModal && (
          <Descriptions column={1} bordered size="small" style={{ marginTop: 12 }}>
            <Descriptions.Item label="Area Name">{areaViewModal.name}</Descriptions.Item>
            {areaViewModal.area_code && (
              <Descriptions.Item label="Area Code">
                <Tag style={{ fontFamily: 'monospace' }}>{areaViewModal.area_code}</Tag>
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Status">
              <Tag color={
                areaViewModal.status === 'APPROVED' ? 'green'
                  : areaViewModal.status === 'SUBMITTED' ? 'processing'
                  : areaViewModal.status === 'UNDER_REVIEW' ? 'warning'
                  : areaViewModal.status === 'PUBLISHED' ? 'success'
                  : areaViewModal.status === 'RETURNED' ? 'error'
                  : 'default'
              }>{areaViewModal.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Project">
              <Text style={{ color: accent }}>{areaViewModal.project_number}</Text>{' '}
              {areaViewModal.project_name}
            </Descriptions.Item>
            {areaViewModal.assigned_to && (
              <Descriptions.Item label="Assigned To">{areaViewModal.assigned_to}</Descriptions.Item>
            )}
            {areaViewModal.description && (
              <Descriptions.Item label="Description">{areaViewModal.description}</Descriptions.Item>
            )}
            <Descriptions.Item label="Created">
              {new Date(areaViewModal.created_at).toLocaleDateString()}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </Layout>
  )
}
