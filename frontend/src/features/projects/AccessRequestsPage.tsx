import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Card, Tabs, Table, Tag, Button, Space, Typography, Input, Modal,
  Form, message, Tooltip, Badge, Alert,
} from 'antd'
import {
  CheckOutlined, CloseOutlined, EyeOutlined, LockOutlined,
  UnlockOutlined, SendOutlined, TeamOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { SurveyAreaDiscovery, SurveyAreaAccessRequest } from '@/types'

const { Title, Text } = Typography
const { TextArea } = Input

const STATUS_COLOR: Record<string, string> = {
  NONE: 'default',
  PENDING: 'processing',
  APPROVED: 'success',
  REJECTED: 'error',
}

export default function AccessRequestsPage() {
  const user = useAppStore((s) => s.user)
  const qc = useQueryClient()
  const isAdmin = user?.role && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)

  // ── Incoming requests (admin view) ──────────────────────────────
  const { data: incoming = [], isLoading: loadingIncoming } = useQuery<SurveyAreaAccessRequest[]>({
    queryKey: qk.accessRequests({ direction: 'incoming' }),
    queryFn: () => api.get('/projects/access-requests/?direction=incoming').then((r) => r.data),
    enabled: !!isAdmin,
  })

  // ── My outgoing requests ─────────────────────────────────────────
  const { data: outgoing = [], isLoading: loadingOutgoing } = useQuery<SurveyAreaAccessRequest[]>({
    queryKey: qk.accessRequests({ direction: 'outgoing' }),
    queryFn: () => api.get('/projects/access-requests/?direction=outgoing').then((r) => r.data),
  })

  // ── Discoverable areas (siblings under same PDDE) ────────────────
  const { data: discoverable = [], isLoading: loadingDisc } = useQuery<SurveyAreaDiscovery[]>({
    queryKey: qk.areaDiscovery(),
    queryFn: () => api.get('/projects/survey-areas/discovery/').then((r) => r.data),
  })

  // ── Request modal state ──────────────────────────────────────────
  const [requestModal, setRequestModal] = useState<SurveyAreaDiscovery | null>(null)
  const [requestReason, setRequestReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // ── Review modal state ───────────────────────────────────────────
  const [reviewModal, setReviewModal] = useState<{ req: SurveyAreaAccessRequest; action: 'approve' | 'reject' } | null>(null)
  const [remarks, setRemarks] = useState('')
  const [reviewing, setReviewing] = useState(false)

  async function submitRequest(area: SurveyAreaDiscovery) {
    setSubmitting(true)
    try {
      await api.post(`/projects/survey-areas/${area.id}/request-access/`, { reason: requestReason })
      message.success(`Access requested for "${area.name}"`)
      qc.invalidateQueries({ queryKey: qk.areaDiscovery() })
      qc.invalidateQueries({ queryKey: ['access-requests'] })
      setRequestModal(null)
      setRequestReason('')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Failed to submit request')
    } finally {
      setSubmitting(false)
    }
  }

  async function submitReview(action: 'approve' | 'reject', req: SurveyAreaAccessRequest) {
    setReviewing(true)
    try {
      await api.post(`/projects/access-requests/${req.id}/${action}/`, { remarks })
      message.success(`Request ${action === 'approve' ? 'approved' : 'rejected'}`)
      qc.invalidateQueries({ queryKey: ['access-requests'] })
      setReviewModal(null)
      setRemarks('')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Action failed')
    } finally {
      setReviewing(false)
    }
  }

  const incomingCols: ColumnsType<SurveyAreaAccessRequest> = [
    { title: 'Survey Area', dataIndex: 'survey_area_name', key: 'area' },
    { title: 'Project', dataIndex: 'project_name', key: 'project' },
    { title: 'Requested By', dataIndex: 'requested_by_name', key: 'by' },
    { title: 'From Org', dataIndex: 'requesting_org_name', key: 'org' },
    { title: 'Reason', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s: string, r) => <Tag color={STATUS_COLOR[s]}>{r.status_display}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, r) =>
        r.status === 'PENDING' ? (
          <Space>
            <Button
              size="small" type="primary" icon={<CheckOutlined />}
              onClick={() => { setReviewModal({ req: r, action: 'approve' }); setRemarks('') }}
            >
              Approve
            </Button>
            <Button
              size="small" danger icon={<CloseOutlined />}
              onClick={() => { setReviewModal({ req: r, action: 'reject' }); setRemarks('') }}
            >
              Reject
            </Button>
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.reviewed_by_name} · {r.reviewed_at ? new Date(r.reviewed_at).toLocaleDateString() : ''}
          </Text>
        ),
    },
  ]

  const outgoingCols: ColumnsType<SurveyAreaAccessRequest> = [
    { title: 'Survey Area', dataIndex: 'survey_area_name', key: 'area' },
    { title: 'Project', dataIndex: 'project_name', key: 'project' },
    { title: 'Target Office', dataIndex: 'target_org_name', key: 'target' },
    { title: 'Reason', dataIndex: 'reason', key: 'reason', ellipsis: true },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s: string, r) => <Tag color={STATUS_COLOR[s]}>{r.status_display}</Tag>,
    },
    {
      title: 'Remarks',
      dataIndex: 'review_remarks',
      key: 'remarks',
      ellipsis: true,
      render: (v) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Date',
      dataIndex: 'created_at',
      key: 'date',
      render: (v) => new Date(v).toLocaleDateString(),
    },
  ]

  const discoveryCols: ColumnsType<SurveyAreaDiscovery> = [
    { title: 'Survey Area', dataIndex: 'name', key: 'name' },
    { title: 'Project', dataIndex: 'project_name', key: 'project' },
    { title: 'Office', dataIndex: 'org_name', key: 'org' },
    { title: 'Level', dataIndex: 'org_level', key: 'level', render: (v) => <Tag>{v}</Tag> },
    {
      title: 'Survey Status',
      dataIndex: 'status',
      key: 'status',
      render: (v) => <Tag>{v}</Tag>,
    },
    {
      title: 'Access',
      dataIndex: 'access_status',
      key: 'access',
      render: (v) => (
        <Tag color={STATUS_COLOR[v]} icon={v === 'APPROVED' ? <UnlockOutlined /> : <LockOutlined />}>
          {v === 'NONE' ? 'Not Requested' : v === 'PENDING' ? 'Pending' : v === 'APPROVED' ? 'Granted' : 'Rejected'}
        </Tag>
      ),
    },
    {
      title: 'Action',
      key: 'action',
      render: (_, r) => {
        if (r.access_status === 'APPROVED') return null
        const label = r.access_status === 'NONE' ? 'Request Access'
          : r.access_status === 'REJECTED' ? 'Re-request' : 'Pending…'
        return (
          <Button
            size="small"
            icon={<SendOutlined />}
            disabled={r.access_status === 'PENDING'}
            onClick={() => { setRequestModal(r); setRequestReason('') }}
          >
            {label}
          </Button>
        )
      },
    },
  ]

  const pendingIncoming = incoming.filter((r) => r.status === 'PENDING').length

  const tabs = [
    {
      key: 'discover',
      label: (
        <span>
          <TeamOutlined /> Discover Areas
        </span>
      ),
      children: (
        <div>
          <Alert
            type="info"
            showIcon
            message="Survey areas from sibling offices under your PDDE command"
            description="You can request read-only access to any area. Requests go to the office admin for approval."
            style={{ marginBottom: 16 }}
          />
          <Table
            columns={discoveryCols}
            dataSource={discoverable}
            rowKey="id"
            loading={loadingDisc}
            size="small"
            pagination={{ pageSize: 20 }}
          />
        </div>
      ),
    },
    {
      key: 'outgoing',
      label: 'My Requests',
      children: (
        <Table
          columns={outgoingCols}
          dataSource={outgoing}
          rowKey="id"
          loading={loadingOutgoing}
          size="small"
          pagination={{ pageSize: 20 }}
        />
      ),
    },
    ...(isAdmin ? [{
      key: 'incoming',
      label: (
        <Badge count={pendingIncoming} size="small" offset={[6, 0]}>
          Incoming Requests
        </Badge>
      ),
      children: (
        <Table
          columns={incomingCols}
          dataSource={incoming}
          rowKey="id"
          loading={loadingIncoming}
          size="small"
          pagination={{ pageSize: 20 }}
        />
      ),
    }] : []),
  ]

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <Title level={3} style={{ color: '#e8e8e8', marginBottom: 4 }}>
        Cross-Office Data Access
      </Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        Request read-only access to survey areas from other offices in your command.
      </Text>

      <Card styles={{ body: { padding: '0 0 16px' } }}>
        <Tabs items={tabs} style={{ padding: '0 16px' }} />
      </Card>

      {/* ── Request access modal ─────────────────────────────────── */}
      <Modal
        open={!!requestModal}
        onCancel={() => setRequestModal(null)}
        title={`Request Access — ${requestModal?.name}`}
        onOk={() => requestModal && submitRequest(requestModal)}
        okText="Submit Request"
        okButtonProps={{ loading: submitting, icon: <SendOutlined /> }}
        confirmLoading={submitting}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary">Office: </Text>
            <Text strong>{requestModal?.org_name}</Text>
            <Text type="secondary"> · Project: </Text>
            <Text>{requestModal?.project_name}</Text>
          </div>
          <div>
            <div style={{ marginBottom: 6, color: '#ccc', fontSize: 13 }}>
              Reason for access (optional):
            </div>
            <TextArea
              rows={3}
              value={requestReason}
              onChange={(e) => setRequestReason(e.target.value)}
              placeholder="Describe why you need access to this survey area…"
            />
          </div>
        </Space>
      </Modal>

      {/* ── Review modal ─────────────────────────────────────────── */}
      <Modal
        open={!!reviewModal}
        onCancel={() => setReviewModal(null)}
        title={
          reviewModal?.action === 'approve'
            ? `Approve Access — ${reviewModal.req.survey_area_name}`
            : `Reject Request — ${reviewModal?.req.survey_area_name}`
        }
        onOk={() => reviewModal && submitReview(reviewModal.action, reviewModal.req)}
        okText={reviewModal?.action === 'approve' ? 'Approve' : 'Reject'}
        okButtonProps={{
          loading: reviewing,
          danger: reviewModal?.action === 'reject',
          icon: reviewModal?.action === 'approve' ? <CheckOutlined /> : <CloseOutlined />,
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary">From: </Text>
            <Text strong>{reviewModal?.req.requesting_org_name}</Text>
          </div>
          {reviewModal?.req.reason && (
            <div>
              <Text type="secondary">Reason given: </Text>
              <Text>{reviewModal.req.reason}</Text>
            </div>
          )}
          <div>
            <div style={{ marginBottom: 6, color: '#ccc', fontSize: 13 }}>
              Remarks (optional):
            </div>
            <TextArea
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Add a note for the requester…"
            />
          </div>
        </Space>
      </Modal>
    </div>
  )
}
