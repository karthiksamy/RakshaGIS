import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Tag, Button, Space, Typography, Tabs, Descriptions, Timeline,
  Upload, Input, Modal, Form, Table, Spin, message, Popconfirm, Alert,
} from 'antd'
import {
  ArrowLeftOutlined, UploadOutlined, SendOutlined,
  CheckOutlined, CloseOutlined, LikeOutlined, GlobalOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { SurveyProject, WorkflowStep, Document, ShapefileImport } from '@/types'

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'default', SUBMITTED: 'processing', UNDER_REVIEW: 'warning',
  APPROVED: 'success', PUBLISHED: 'green', RETURNED: 'error',
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [commentModal, setCommentModal] = useState<string | null>(null)
  const [comment, setComment] = useState('')

  const pid = Number(id)

  const { data: project, isLoading } = useQuery<SurveyProject>({
    queryKey: qk.project(pid),
    queryFn: () => api.get(`/projects/${pid}/`).then((r) => r.data),
  })

  const { data: workflow } = useQuery<{ results: WorkflowStep[] }>({
    queryKey: qk.projectWorkflow(pid),
    queryFn: () => api.get(`/workflow/?project=${pid}`).then((r) => r.data),
  })

  const { data: docs } = useQuery<{ results: Document[] }>({
    queryKey: qk.documents({ project: pid }),
    queryFn: () => api.get(`/documents/?project=${pid}`).then((r) => r.data),
  })

  const transitionMutation = useMutation({
    mutationFn: ({ action, comment }: { action: string; comment: string }) =>
      api.post(`/workflow/${action}/`, { project: pid, comment }).then((r) => r.data),
    onSuccess: () => {
      message.success('Workflow updated')
      qc.invalidateQueries({ queryKey: qk.project(pid) })
      qc.invalidateQueries({ queryKey: qk.projectWorkflow(pid) })
      setCommentModal(null)
      setComment('')
    },
    onError: (e: any) =>
      message.error(e.response?.data?.detail || 'Transition failed'),
  })

  function doTransition(action: string) {
    setCommentModal(action)
  }

  function confirmTransition() {
    if (!commentModal) return
    transitionMutation.mutate({ action: commentModal, comment })
  }

  if (isLoading) return <div style={{ padding: 24 }}><Spin /></div>
  if (!project) return <Alert type="error" message="Project not found" style={{ margin: 24 }} />

  const docColumns: ColumnsType<Document> = [
    { title: 'Title', dataIndex: 'title' },
    { title: 'Category', dataIndex: 'category' },
    {
      title: 'AI',
      dataIndex: 'ai_processed',
      render: (v) => v ? <Tag color="green">Done</Tag> : <Tag>Pending</Tag>,
    },
    {
      title: '',
      render: (_, doc) => !doc.ai_processed && (
        <Button
          size="small"
          onClick={() => api.post(`/documents/${doc.id}/process_ai/`).then(() => {
            message.success('AI processing queued')
            qc.invalidateQueries({ queryKey: qk.documents({ project: pid }) })
          })}
        >
          Process AI
        </Button>
      ),
    },
  ]

  const canForward = user?.role && ['SDO', 'SURVEYOR', 'SUPERADMIN'].includes(user.role)
  const canCheck = user?.role && ['CHECKER', 'SUPERADMIN'].includes(user.role)
  const canApprove = user?.role && ['APPROVER', 'SUPERADMIN'].includes(user.role)
  const canPublish = user?.role && ['DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN', 'SUPERADMIN'].includes(user.role)

  const actions = []
  if (canForward && project.status === 'DRAFT')
    actions.push({ key: 'forward', label: 'Submit', icon: <SendOutlined />, color: 'primary' as const })
  if (canForward && project.status === 'RETURNED')
    actions.push({ key: 're_forward', label: 'Resubmit', icon: <SendOutlined />, color: 'primary' as const })
  if (canCheck && project.status === 'SUBMITTED')
    actions.push({ key: 'send_to_approver', label: 'Send to Approver', icon: <CheckOutlined />, color: 'primary' as const })
  if (canCheck && project.status === 'SUBMITTED')
    actions.push({ key: 'return_to_sdo', label: 'Return', icon: <CloseOutlined />, color: 'default' as const })
  if (canApprove && project.status === 'UNDER_REVIEW')
    actions.push({ key: 'approve', label: 'Approve', icon: <LikeOutlined />, color: 'primary' as const })
  if (canApprove && project.status === 'UNDER_REVIEW')
    actions.push({ key: 'return_from_review', label: 'Return', icon: <CloseOutlined />, color: 'default' as const })
  if (canPublish && project.status === 'APPROVED')
    actions.push({ key: 'publish', label: 'Publish', icon: <GlobalOutlined />, color: 'primary' as const })

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')} />
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          {project.name}
        </Typography.Title>
        <Tag color={STATUS_COLORS[project.status]}>{project.status}</Tag>
      </Space>

      {actions.length > 0 && (
        <Card
          size="small"
          style={{ marginBottom: 16, background: '#0e1a2e', border: '1px solid #1a2a4a' }}
        >
          <Space>
            {actions.map((a) => (
              <Button
                key={a.key}
                type={a.color}
                icon={a.icon}
                size="small"
                onClick={() => doTransition(a.key)}
              >
                {a.label}
              </Button>
            ))}
          </Space>
        </Card>
      )}

      <Tabs
        defaultActiveKey="info"
        items={[
          {
            key: 'info',
            label: 'Details',
            children: (
              <Descriptions column={2} size="small">
                <Descriptions.Item label="Organisation">{project.organisation_name}</Descriptions.Item>
                <Descriptions.Item label="Status"><Tag color={STATUS_COLORS[project.status]}>{project.status}</Tag></Descriptions.Item>
                <Descriptions.Item label="Created By">{project.created_by_name}</Descriptions.Item>
                <Descriptions.Item label="Created At">{new Date(project.created_at).toLocaleString()}</Descriptions.Item>
                <Descriptions.Item label="Description" span={2}>{project.description || '—'}</Descriptions.Item>
              </Descriptions>
            ),
          },
          {
            key: 'workflow',
            label: 'Workflow History',
            children: (
              <Timeline
                items={workflow?.results?.map((w) => ({
                  color:
                    w.action === 'approve' || w.action === 'publish' ? 'green'
                    : w.action.includes('return') ? 'red'
                    : 'blue',
                  children: (
                    <div>
                      <strong style={{ color: '#ddd' }}>{w.action}</strong>{' '}
                      <span style={{ color: '#aaa', fontSize: 12 }}>by {w.performed_by_name}</span>
                      <br />
                      {w.comment && <span style={{ color: '#bbb', fontSize: 12 }}>{w.comment}</span>}
                      <br />
                      <span style={{ color: '#666', fontSize: 11 }}>{new Date(w.timestamp).toLocaleString()}</span>
                    </div>
                  ),
                }))}
              />
            ),
          },
          {
            key: 'documents',
            label: 'Documents',
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Upload
                  name="file"
                  action={`/api/documents/`}
                  data={{ project: pid, title: 'Upload', category: 'SURVEY' }}
                  headers={{ Authorization: `Bearer ${localStorage.getItem('access_token')}` }}
                  onChange={({ file }) => {
                    if (file.status === 'done') {
                      message.success('Document uploaded')
                      qc.invalidateQueries({ queryKey: qk.documents({ project: pid }) })
                    }
                  }}
                  showUploadList={false}
                >
                  <Button icon={<UploadOutlined />} size="small">Upload Document</Button>
                </Upload>
                <Table
                  dataSource={docs?.results}
                  columns={docColumns}
                  rowKey="id"
                  size="small"
                  pagination={false}
                />
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`Confirm: ${commentModal}`}
        open={!!commentModal}
        onOk={confirmTransition}
        onCancel={() => { setCommentModal(null); setComment('') }}
        confirmLoading={transitionMutation.isPending}
      >
        <Input.TextArea
          rows={3}
          placeholder="Optional comment..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Modal>
    </div>
  )
}
