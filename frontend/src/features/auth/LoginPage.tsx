import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Card, Typography, Alert, Space } from 'antd'
import { UserOutlined, LockOutlined, GlobalOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useAppStore } from '@/app/store'
import { qk } from '@/services/queryKeys'
import api from '@/services/api'
import type { User } from '@/types'

interface LoginForm {
  username: string
  password: string
}

export default function LoginPage() {
  const navigate = useNavigate()
  const setUser = useAppStore((s) => s.setUser)
  const qc = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (values: LoginForm) => {
      const { data } = await axios.post('/api/auth/token/', values)
      localStorage.setItem('access_token', data.access)
      localStorage.setItem('refresh_token', data.refresh)
      const me: User = await api.get('/accounts/users/me/').then((r) => r.data)
      return me
    },
    onSuccess: (user) => {
      setUser(user)
      qc.setQueryData(qk.me(), user)
      navigate('/')
    },
  })

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0a0a1a 0%, #0d1b2a 100%)',
      }}
    >
      <Card
        style={{
          width: 380,
          background: '#0e0e1e',
          border: '1px solid #1a1a2e',
          borderRadius: 8,
        }}
        bodyStyle={{ padding: 32 }}
      >
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <GlobalOutlined style={{ fontSize: 40, color: '#4fc3f7', marginBottom: 12 }} />
            <Typography.Title level={3} style={{ color: '#e8e8e8', margin: 0 }}>
              RakshaGIS
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              DGDE — Defence Estates GIS Platform
            </Typography.Text>
          </div>

          {mutation.isError && (
            <Alert
              type="error"
              message="Invalid username or password"
              showIcon
            />
          )}

          <Form layout="vertical" onFinish={mutation.mutate} size="large">
            <Form.Item
              name="username"
              rules={[{ required: true, message: 'Enter your username' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: '#555' }} />}
                placeholder="Username"
                autoComplete="username"
              />
            </Form.Item>
            <Form.Item
              name="password"
              rules={[{ required: true, message: 'Enter your password' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#555' }} />}
                placeholder="Password"
                autoComplete="current-password"
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={mutation.isPending}
                style={{ height: 44, fontWeight: 600 }}
              >
                Sign In
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  )
}
