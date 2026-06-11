import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Table, Tag, Modal, Form, Input, Select, Space, message,
  Switch, Tooltip, Popconfirm, Typography, Row, Col, InputNumber,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SendOutlined, PlayCircleOutlined,
  EnvironmentOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

const { Title, Text } = Typography

interface ReportSchedule {
  id: number
  name: string
  report_type: string
  report_type_display: string
  frequency: string
  frequency_display: string
  recipients: string
  organisation: number
  organisation_name: string
  is_active: boolean
  filters: Record<string, any>
  last_sent: string | null
  next_run: string | null
}

const FREQ_COLOR: Record<string, string> = { DAILY: 'red', WEEKLY: 'blue', MONTHLY: 'green' }

export default function ReportsPage() {
  const qc = useQueryClient()
  const user = useAppStore(s => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [editItem, setEditItem] = useState<ReportSchedule | null>(null)
  const { t } = useTranslation()
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery<{ results: ReportSchedule[] }>({
    queryKey: ['report-schedules'],
    queryFn: () => api.get('/reports/schedules/').then(r => r.data),
  })

  const { data: orgsData } = useQuery<{ results: { id: number; name: string }[] }>({
    queryKey: ['organisations-list'],
    queryFn: () => api.get('/accounts/organisations/?page_size=200').then(r => r.data),
  })

  const saveMutation = useMutation({
    mutationFn: (values: any) =>
      editItem
        ? api.patch(`/reports/schedules/${editItem.id}/`, values)
        : api.post('/reports/schedules/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['report-schedules'] })
      message.success(editItem ? t('reports.schedule_updated') : t('reports.schedule_created'))
      setModalOpen(false)
      form.resetFields()
      setEditItem(null)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error saving schedule'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/reports/schedules/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['report-schedules'] })
      message.success('Deleted')
    },
  })

  const sendNowMutation = useMutation({
    mutationFn: (id: number) => api.post(`/reports/schedules/${id}/send-now/`),
    onSuccess: () => message.success('Report queued for sending'),
    onError: () => message.error('Failed to queue report'),
  })

  const [reportType, setReportType] = useState<string>('')

  function openEdit(item: ReportSchedule) {
    setEditItem(item)
    setReportType(item.report_type)
    form.setFieldsValue({
      name: item.name,
      report_type: item.report_type,
      frequency: item.frequency,
      recipients: item.recipients,
      organisation: item.organisation,
      is_active: item.is_active,
      filters: item.filters,
    })
    setModalOpen(true)
  }

  const schedules = data?.results ?? []

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#050510' }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Title level={4} style={{ color: '#4fc3f7', margin: 0 }}>Scheduled Reports</Title>
        </Col>
        <Col>
          <Space>
            <Button
              icon={<PlayCircleOutlined />}
              onClick={() => api.post('/reports/schedules/run-all/').then(() => message.success('All due reports queued'))}
            >
              Run All Due Now
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true) }}>
              New Schedule
            </Button>
          </Space>
        </Col>
      </Row>

      <Table
        dataSource={schedules}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: v => <Text style={{ color: '#e0e0e0' }}>{v}</Text> },
          { title: 'Type', dataIndex: 'report_type_display', width: 160, render: v => <Text style={{ color: '#aaa' }}>{v}</Text> },
          {
            title: t('reports.frequency'), dataIndex: 'frequency', width: 90,
            render: (v, r) => <Tag color={FREQ_COLOR[v] || 'default'}>{r.frequency_display}</Tag>,
          },
          { title: t('reports.org'), dataIndex: 'organisation_name', width: 180, render: v => <Text style={{ color: '#888' }}>{v}</Text> },
          { title: 'Recipients', dataIndex: 'recipients', ellipsis: true, render: v => <Text style={{ color: '#666', fontSize: 11 }}>{v}</Text> },
          {
            title: 'Active', dataIndex: 'is_active', width: 70,
            render: (v, r) => <Switch size="small" checked={v} onChange={val => saveMutation.mutate({ is_active: val })} />,
          },
          {
            title: 'Last Sent', dataIndex: 'last_sent', width: 120,
            render: v => <Text style={{ color: '#666', fontSize: 11 }}>{v ? dayjs(v).format('DD MMM HH:mm') : '—'}</Text>,
          },
          {
            title: 'Actions', width: 120,
            render: (_, r) => (
              <Space size={4}>
                <Tooltip title="Edit"><Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} /></Tooltip>
                <Tooltip title="Send Now">
                  <Button size="small" icon={<SendOutlined />} onClick={() => sendNowMutation.mutate(r.id)} />
                </Tooltip>
                <Popconfirm title={t("reports.delete_schedule")} onConfirm={() => deleteMutation.mutate(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editItem ? 'Edit Schedule' : 'New Report Schedule'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); setEditItem(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
      >
        <Form form={form} layout="vertical" onFinish={vals => saveMutation.mutate(vals)} style={{ marginTop: 12 }}>
          <Form.Item name="name" label={t("reports.schedule_name")} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="report_type" label={t("reports.report_type")} rules={[{ required: true }]}>
                <Select
                  onChange={(v: string) => setReportType(v)}
                  options={[
                    { value: 'STATUS_SUMMARY',  label: 'Project Status Summary' },
                    { value: 'FEATURE_EXPORT',  label: 'Feature Data Export' },
                    { value: 'ACTIVITY_LOG',    label: 'User Activity Log' },
                    { value: 'TERRAIN_SUMMARY', label: '🗺 Terrain Analysis Summary (PDF)' },
                    { value: 'AI_SUMMARY',      label: '🤖 AI Survey Summary (PDF)' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="frequency" label={t("reports.frequency")} rules={[{ required: true }]}>
                <Select options={[
                  { value: 'DAILY', label: 'Daily' },
                  { value: 'WEEKLY', label: 'Weekly' },
                  { value: 'MONTHLY', label: 'Monthly' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="organisation" label={t("reports.org")} rules={[{ required: true }]}>
            <Select
              showSearch
              filterOption={(input, opt) => (opt?.label as string || '').toLowerCase().includes(input.toLowerCase())}
              options={(orgsData?.results ?? []).map(o => ({ value: o.id, label: o.name }))}
            />
          </Form.Item>
          <Form.Item
            name="recipients"
            label={t("reports.recipients")}
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={2} placeholder="user1@example.com, user2@example.com" />
          </Form.Item>

          {reportType === 'AI_SUMMARY' && (
            <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
              The local AI assistant (Ollama) writes a narrative executive summary from
              project statistics, feature counts, surveyed area and the recent timeline.
              A formatted, provenance-watermarked PDF is attached to the email. If the
              LLM is offline a statistical summary is sent instead.
            </div>
          )}

          {reportType === 'TERRAIN_SUMMARY' && (
            <>
              <Form.Item
                label={<><EnvironmentOutlined /> Watched Area Name</>}
                name={['filters', 'area_name']}
              >
                <Input placeholder="e.g. AFS Sulur northern perimeter" />
              </Form.Item>
              <Form.Item label="Bounding Box (minLon, minLat, maxLon, maxLat)" style={{ marginBottom: 4 }}>
                <Row gutter={4}>
                  {(['minLon','minLat','maxLon','maxLat'] as const).map((k, i) => (
                    <Col span={6} key={k}>
                      <Form.Item name={['filters', 'bbox', i]} noStyle>
                        <InputNumber
                          placeholder={k} style={{ width: '100%' }}
                          step={0.001} size="small"
                        />
                      </Form.Item>
                    </Col>
                  ))}
                </Row>
                <div style={{ fontSize: 10, color: '#888', marginTop: 3 }}>
                  Leave blank to report on the whole organisation. PDF attached to email.
                </div>
              </Form.Item>
            </>
          )}

          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
