import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Space, Modal, Form, Input, Select,
  Typography, Tooltip, message, Alert,
} from 'antd'
import { PlusOutlined, EyeOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { SurveyProject, ProjectStatus } from '@/types'

const STATUS_COLORS: Record<ProjectStatus, string> = {
  DRAFT: 'default',
  SUBMITTED: 'processing',
  UNDER_REVIEW: 'warning',
  APPROVED: 'success',
  PUBLISHED: 'green',
  RETURNED: 'error',
}

const CAN_CREATE = ['SUPERADMIN', 'SDO', 'SURVEYOR']

const TRANSITIONS: { label: string; value: string; color: string }[] = [
  { value: 'submit', label: 'Submit for Review', color: 'blue' },
  { value: 'review', label: 'Mark Under Review', color: 'orange' },
  { value: 'approve', label: 'Approve', color: 'green' },
  { value: 'return', label: 'Return', color: 'red' },
  { value: 'publish', label: 'Publish', color: 'cyan' },
]

export default function ProjectsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [bulkModalOpen, setBulkModalOpen] = useState(false)
  const [bulkTransition, setBulkTransition] = useState('')
  const [bulkComment, setBulkComment] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ succeeded: number[]; failed: { id: number; error: string }[] } | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: qk.projects(),
    queryFn: () => api.get('/projects/').then((r) => r.data),
  })

  const { data: orgs } = useQuery({
    queryKey: qk.organisations(),
    queryFn: () => api.get('/accounts/organisations/').then((r) => r.data.results ?? r.data),
    enabled: user?.role === 'SUPERADMIN',
  })

  const createMutation = useMutation({
    mutationFn: (values: { name: string; description: string; organisation?: number }) =>
      api.post('/projects/', values).then((r) => r.data),
    onSuccess: () => {
      message.success('Project created')
      qc.invalidateQueries({ queryKey: qk.projects() })
      setModalOpen(false)
      form.resetFields()
    },
    onError: () => message.error('Failed to create project'),
  })

  async function handleBulkTransition() {
    if (!bulkTransition) { message.warning('Select a transition'); return }
    setBulkLoading(true)
    setBulkResult(null)
    try {
      const res = await api.post('/workflow/bulk-transition/', {
        project_ids: selectedRowKeys.map(Number),
        transition_name: bulkTransition,
        comment: bulkComment,
      })
      setBulkResult(res.data)
      qc.invalidateQueries({ queryKey: qk.projects() })
      if (res.data.succeeded?.length > 0) {
        message.success(`${res.data.succeeded.length} project(s) transitioned`)
        setSelectedRowKeys([])
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Bulk transition failed')
    } finally {
      setBulkLoading(false)
    }
  }

  const columns: ColumnsType<SurveyProject> = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name, record) => (
        <Button type="link" onClick={() => navigate(`/projects/${record.id}`)} style={{ padding: 0 }}>
          {name}
        </Button>
      ),
    },
    {
      title: '#',
      dataIndex: 'project_number',
      width: 90,
      render: (v) => <span style={{ fontSize: 11, color: '#888' }}>{v}</span>,
      responsive: ['md'],
    },
    {
      title: 'Organisation',
      dataIndex: 'organisation_name',
      responsive: ['md'],
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (status: ProjectStatus) => (
        <Tag color={STATUS_COLORS[status]}>{status}</Tag>
      ),
      filters: (['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED', 'RETURNED'] as ProjectStatus[]).map(
        (s) => ({ text: s, value: s })
      ),
      onFilter: (v, r) => r.status === v,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (v) => new Date(v).toLocaleDateString(),
      responsive: ['lg'],
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_, record) => (
        <Tooltip title="View">
          <Button
            type="text"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/projects/${record.id}`)}
          />
        </Tooltip>
      ),
    },
  ]

  const isAdmin = user && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          Survey Projects
        </Typography.Title>
        <Space>
          {selectedRowKeys.length > 0 && isAdmin && (
            <Button
              icon={<ThunderboltOutlined />}
              onClick={() => { setBulkModalOpen(true); setBulkResult(null) }}
              style={{ borderColor: '#1565c0', color: '#4fc3f7' }}
            >
              Bulk Transition ({selectedRowKeys.length})
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => refetch()} />
          {user && CAN_CREATE.includes(user.role) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              New Project
            </Button>
          )}
        </Space>
      </div>

      <Table
        dataSource={data?.results}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false }}
        rowSelection={
          isAdmin
            ? {
                selectedRowKeys,
                onChange: setSelectedRowKeys,
                selections: [Table.SELECTION_ALL, Table.SELECTION_NONE],
              }
            : undefined
        }
      />

      {/* Bulk transition modal */}
      <Modal
        title={<><ThunderboltOutlined style={{ marginRight: 8 }} />Bulk Status Transition</>}
        open={bulkModalOpen}
        onCancel={() => { setBulkModalOpen(false); setBulkComment(''); setBulkTransition('') }}
        onOk={handleBulkTransition}
        okText="Apply"
        confirmLoading={bulkLoading}
        width={480}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={12}>
          <div style={{ color: '#aaa', fontSize: 12 }}>
            Applying transition to <strong style={{ color: '#4fc3f7' }}>{selectedRowKeys.length}</strong> selected project(s).
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Transition *</div>
            <Select
              style={{ width: '100%' }}
              placeholder="Select transition"
              value={bulkTransition || undefined}
              onChange={setBulkTransition}
              options={TRANSITIONS.map((t) => ({
                value: t.value,
                label: <Tag color={t.color}>{t.label}</Tag>,
              }))}
            />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Comment (optional)</div>
            <Input.TextArea
              rows={2}
              value={bulkComment}
              onChange={(e) => setBulkComment(e.target.value)}
              placeholder="Review comment…"
            />
          </div>
          {bulkResult && (
            <div>
              {bulkResult.succeeded?.length > 0 && (
                <Alert
                  type="success"
                  message={`${bulkResult.succeeded.length} project(s) transitioned successfully`}
                  showIcon
                  style={{ marginBottom: 6 }}
                />
              )}
              {bulkResult.failed?.length > 0 && (
                <Alert
                  type="warning"
                  message={`${bulkResult.failed.length} project(s) failed:`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                      {bulkResult.failed.map((f) => (
                        <li key={f.id}>ID {f.id}: {f.error}</li>
                      ))}
                    </ul>
                  }
                  showIcon
                />
              )}
            </div>
          )}
        </Space>
      </Modal>

      {/* Create project modal */}
      <Modal
        title="Create Project"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
      >
        <Form form={form} layout="vertical" onFinish={createMutation.mutate}>
          <Form.Item name="name" label="Project Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          {user?.role === 'SUPERADMIN' ? (
            <Form.Item name="organisation" label="Organisation" rules={[{ required: true, message: 'Select an organisation' }]}>
              <Select
                placeholder="Select organisation"
                options={orgs?.map((o: any) => ({ label: o.name, value: o.id }))}
                showSearch
                filterOption={(input, option) =>
                  String(option?.label).toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
          ) : (
            <Form.Item label="Organisation">
              <Input disabled value={user?.organisation_name ?? ''} />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}
