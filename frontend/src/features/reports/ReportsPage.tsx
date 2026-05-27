import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Table, Tag, Modal, Form, Input, Select, Space, message,
  Switch, Tooltip, Popconfirm, Typography, Row, Col,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SendOutlined, PlayCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
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
  last_sent: string | null
  next_run: string | null
}

const FREQ_COLOR: Record<string, string> = { DAILY: 'red', WEEKLY: 'blue', MONTHLY: 'green' }

export default function ReportsPage() {
  const qc = useQueryClient()
  const user = useAppStore(s => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [editItem, setEditItem] = useState<ReportSchedule | null>(null)
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
      message.success(editItem ? 'Schedule updated' : 'Schedule created')
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

  function openEdit(item: ReportSchedule) {
    setEditItem(item)
    form.setFieldsValue({
      name: item.name,
      report_type: item.report_type,
      frequency: item.frequency,
      recipients: item.recipients,
      organisation: item.organisation,
      is_active: item.is_active,
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
            title: 'Frequency', dataIndex: 'frequency', width: 90,
            render: (v, r) => <Tag color={FREQ_COLOR[v] || 'default'}>{r.frequency_display}</Tag>,
          },
          { title: 'Organisation', dataIndex: 'organisation_name', width: 180, render: v => <Text style={{ color: '#888' }}>{v}</Text> },
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
                <Popconfirm title="Delete this schedule?" onConfirm={() => deleteMutation.mutate(r.id)}>
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
          <Form.Item name="name" label="Schedule Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="report_type" label="Report Type" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'STATUS_SUMMARY', label: 'Project Status Summary' },
                  { value: 'FEATURE_EXPORT', label: 'Feature Data Export' },
                  { value: 'ACTIVITY_LOG', label: 'User Activity Log' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="frequency" label="Frequency" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'DAILY', label: 'Daily' },
                  { value: 'WEEKLY', label: 'Weekly' },
                  { value: 'MONTHLY', label: 'Monthly' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="organisation" label="Organisation" rules={[{ required: true }]}>
            <Select
              showSearch
              filterOption={(input, opt) => (opt?.label as string || '').toLowerCase().includes(input.toLowerCase())}
              options={(orgsData?.results ?? []).map(o => ({ value: o.id, label: o.name }))}
            />
          </Form.Item>
          <Form.Item
            name="recipients"
            label="Recipients (comma-separated emails)"
            rules={[{ required: true }]}
          >
            <Input.TextArea rows={2} placeholder="user1@example.com, user2@example.com" />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
