import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Typography, Alert, Space, Divider } from 'antd'
import {
  UserOutlined, LockOutlined, GlobalOutlined, SafetyCertificateOutlined,
  AimOutlined, TeamOutlined, DatabaseOutlined, BarChartOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { useAppStore } from '@/app/store'
import { qk } from '@/services/queryKeys'
import api from '@/services/api'
import { useBranding } from '@/context/BrandingContext'
import { useTranslation } from 'react-i18next'
import LanguageSwitcher from '@/components/LanguageSwitcher'
import type { User } from '@/types'

interface LoginForm {
  username: string
  password: string
}

const FEATURES = [
  {
    icon: <AimOutlined style={{ fontSize: 22, color: '#4fc3f7' }} />,
    title: 'Precision GIS Mapping',
    desc: 'Draw, edit and manage survey parcels with full PostGIS spatial analysis.',
  },
  {
    icon: <GlobalOutlined style={{ fontSize: 22, color: '#73d13d' }} />,
    title: 'Multi-layer Overlay',
    desc: 'Overlay drone GeoTIFFs, admin boundaries and vector layers in one view.',
  },
  {
    icon: <TeamOutlined style={{ fontSize: 22, color: '#ffa940' }} />,
    title: 'Multi-level Workflow',
    desc: 'SDO → Checker → Approver → DEO Admin approval chain with audit trail.',
  },
  {
    icon: <DatabaseOutlined style={{ fontSize: 22, color: '#b37feb' }} />,
    title: 'Offline AI Assistant',
    desc: 'Local LLM (Ollama) for document Q&A and feature analysis — no cloud dependency.',
  },
  {
    icon: <BarChartOutlined style={{ fontSize: 22, color: '#ff7875' }} />,
    title: 'Reports & Analytics',
    desc: 'Auto-generate encroachment reports, area summaries and export to PDF/CSV.',
  },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const setUser = useAppStore((s) => s.setUser)
  const qc = useQueryClient()
  const branding = useBranding()
  const { t } = useTranslation()

  const [step, setStep] = useState<'credentials' | '2fa'>('credentials')
  const [preAuthKey, setPreAuthKey] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [totpError, setTotpError] = useState('')
  const [totpLoading, setTotpLoading] = useState(false)

  const mutation = useMutation({
    mutationFn: async (values: LoginForm) => {
      const { data } = await axios.post('/api/accounts/auth/login/', values)
      if (data.requires_2fa) {
        setPreAuthKey(data.pre_auth_key)
        setStep('2fa')
        return null
      }
      localStorage.setItem('access_token', data.access)
      localStorage.setItem('refresh_token', data.refresh)
      const me: User = await api.get('/accounts/users/me/').then((r) => r.data)
      return me
    },
    onSuccess: (user) => {
      if (!user) return
      setUser(user)
      qc.setQueryData(qk.me(), user)
      navigate('/')
    },
  })

  async function handleTotpSubmit() {
    if (!totpCode || totpCode.length !== 6) {
      setTotpError('Enter the 6-digit code from your authenticator app')
      return
    }
    setTotpError('')
    setTotpLoading(true)
    try {
      const { data } = await axios.post('/api/accounts/auth/2fa/complete/', {
        pre_auth_key: preAuthKey,
        totp_code: totpCode,
      })
      localStorage.setItem('access_token', data.access)
      localStorage.setItem('refresh_token', data.refresh)
      const me: User = await api.get('/accounts/users/me/').then((r) => r.data)
      setUser(me)
      qc.setQueryData(qk.me(), me)
      navigate('/')
    } catch (e: any) {
      setTotpError(e?.response?.data?.detail || 'Invalid code. Please try again.')
    } finally {
      setTotpLoading(false)
    }
  }

  const primaryColor = branding.primary_color || '#1890ff'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Segoe UI', sans-serif" }}>
      {/* Left info panel */}
      <div
        style={{
          flex: 1,
          background: 'linear-gradient(160deg, #060d1f 0%, #0a1628 60%, #0d2040 100%)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '48px 56px',
          borderRight: '1px solid #1a2a4a',
          minWidth: 0,
        }}
        className="login-left-panel"
      >
        {/* Brand header */}
        <div style={{ marginBottom: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            {branding.logo_url ? (
              <img src={branding.logo_url} alt="logo" style={{ height: 48, width: 'auto' }} />
            ) : (
              <div
                style={{
                  width: 52, height: 52, borderRadius: 12,
                  background: `linear-gradient(135deg, ${primaryColor} 0%, #096dd9 100%)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <GlobalOutlined style={{ fontSize: 26, color: '#fff' }} />
              </div>
            )}
            <div>
              <Typography.Title level={2} style={{ color: '#fff', margin: 0, lineHeight: 1.1 }}>
                {branding.app_title}
              </Typography.Title>
              <Typography.Text style={{ color: '#8ab0d0', fontSize: 13 }}>
                {branding.app_subtitle}
              </Typography.Text>
            </div>
          </div>

          <Typography.Paragraph
            style={{
              color: '#c8ddf0', fontSize: 16, lineHeight: 1.7,
              margin: 0, maxWidth: 460,
            }}
          >
            {branding.login_tagline}
          </Typography.Paragraph>
        </div>

        <Divider style={{ borderColor: '#1e3a5f', margin: '0 0 32px' }} />

        {/* Feature highlights */}
        <Space direction="vertical" size={20} style={{ maxWidth: 480 }}>
          {FEATURES.map((f) => (
            <div key={f.title} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                background: 'rgba(255,255,255,0.05)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {f.icon}
              </div>
              <div>
                <div style={{ color: '#e0eeff', fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                  {f.title}
                </div>
                <div style={{ color: '#7a9bbf', fontSize: 13, lineHeight: 1.5 }}>
                  {f.desc}
                </div>
              </div>
            </div>
          ))}
        </Space>

        {/* Badge strip */}
        <div style={{ marginTop: 40, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {['PostGIS', 'OpenLayers', 'Django', 'React', 'Ollama AI'].map((tech) => (
            <span
              key={tech}
              style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#8ab0d0',
                fontSize: 11,
                padding: '3px 10px',
                borderRadius: 4,
                letterSpacing: 0.5,
              }}
            >
              {tech}
            </span>
          ))}
        </div>

        {/* Security note */}
        <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 13 }} />
          <Typography.Text style={{ color: '#556f8a', fontSize: 12 }}>
            Secured with JWT + optional 2FA. All activity is audit-logged.
          </Typography.Text>
        </div>
      </div>

      {/* Right login panel */}
      <div
        style={{
          width: 420,
          flexShrink: 0,
          background: '#06080f',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '48px 40px',
        }}
      >
        <div style={{ marginBottom: 32 }}>
          <Typography.Title level={3} style={{ color: '#e8eeff', margin: 0, marginBottom: 4 }}>
            {step === 'credentials' ? 'Sign In' : 'Two-Factor Auth'}
          </Typography.Title>
          <Typography.Text style={{ color: '#556f8a', fontSize: 13 }}>
            {step === 'credentials'
              ? 'Enter your credentials to access the platform'
              : 'Enter the 6-digit code from your authenticator app'}
          </Typography.Text>
        </div>

        {step === 'credentials' ? (
          <>
            {mutation.isError && (
              <Alert
                type="error"
                message={(mutation.error as any)?.response?.data?.detail || 'Invalid username or password'}
                showIcon
                style={{ marginBottom: 20 }}
              />
            )}

            <Form layout="vertical" onFinish={mutation.mutate} size="large">
              <Form.Item
                name="username"
                label={<span style={{ color: '#8ab0d0', fontSize: 13 }}>{t('auth.username')}</span>}
                rules={[{ required: true, message: t('auth.username') }]}
              >
                <Input
                  prefix={<UserOutlined style={{ color: '#446688' }} />}
                  placeholder={t('auth.username')}
                  autoComplete="username"
                  style={{ background: '#0d1526', borderColor: '#1e3050', color: '#dde8f8' }}
                />
              </Form.Item>

              <Form.Item
                name="password"
                label={<span style={{ color: '#8ab0d0', fontSize: 13 }}>{t('auth.password')}</span>}
                rules={[{ required: true, message: t('auth.password') }]}
              >
                <Input.Password
                  prefix={<LockOutlined style={{ color: '#446688' }} />}
                  placeholder={t('auth.password')}
                  autoComplete="current-password"
                  style={{ background: '#0d1526', borderColor: '#1e3050', color: '#dde8f8' }}
                />
              </Form.Item>

              <Form.Item style={{ marginTop: 8, marginBottom: 0 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={mutation.isPending}
                  style={{
                    height: 46, fontWeight: 600, fontSize: 15,
                    background: `linear-gradient(90deg, ${primaryColor} 0%, #096dd9 100%)`,
                    border: 'none',
                  }}
                >
                  {t('auth.login')}
                </Button>
              </Form.Item>
            </Form>

            <Divider style={{ borderColor: '#1a2a40', margin: '24px 0 20px' }}>
              <span style={{ color: '#334455', fontSize: 11 }}>Authorised Users Only</span>
            </Divider>

            <Typography.Text style={{ color: '#334455', fontSize: 12, display: 'block', textAlign: 'center' }}>
              For access requests contact your DEO / ADEO Admin
            </Typography.Text>
          </>
        ) : (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <SafetyCertificateOutlined style={{ fontSize: 40, color: '#52c41a', marginBottom: 12 }} />
            </div>

            {totpError && <Alert type="error" message={totpError} showIcon />}

            <Input
              size="large"
              maxLength={6}
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              onPressEnter={handleTotpSubmit}
              style={{
                textAlign: 'center', letterSpacing: 12, fontSize: 24, fontWeight: 700,
                background: '#0d1526', borderColor: '#1e3050', color: '#dde8f8', height: 56,
              }}
              autoFocus
            />

            <Button
              type="primary"
              block
              size="large"
              loading={totpLoading}
              onClick={handleTotpSubmit}
              style={{ height: 46, fontWeight: 600 }}
            >
              Verify Code
            </Button>

            <Button
              type="text"
              block
              onClick={() => { setStep('credentials'); setTotpCode(''); setTotpError('') }}
              style={{ color: '#556f8a', fontSize: 12 }}
            >
              Back to Sign In
            </Button>
          </Space>
        )}

        <div style={{ marginTop: 32, paddingTop: 16, borderTop: '1px solid #0f1c2e', textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography.Text style={{ color: '#24374a', fontSize: 11 }}>
            {branding.app_title} v2.0 — {t('auth.login_subtitle', 'Ministry of Defence, India')}
          </Typography.Text>
          <LanguageSwitcher />
        </div>
      </div>

      <style>{`
        @media (max-width: 768px) {
          .login-left-panel { display: none !important; }
        }
      `}</style>
    </div>
  )
}
