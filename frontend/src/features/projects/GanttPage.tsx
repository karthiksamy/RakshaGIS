import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Table, Tag, Modal, Form, Input, Select, DatePicker, Space, message,
  Tooltip, Popconfirm, Typography, Row, Col, Progress,
} from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '@/services/api'

const { Title, Text } = Typography

interface Milestone {
  id: number
  project: number
  name: string
  description: string
  start_date: string | null
  due_date: string
  completed_date: string | null
  status: string
  status_display: string
  assignee: number | null
  assignee_name: string
  progress_pct: number
  created_at: string
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'default', IN_PROGRESS: 'blue', COMPLETED: 'green', DELAYED: 'red',
}

function GanttBar({ milestone }: { milestone: Milestone }) {
  const today = dayjs()
  const start = milestone.start_date ? dayjs(milestone.start_date) : today
  const due = dayjs(milestone.due_date)
  const rangeStart = today.subtract(30, 'day')
  const rangeEnd = today.add(60, 'day')
  const totalDays = rangeEnd.diff(rangeStart, 'day')

  const barStart = Math.max(0, start.diff(rangeStart, 'day'))
  const barEnd = Math.min(totalDays, due.diff(rangeStart, 'day'))
  const barWidth = Math.max(1, barEnd - barStart)

  const color = milestone.status === 'COMPLETED' ? '#52c41a'
    : milestone.status === 'DELAYED' ? '#f5222d'
    : milestone.status === 'IN_PROGRESS' ? '#1677ff'
    : '#555'

  return (
    <div style={{ position: 'relative', height: 20, background: '#1a2a3a', borderRadius: 3, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: `${(barStart / totalDays) * 100}%`,
          width: `${(barWidth / totalDays) * 100}%`,
          height: '100%',
          background: color,
          borderRadius: 3,
          opacity: 0.8,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: `${((today.diff(rangeStart, 'day')) / totalDays) * 100}%`,
          width: 2,
          height: '100%',
          background: '#fa8c16',
        }}
      />
    </div>
  )
}

export default function GanttPage() {
  const { id: projectId } = useParams()
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editItem, setEditItem] = useState<Milestone | null>(null)
  const [form] = Form.useForm()

  const { data: milestones = [], isLoading } = useQuery<Milestone[]>({
    queryKey: ['milestones', projectId],
    queryFn: () => api.get(`/projects/milestones/?project=${projectId}`).then(r => r.data.results ?? r.data),
  })

  const { data: usersData } = useQuery<{ results: { id: number; full_name: string }[] }>({
    queryKey: ['project-users', projectId],
    queryFn: () => api.get('/accounts/users/').then(r => r.data),
  })

  const saveMutation = useMutation({
    mutationFn: (values: any) => {
      const payload = {
        ...values,
        project: Number(projectId),
        start_date: values.start_date?.format('YYYY-MM-DD'),
        due_date: values.due_date?.format('YYYY-MM-DD'),
        completed_date: values.completed_date?.format('YYYY-MM-DD'),
      }
      return editItem
        ? api.patch(`/projects/milestones/${editItem.id}/`, payload)
        : api.post('/projects/milestones/', payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['milestones', projectId] })
      message.success(editItem ? 'Updated' : 'Milestone created')
      setModalOpen(false)
      form.resetFields()
      setEditItem(null)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/milestones/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['milestones', projectId] })
      message.success('Deleted')
    },
  })

  function openEdit(item: Milestone) {
    setEditItem(item)
    form.setFieldsValue({
      name: item.name,
      description: item.description,
      start_date: item.start_date ? dayjs(item.start_date) : null,
      due_date: dayjs(item.due_date),
      completed_date: item.completed_date ? dayjs(item.completed_date) : null,
      status: item.status,
      assignee: item.assignee,
    })
    setModalOpen(true)
  }

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#050510' }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Title level={4} style={{ color: '#4fc3f7', margin: 0 }}>Project Timeline / Gantt</Title>
          <Text style={{ color: '#666', fontSize: 12 }}>Bar range: 30 days past → 60 days ahead. Orange line = today.</Text>
        </Col>
        <Col>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true) }}>
            Add Milestone
          </Button>
        </Col>
      </Row>

      <Table
        dataSource={milestones}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={false}
        columns={[
          {
            title: 'Milestone', dataIndex: 'name',
            render: v => <Text style={{ color: '#e0e0e0' }}>{v}</Text>,
            width: 180,
          },
          {
            title: 'Status', dataIndex: 'status', width: 110,
            render: (v, r) => <Tag color={STATUS_COLOR[v]}>{r.status_display}</Tag>,
          },
          { title: 'Start', dataIndex: 'start_date', width: 90, render: v => <Text style={{ fontSize: 11 }}>{v ? dayjs(v).format('DD MMM YY') : '—'}</Text> },
          { title: 'Due', dataIndex: 'due_date', width: 90, render: v => <Text style={{ fontSize: 11 }}>{dayjs(v).format('DD MMM YY')}</Text> },
          { title: 'Assignee', dataIndex: 'assignee_name', width: 130, render: v => <Text style={{ fontSize: 11, color: '#888' }}>{v || '—'}</Text> },
          {
            title: 'Progress', dataIndex: 'progress_pct', width: 100,
            render: v => <Progress percent={v} size="small" strokeColor="#1677ff" trailColor="#1a2a3a" />,
          },
          {
            title: 'Timeline (90-day window)', key: 'gantt',
            render: (_, r) => <GanttBar milestone={r} />,
          },
          {
            title: '', width: 70,
            render: (_, r) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
                <Popconfirm title="Delete?" onConfirm={() => deleteMutation.mutate(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editItem ? 'Edit Milestone' : 'Add Milestone'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); setEditItem(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={vals => saveMutation.mutate(vals)} style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Milestone Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="start_date" label="Start Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="due_date" label="Due Date" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="status" label="Status" initialValue="PENDING">
                <Select options={[
                  { value: 'PENDING', label: 'Pending' },
                  { value: 'IN_PROGRESS', label: 'In Progress' },
                  { value: 'COMPLETED', label: 'Completed' },
                  { value: 'DELAYED', label: 'Delayed' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="completed_date" label="Completed Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="assignee" label="Assignee">
            <Select
              allowClear
              showSearch
              filterOption={(input, opt) => (opt?.label as string || '').toLowerCase().includes(input.toLowerCase())}
              options={(usersData?.results ?? []).map(u => ({ value: u.id, label: u.full_name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
