import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Space, Modal, Form, Input, Select,
  Typography, Tooltip, message,
} from 'antd'
import { PlusOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons'
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

export default function ProjectsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()

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

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          Survey Projects
        </Typography.Title>
        <Space>
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
      />

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
          {user?.role === 'SUPERADMIN' && (
            <Form.Item name="organisation" label="Organisation" rules={[{ required: true }]}>
              <Select
                options={orgs?.map((o: any) => ({ label: o.name, value: o.id }))}
                showSearch
                filterOption={(input, option) =>
                  String(option?.label).toLowerCase().includes(input.toLowerCase())
                }
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}
