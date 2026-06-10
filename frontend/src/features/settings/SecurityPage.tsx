import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Input, Typography, Alert, Spin, Divider, Row, Col, Tag, Space, message,
} from 'antd'
import {
  SafetyOutlined, CopyOutlined, CheckCircleOutlined, CloseCircleOutlined,
  QrcodeOutlined, KeyOutlined,
} from '@ant-design/icons'
import api from '@/services/api'

const { Title, Text, Paragraph } = Typography

interface TwoFAStatus {
  is_enabled: boolean
  secret?: string
  qr_code?: string  // data:image/png;base64,…
}

export default function SecurityPage() {
  const qc = useQueryClient()
  const [otp, setOtp] = useState('')
  const [copied, setCopied] = useState(false)

  const { data, isLoading } = useQuery<TwoFAStatus>({
    queryKey: ['2fa-status'],
    queryFn: () => api.get('/accounts/auth/2fa/setup/').then(r => r.data),
  })

  const enableMutation = useMutation({
    mutationFn: (code: string) => api.post('/accounts/auth/2fa/setup/', { otp_code: code }),
    onSuccess: () => {
      message.success('Two-factor authentication enabled')
      setOtp('')
      qc.invalidateQueries({ queryKey: ['2fa-status'] })
    },
    onError: (e: any) => {
      message.error(e?.response?.data?.detail || 'Invalid OTP code — please try again')
    },
  })

  const disableMutation = useMutation({
    mutationFn: () => api.delete('/accounts/auth/2fa/setup/'),
    onSuccess: () => {
      message.success('Two-factor authentication disabled')
      qc.invalidateQueries({ queryKey: ['2fa-status'] })
    },
    onError: (e: any) => {
      message.error(e?.response?.data?.detail || 'Failed to disable 2FA')
    },
  })

  const copySecret = () => {
    if (data?.secret) {
      navigator.clipboard.writeText(data.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (isLoading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 600, background: '#050510', minHeight: '100%' }}>
      <Title level={4} style={{ color: '#4fc3f7', marginBottom: 4 }}>
        <SafetyOutlined /> Security
      </Title>
      <Text style={{ color: '#888', fontSize: 12 }}>
        Manage your account security settings.
      </Text>

      <Divider style={{ borderColor: '#1a1a3e', margin: '20px 0' }} />

      <div style={{
        background: '#0a0d20', borderRadius: 8, padding: 20,
        border: `1px solid ${data?.is_enabled ? '#16a34a' : '#1a1a3e'}`,
      }}>
        <Row align="middle" style={{ marginBottom: 12 }}>
          <Col flex="auto">
            <Text style={{ color: '#e0e0e0', fontSize: 15, fontWeight: 600 }}>
              <QrcodeOutlined style={{ marginRight: 8, color: '#4fc3f7' }} />
              Two-Factor Authentication (TOTP)
            </Text>
          </Col>
          <Col>
            {data?.is_enabled
              ? <Tag icon={<CheckCircleOutlined />} color="success">Enabled</Tag>
              : <Tag icon={<CloseCircleOutlined />} color="error">Disabled</Tag>}
          </Col>
        </Row>

        <Paragraph style={{ color: '#888', fontSize: 12, marginBottom: 16 }}>
          Add an extra layer of security by requiring a time-based one-time password (TOTP)
          from an authenticator app (Google Authenticator, Authy, etc.) at login.
        </Paragraph>

        {!data?.is_enabled && (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16, fontSize: 11 }}
              message="Scan the QR code below with your authenticator app, then enter the 6-digit code to activate 2FA."
            />

            {data?.qr_code && (
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <img
                  src={data.qr_code}
                  alt="TOTP QR code"
                  style={{
                    width: 200, height: 200, imageRendering: 'pixelated',
                    border: '3px solid #1a1a3e', borderRadius: 8,
                    background: '#fff', padding: 8,
                  }}
                />
              </div>
            )}

            {data?.secret && (
              <div style={{
                background: '#0a0c20', borderRadius: 6, padding: '8px 12px',
                border: '1px solid #1a1a3e', marginBottom: 16,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <KeyOutlined style={{ color: '#888' }} />
                <Text code style={{ flex: 1, fontSize: 13, letterSpacing: 2, color: '#4fc3f7' }}>
                  {data.secret}
                </Text>
                <Button
                  size="small"
                  icon={copied ? <CheckCircleOutlined /> : <CopyOutlined />}
                  onClick={copySecret}
                  style={{ borderColor: '#2a2a4a', color: copied ? '#22c55e' : '#888' }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}

            <div style={{ fontSize: 11, color: '#666', marginBottom: 12 }}>
              Can't scan? Enter the secret key manually in your authenticator app.
            </div>

            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="Enter 6-digit code from your app"
                value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onPressEnter={() => otp.length === 6 && enableMutation.mutate(otp)}
                maxLength={6}
                size="large"
                style={{ letterSpacing: 4, textAlign: 'center', fontSize: 18, fontWeight: 700 }}
              />
              <Button
                type="primary"
                size="large"
                loading={enableMutation.isPending}
                disabled={otp.length !== 6}
                onClick={() => enableMutation.mutate(otp)}
                style={{ background: '#16a34a', borderColor: '#16a34a' }}
              >
                Enable 2FA
              </Button>
            </Space.Compact>
          </>
        )}

        {data?.is_enabled && (
          <>
            <Alert
              type="success"
              showIcon
              message="Your account is protected with two-factor authentication."
              style={{ marginBottom: 16, fontSize: 11 }}
            />
            <Button
              danger
              loading={disableMutation.isPending}
              onClick={() => disableMutation.mutate()}
              icon={<CloseCircleOutlined />}
            >
              Disable 2FA
            </Button>
            <div style={{ fontSize: 11, color: '#666', marginTop: 8 }}>
              You will be prompted for an OTP code at every login until you disable this.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
