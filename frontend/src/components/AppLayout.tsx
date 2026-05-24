import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Tooltip, Avatar, Dropdown, Button, Space } from 'antd'
import {
  GlobalOutlined,
  FolderOutlined,
  FileOutlined,
  TeamOutlined,
  BankOutlined,
  RobotOutlined,
  AppstoreOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useAppStore } from '@/app/store'

const { Header, Sider, Content } = Layout

const NAV_ITEMS = [
  { key: '/', icon: <GlobalOutlined />, label: 'Map' },
  { key: '/projects', icon: <FolderOutlined />, label: 'Projects' },
  { key: '/documents', icon: <FileOutlined />, label: 'Documents' },
  { key: '/ai-chat', icon: <RobotOutlined />, label: 'AI Assistant' },
]

const ADMIN_NAV_ITEMS = [
  { key: '/users', icon: <TeamOutlined />, label: 'Users' },
  { key: '/organisations', icon: <BankOutlined />, label: 'Organisations' },
  { key: '/basemaps', icon: <AppstoreOutlined />, label: 'Basemaps' },
]

const ADMIN_ROLES = ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN']

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { user, setUser } = useAppStore()

  const isAdmin = user && ADMIN_ROLES.includes(user.role)

  function handleLogout() {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    setUser(null)
    navigate('/login')
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
        key: 'logout',
        icon: <LogoutOutlined />,
        label: 'Sign Out',
        onClick: handleLogout,
      },
    ],
  }

  const navItems = [
    ...NAV_ITEMS,
    ...(isAdmin ? [{ type: 'divider' as const }, ...ADMIN_NAV_ITEMS] : []),
  ]

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      {/* Top header bar */}
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          height: 48,
          lineHeight: '48px',
          background: '#0a0a1a',
          borderBottom: '1px solid #1f1f3a',
          zIndex: 100,
          flex: 'none',
        }}
      >
        <Space size={12}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{ color: '#aaa' }}
          />
          <span
            style={{
              color: '#4fc3f7',
              fontWeight: 700,
              fontSize: 16,
              letterSpacing: 1,
              cursor: 'pointer',
            }}
            onClick={() => navigate('/')}
          >
            RakshaGIS
          </span>
          <span style={{ color: '#555', fontSize: 11 }}>
            {user?.organisation_name || 'DGDE'}
          </span>
        </Space>
        <Space size={12}>
          {user && (
            <span
              style={{
                background: '#1a2a3a',
                color: '#4fc3f7',
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 2,
                fontWeight: 600,
              }}
            >
              {user.role}
            </span>
          )}
          <Tooltip title="Settings">
            <Button type="text" icon={<SettingOutlined />} style={{ color: '#aaa' }} />
          </Tooltip>
          <Dropdown menu={userMenu} placement="bottomRight">
            <Avatar
              size={30}
              style={{ background: '#1565c0', cursor: 'pointer', fontSize: 13 }}
              icon={<UserOutlined />}
            />
          </Dropdown>
        </Space>
      </Header>

      <Layout style={{ flex: 1, overflow: 'hidden' }}>
        {/* Left sidebar */}
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          width={220}
          collapsedWidth={52}
          style={{
            background: '#0e0e1e',
            borderRight: '1px solid #1a1a2e',
            overflow: 'auto',
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={[location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`]}
            style={{ background: 'transparent', border: 'none', marginTop: 8 }}
            items={navItems as any}
            onClick={({ key }) => navigate(key)}
          />
        </Sider>

        {/* Main content */}
        <Content style={{ overflow: 'hidden', position: 'relative' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
