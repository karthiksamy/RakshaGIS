import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Table, Tag, Typography, Select, Row, Col, Statistic, Card, Tooltip,
} from 'antd'
import {
  CheckCircleOutlined, WarningOutlined, CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import api from '@/services/api'

const { Title, Text } = Typography

interface SLAResult {
  area_id: number
  area_name: string
  project_id: number
  project_number: string
  org: string
  status: string
  assigned_to: string | null
  last_actor: string | null
  created_at: string
  draft_days: number | null
  submit_days: number | null
  review_days: number | null
  approved_days: number | null
  sla_draft: string | null
  sla_submit: string | null
  sla_review: string | null
  sla_approved: string | null
  overall_sla: 'OK' | 'WARNING' | 'OVERDUE'
}

interface SLAResponse {
  results: SLAResult[]
  sla_days: { draft_to_submit: number; submit_to_review: number; review_to_approve: number; approve_to_publish: number }
  summary: { OK: number; WARNING: number; OVERDUE: number; total: number }
}

const SLA_COLOR: Record<string, string> = { OK: '#22c55e', WARNING: '#f59e0b', OVERDUE: '#ef4444' }
const STATUS_COLOR: Record<string, string> = {
  DRAFT: '#8c8c8c', SUBMITTED: '#1677ff', UNDER_REVIEW: '#fa8c16',
  APPROVED: '#52c41a', PUBLISHED: '#13c2c2', RETURNED: '#f5222d',
}

function SLABadge({ sla }: { sla: string | null }) {
  if (!sla) return <Text style={{ color: '#555', fontSize: 11 }}>—</Text>
  const icons = { OK: <CheckCircleOutlined />, WARNING: <WarningOutlined />, OVERDUE: <CloseCircleOutlined /> }
  return (
    <Tag icon={icons[sla as keyof typeof icons]} color={sla === 'OK' ? 'success' : sla === 'WARNING' ? 'warning' : 'error'}
      style={{ fontSize: 10 }}>
      {sla}
    </Tag>
  )
}

function DaysCell({ days, sla, limit }: { days: number | null; sla: string | null; limit: number }) {
  if (days === null) return <Text style={{ color: '#555', fontSize: 11 }}>—</Text>
  const pct = Math.min(100, (days / limit) * 100)
  const color = SLA_COLOR[sla ?? 'OK']
  return (
    <Tooltip title={`${days}d / SLA ${limit}d`}>
      <div>
        <Text style={{ color, fontSize: 12, fontWeight: 600 }}>{days}d</Text>
        <div style={{ marginTop: 2, height: 4, background: '#1a1a2e', borderRadius: 2, width: 60, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
        </div>
      </div>
    </Tooltip>
  )
}

export default function SLAPage() {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [slaFilter, setSlaFilter] = useState<string | undefined>()

  const { data, isLoading } = useQuery<SLAResponse>({
    queryKey: ['sla-report', statusFilter],
    queryFn: () => api.get('/dashboard/sla/', {
      params: statusFilter ? { status: statusFilter } : {},
    }).then(r => r.data),
    staleTime: 60_000,
  })

  const limits = data?.sla_days ?? { draft_to_submit: 14, submit_to_review: 5, review_to_approve: 7, approve_to_publish: 3 }
  const s = data?.summary ?? { OK: 0, WARNING: 0, OVERDUE: 0, total: 0 }

  const filtered = (data?.results ?? []).filter(r =>
    !slaFilter || r.overall_sla === slaFilter
  )

  const columns = [
    {
      title: 'Survey Area',
      dataIndex: 'area_name',
      render: (v: string, r: SLAResult) => (
        <div>
          <Text style={{ color: '#4fc3f7', fontWeight: 500, cursor: 'pointer', fontSize: 13 }}
            onClick={() => navigate(`/projects/${r.project_id}`)}>
            {v}
          </Text>
          <div style={{ fontSize: 10, color: '#888' }}>{r.project_number} · {r.org}</div>
        </div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'} style={{ fontSize: 10 }}>{v}</Tag>,
    },
    {
      title: 'Assigned To',
      dataIndex: 'assigned_to',
      width: 140,
      render: (v: string | null) => <Text style={{ color: '#aaa', fontSize: 11 }}>{v || '—'}</Text>,
    },
    {
      title: () => (
        <Tooltip title={`SLA limit: ${limits.draft_to_submit}d`}>
          <span>Draft <ClockCircleOutlined style={{ fontSize: 10, color: '#8c8c8c' }} /></span>
        </Tooltip>
      ),
      dataIndex: 'draft_days',
      width: 80,
      render: (_: any, r: SLAResult) => <DaysCell days={r.draft_days} sla={r.sla_draft} limit={limits.draft_to_submit} />,
    },
    {
      title: () => <Tooltip title={`SLA limit: ${limits.submit_to_review}d`}><span>Submit <ClockCircleOutlined style={{ fontSize: 10, color: '#1677ff' }} /></span></Tooltip>,
      dataIndex: 'submit_days',
      width: 80,
      render: (_: any, r: SLAResult) => <DaysCell days={r.submit_days} sla={r.sla_submit} limit={limits.submit_to_review} />,
    },
    {
      title: () => <Tooltip title={`SLA limit: ${limits.review_to_approve}d`}><span>Review <ClockCircleOutlined style={{ fontSize: 10, color: '#fa8c16' }} /></span></Tooltip>,
      dataIndex: 'review_days',
      width: 80,
      render: (_: any, r: SLAResult) => <DaysCell days={r.review_days} sla={r.sla_review} limit={limits.review_to_approve} />,
    },
    {
      title: () => <Tooltip title={`SLA limit: ${limits.approve_to_publish}d`}><span>Approve <ClockCircleOutlined style={{ fontSize: 10, color: '#52c41a' }} /></span></Tooltip>,
      dataIndex: 'approved_days',
      width: 90,
      render: (_: any, r: SLAResult) => <DaysCell days={r.approved_days} sla={r.sla_approved} limit={limits.approve_to_publish} />,
    },
    {
      title: 'Overall SLA',
      dataIndex: 'overall_sla',
      width: 110,
      render: (_: any, r: SLAResult) => <SLABadge sla={r.overall_sla} />,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      width: 100,
      render: (v: string) => <Text style={{ fontSize: 10, color: '#888' }}>{dayjs(v).format('DD MMM YY')}</Text>,
    },
  ]

  return (
    <div style={{ padding: '20px 24px', background: '#050510', minHeight: '100%', overflowY: 'auto' }}>
      <Title level={4} style={{ color: '#4fc3f7', marginBottom: 4 }}>
        <ClockCircleOutlined style={{ marginRight: 8 }} />
        Survey SLA Tracker
      </Title>
      <Text style={{ color: '#888', fontSize: 12, display: 'block', marginBottom: 16 }}>
        Time each survey area spends in each workflow state vs. configured SLA limits.
      </Text>

      {/* Summary cards */}
      <Row gutter={12} style={{ marginBottom: 16 }}>
        {[
          { label: 'On Track', key: 'OK',      color: '#22c55e', icon: <CheckCircleOutlined /> },
          { label: 'Warning',  key: 'WARNING',  color: '#f59e0b', icon: <WarningOutlined /> },
          { label: 'Overdue',  key: 'OVERDUE',  color: '#ef4444', icon: <CloseCircleOutlined /> },
          { label: 'Total',    key: 'total',    color: '#4fc3f7', icon: <ClockCircleOutlined /> },
        ].map(({ label, key, color, icon }) => (
          <Col xs={12} md={6} key={key}>
            <Card
              size="small"
              style={{
                background: '#0a0d20', border: `1px solid ${color}40`, cursor: key !== 'total' ? 'pointer' : undefined,
                borderColor: slaFilter === key ? color : `${color}40`,
              }}
              onClick={() => key !== 'total' && setSlaFilter(f => f === key ? undefined : key)}
            >
              <Statistic
                title={<Text style={{ color: '#888', fontSize: 11 }}>{label}</Text>}
                value={s[key as keyof typeof s] ?? 0}
                prefix={<span style={{ color }}>{icon}</span>}
                valueStyle={{ color, fontSize: 24 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* Filters */}
      <Row gutter={8} style={{ marginBottom: 12 }}>
        <Col>
          <Select
            size="small" style={{ width: 160 }} placeholder="Filter by status" allowClear
            value={statusFilter} onChange={setStatusFilter}
            options={[
              { value: 'DRAFT',        label: 'Draft' },
              { value: 'SUBMITTED',    label: 'Submitted' },
              { value: 'UNDER_REVIEW', label: 'Under Review' },
              { value: 'APPROVED',     label: 'Approved' },
              { value: 'RETURNED',     label: 'Returned' },
            ]}
          />
        </Col>
        <Col>
          <Select
            size="small" style={{ width: 140 }} placeholder="SLA status" allowClear
            value={slaFilter} onChange={setSlaFilter}
            options={[
              { value: 'OVERDUE',  label: '🔴 Overdue' },
              { value: 'WARNING',  label: '🟡 Warning' },
              { value: 'OK',       label: '🟢 On Track' },
            ]}
          />
        </Col>
        <Col flex="auto">
          <Text style={{ color: '#555', fontSize: 11, lineHeight: '24px' }}>
            SLA limits — Draft: {limits.draft_to_submit}d · Submit: {limits.submit_to_review}d · Review: {limits.review_to_approve}d · Approve: {limits.approve_to_publish}d
          </Text>
        </Col>
      </Row>

      <Table
        dataSource={filtered}
        rowKey="area_id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: t => `${t} areas` }}
        columns={columns}
        rowClassName={(r: SLAResult) =>
          r.overall_sla === 'OVERDUE' ? 'sla-overdue-row' :
          r.overall_sla === 'WARNING' ? 'sla-warning-row' : ''
        }
        style={{ fontSize: 12 }}
        scroll={{ x: 900 }}
      />

      <style>{`
        .sla-overdue-row td { background: rgba(239,68,68,0.05) !important; }
        .sla-warning-row td { background: rgba(245,158,11,0.05) !important; }
      `}</style>
    </div>
  )
}
