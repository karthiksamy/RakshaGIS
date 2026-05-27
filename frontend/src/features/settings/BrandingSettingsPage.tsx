import { useEffect } from 'react'
import { Card, Form, Input, Button, Space, Typography, message, ColorPicker, Divider, Alert } from 'antd'
import { SaveOutlined, EyeOutlined, GlobalOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import type { BrandingConfig } from '@/context/BrandingContext'

const { Title, Text } = Typography

export default function BrandingSettingsPage() {
  const user = useAppStore((s) => s.user)
  const qc = useQueryClient()
  const [form] = Form.useForm()

  if (user?.role !== 'SUPERADMIN') {
    return <Alert type="error" message="Access denied — Superadmin only" style={{ margin: 24 }} />
  }

  const { data, isLoading } = useQuery<BrandingConfig>({
    queryKey: ['branding'],
    queryFn: () => api.get('/core/branding/').then((r) => r.data),
  })

  useEffect(() => {
    if (data) form.setFieldsValue(data)
  }, [data])

  const mutation = useMutation({
    mutationFn: (values: Partial<BrandingConfig>) => api.patch('/core/branding/', values).then((r) => r.data),
    onSuccess: (updated) => {
      message.success('Branding updated — reload to see changes')
      qc.setQueryData(['branding'], updated)
    },
    onError: () => message.error('Failed to save branding'),
  })

  function handleColorChange(_: any, hex: string) {
    form.setFieldValue('primary_color', hex)
  }

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <Title level={4} style={{ marginBottom: 4 }}>Branding Settings</Title>
      <Text type="secondary" style={{ fontSize: 13 }}>
        Customise the application title, subtitle, colour scheme and login page messaging.
      </Text>

      <Card style={{ marginTop: 20 }} loading={isLoading}>
        <Form form={form} layout="vertical" onFinish={mutation.mutate} size="middle">
          <Title level={5} style={{ marginBottom: 16 }}>Application Identity</Title>

          <Form.Item
            name="app_title"
            label="Application Title"
            rules={[{ required: true, max: 100 }]}
          >
            <Input prefix={<GlobalOutlined />} placeholder="RakshaGIS" />
          </Form.Item>

          <Form.Item
            name="app_subtitle"
            label="Subtitle / Organisation Name"
            rules={[{ max: 200 }]}
          >
            <Input placeholder="DGDE — Defence Estates GIS Platform" />
          </Form.Item>

          <Form.Item
            name="logo_url"
            label="Logo URL"
            tooltip="Enter a URL to your logo image. Leave blank to use the default icon."
            rules={[{ type: 'url', message: 'Enter a valid URL' }]}
          >
            <Input placeholder="https://example.com/logo.png" />
          </Form.Item>

          <Divider />
          <Title level={5} style={{ marginBottom: 16 }}>Login Page</Title>

          <Form.Item
            name="login_tagline"
            label="Login Page Tagline"
            rules={[{ max: 300 }]}
          >
            <Input.TextArea
              rows={2}
              placeholder="Precision mapping for Defence Estate management"
            />
          </Form.Item>

          <Divider />
          <Title level={5} style={{ marginBottom: 16 }}>Theme</Title>

          <Form.Item label="Primary Colour" tooltip="Main accent colour used for buttons and links">
            <Space align="center" size={12}>
              <Form.Item name="primary_color" noStyle>
                <Input style={{ width: 120 }} placeholder="#1890ff" />
              </Form.Item>
              <ColorPicker
                value={form.getFieldValue('primary_color') || '#1890ff'}
                onChange={handleColorChange}
                showText={false}
              />
            </Space>
          </Form.Item>

          <Alert
            type="info"
            showIcon
            icon={<EyeOutlined />}
            message="Note: The primary colour applies when the 'Light' theme or the default 'Dark' theme is selected. Per-theme colours defined in the theme switcher take precedence."
            style={{ marginBottom: 20, fontSize: 12 }}
          />

          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={mutation.isPending}
            >
              Save Branding
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
