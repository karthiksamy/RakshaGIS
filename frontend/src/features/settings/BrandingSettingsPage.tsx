import { useEffect } from 'react'
import { Card, Form, Input, Button, Space, Typography, message, ColorPicker, Divider, Alert } from 'antd'
import { SaveOutlined, EyeOutlined, GlobalOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import type { BrandingConfig } from '@/context/BrandingContext'

const { Title, Text } = Typography

export default function BrandingSettingsPage() {
  const user = useAppStore((s) => s.user)
  const qc = useQueryClient()
  const { t } = useTranslation()
  const [form] = Form.useForm()

  if (user?.role !== 'SUPERADMIN') {
    return <Alert type="error" message={t("branding.access_denied")} style={{ margin: 24 }} />
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
      message.success(t('branding.updated'))
      // Update cache immediately for this session, then invalidate so all
      // components (including the login page on next visit) fetch fresh data.
      qc.setQueryData(['branding'], updated)
      qc.invalidateQueries({ queryKey: ['branding'] })
    },
    onError: () => message.error(t('common.error')),
  })

  function handleColorChange(_: any, hex: string) {
    form.setFieldValue('primary_color', hex)
  }

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <Title level={4} style={{ marginBottom: 4 }}>{t("branding.title")}</Title>
      <Text type="secondary" style={{ fontSize: 13 }}>
        Customise the application title, subtitle, colour scheme and login page messaging.
      </Text>

      <Card style={{ marginTop: 20 }} loading={isLoading}>
        <Form form={form} layout="vertical" onFinish={mutation.mutate} size="middle">
          <Title level={5} style={{ marginBottom: 16 }}>Application Identity</Title>

          <Form.Item
            name="app_title"
            label={t("branding.app_title")}
            rules={[{ required: true, max: 100 }]}
          >
            <Input prefix={<GlobalOutlined />} placeholder="RakshaGIS" />
          </Form.Item>

          <Form.Item
            name="app_subtitle"
            label={t("branding.org_subtitle")}
            rules={[{ max: 200 }]}
          >
            <Input placeholder="DGDE — Defence Estates GIS Platform" />
          </Form.Item>

          <Form.Item
            name="logo_url"
            label={t("branding.logo_url")}
            tooltip="Enter a URL to your logo image. Leave blank to use the default icon."
            rules={[{ type: 'url', message: 'Enter a valid URL' }]}
          >
            <Input placeholder="https://example.com/logo.png" />
          </Form.Item>

          <Divider />
          <Title level={5} style={{ marginBottom: 16 }}>Login Page</Title>

          <Form.Item
            name="login_tagline"
            label={t("branding.tagline")}
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
