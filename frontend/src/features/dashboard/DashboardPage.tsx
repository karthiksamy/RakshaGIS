import { useQuery } from '@tanstack/react-query'
import { Card, Col, Row, Statistic, Table, Tag, Typography, Progress, Space, Badge, Timeline, Spin } from 'antd'
import {
  FolderOutlined, EnvironmentOutlined, TeamOutlined, BankOutlined,
  CheckCircleOutlined, ClockCircleOutlined, SyncOutlined, ArrowUpOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/app/store'
import api from '@/services/api'

dayjs.extend(relativeTime)

const { Title, Text } = Typography

interface DashboardStats {
  projects: { total: number; draft: number; submitted: number; under_review: number; approved: number; published: number; returned: number }
  survey_areas: { total: number; draft: number; submitted: number; under_review: number; approved: number; published: number; returned: number }
  feature_count: number
  user_count: number | null
  org_count: number | null
  recent_projects: { id: number; project_number: string; name: string; status: string; created_at: string }[]
  monthly_trend: { month: string; count: number }[]
  recent_activity: { id: number; project_number: string; project_name: string; survey_area_name: string | null; survey_area_status: string | null; action: string; actor: string; timestamp: string }[]
  pending_checker: number
  pending_approver: number
  overdue_areas: { id: number; name: string; status: string; project_number: string; project_id: number; days_stuck: number }[]
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default', SUBMITTED: 'blue', UNDER_REVIEW: 'orange',
  APPROVED: 'green', PUBLISHED: 'cyan', RETURNED: 'red',
}

function MiniBarChart({ data }: { data: { month: string; count: number }[] }) {
  const { t } = useTranslation()
  if (!data.length) return <Text type="secondary">{t('dashboard.no_data')}</Text>
  const max = Math.max(...data.map(d => d.count), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 }}>
      {data.map(d => (
        <div key={d.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            style={{
              width: '100%', background: '#1565c0',
              height: `${Math.max(4, (d.count / max) * 64)}px`,
              borderRadius: 2, transition: 'height 0.3s',
            }}
            title={`${d.month}: ${d.count}`}
          />
          <Text style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
            {d.month.split(' ')[0]}
          </Text>
        </div>
      ))}
    </div>
  )
}

function StatusDonut({ stats }: { stats: { total: number; draft: number; submitted: number; under_review: number; approved: number; published: number; returned: number } }) {
  const items = [
    { label: 'Draft', value: stats.draft, color: '#8c8c8c' },
    { label: 'Submitted', value: stats.submitted, color: '#1677ff' },
    { label: 'Under Review', value: stats.under_review, color: '#fa8c16' },
    { label: 'Approved', value: stats.approved, color: '#52c41a' },
    { label: 'Published', value: stats.published, color: '#13c2c2' },
    { label: 'Returned', value: stats.returned, color: '#f5222d' },
  ].filter(i => i.value > 0)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}>
      {items.map(item => (
        <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 10, height: 10, background: item.color, borderRadius: 2, flexShrink: 0 }} />
          <Text style={{ fontSize: 12 }}>{item.label}</Text>
          <Text strong style={{ fontSize: 12, color: item.color }}>{item.value}</Text>
        </div>
      ))}
    </div>
  )
}

function StatusBarChart({ stats }: { stats?: { draft: number; submitted: number; under_review: number; approved: number; published: number; returned: number } }) {
  if (!stats) return null
  const data = [
    { label: 'Draft', count: stats.draft, color: '#8c8c8c' },
    { label: 'Submitted', count: stats.submitted, color: '#1677ff' },
    { label: 'Under Review', count: stats.under_review, color: '#fa8c16' },
    { label: 'Approved', count: stats.approved, color: '#52c41a' },
    { label: 'Published', count: stats.published, color: '#13c2c2' },
    { label: 'Returned', count: stats.returned, color: '#f5222d' },
  ]
  const max = Math.max(...data.map(d => d.count), 1)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 0' }}>
      {data.map(d => {
        const pct = Math.round((d.count / max) * 100)
        return (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 90, textAlign: 'right' }}>
              <Text style={{ fontSize: 12, color: '#aaa' }}>{d.label}</Text>
            </div>
            <div style={{ flex: 1, background: '#14253f', height: 16, borderRadius: 3, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
              <div
                style={{
                  width: `${Math.max(3, pct)}%`,
                  background: d.color,
                  height: '100%',
                  borderRadius: 3,
                  transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: 6,
                }}
              >
                {d.count > 0 && (
                  <span style={{ fontSize: 10, color: '#000', fontWeight: 'bold', lineHeight: 1 }}>
                    {d.count}
                  </span>
                )}
              </div>
            </div>
            <div style={{ width: 30 }}>
              <Text strong style={{ fontSize: 12, color: d.color }}>{d.count}</Text>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function DashboardPage() {
  const { t } = useTranslation()
  const { user } = useAppStore()
  const isAdmin = user && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)

  const { data, isLoading } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.get('/dashboard/stats/').then(r => r.data),
    refetchInterval: 60_000,
  })

  if (isLoading) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
      <Spin size="large" />
    </div>
  )

  const s = data!
  const total = s.projects.total || 1
  const publishedPct = Math.round((s.projects.published / total) * 100)

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#050510' }}>
      <Title level={4} style={{ color: '#4fc3f7', marginBottom: 20 }}>{t('dashboard.title')}</Title>

      {/* Stats Cards */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050' }}>
            <Statistic
              title={<Text style={{ color: '#888', fontSize: 12 }}>{t('dashboard.total_projects')}</Text>}
              value={s.projects.total}
              prefix={<FolderOutlined style={{ color: '#1677ff' }} />}
              valueStyle={{ color: '#e0e0e0', fontSize: 28 }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050' }}>
            <Statistic
              title={<Text style={{ color: '#888', fontSize: 12 }}>{t('dashboard.total_features')}</Text>}
              value={s.feature_count}
              prefix={<EnvironmentOutlined style={{ color: '#52c41a' }} />}
              valueStyle={{ color: '#e0e0e0', fontSize: 28 }}
            />
          </Card>
        </Col>
        {s.user_count != null && (
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050' }}>
              <Statistic
                title={<Text style={{ color: '#888', fontSize: 12 }}>{t('dashboard.active_users')}</Text>}
                value={s.user_count}
                prefix={<TeamOutlined style={{ color: '#fa8c16' }} />}
                valueStyle={{ color: '#e0e0e0', fontSize: 28 }}
              />
            </Card>
          </Col>
        )}
        {s.org_count != null && (
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050' }}>
              <Statistic
                title={<Text style={{ color: '#888', fontSize: 12 }}>{t('dashboard.organisations')}</Text>}
                value={s.org_count}
                prefix={<BankOutlined style={{ color: '#13c2c2' }} />}
                valueStyle={{ color: '#e0e0e0', fontSize: 28 }}
              />
            </Card>
          </Col>
        )}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* Project Status Breakdown */}
        <Col xs={24} md={8}>
          <Card
            size="small"
            title={<Text style={{ color: '#aaa' }}>Project Status Breakdown</Text>}
            style={{ background: '#0e1a2e', border: '1px solid #1a3050', minHeight: 140 }}
          >
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <StatusDonut stats={s.projects} />
              <Progress
                percent={publishedPct}
                strokeColor="#13c2c2"
                trailColor="#1a2a3a"
                format={p => <Text style={{ color: '#aaa', fontSize: 11 }}>{p}% Published</Text>}
              />
            </Space>
          </Card>
        </Col>

        {/* Survey Area Progress */}
        <Col xs={24} md={8}>
          <Card
            size="small"
            title={<Text style={{ color: '#aaa' }}>Survey Area Progress</Text>}
            style={{ background: '#0e1a2e', border: '1px solid #1a3050', minHeight: 140 }}
          >
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              {s.survey_areas ? (
                <>
                  <StatusDonut stats={s.survey_areas} />
                  <Progress
                    percent={Math.round(((s.survey_areas.published ?? 0) / (s.survey_areas.total || 1)) * 100)}
                    strokeColor="#52c41a"
                    trailColor="#1a2a3a"
                    format={p => <Text style={{ color: '#aaa', fontSize: 11 }}>{p}% Published</Text>}
                  />
                </>
              ) : (
                <Text type="secondary">No survey area stats</Text>
              )}
            </Space>
          </Card>
        </Col>

        {/* Monthly Trend */}
        <Col xs={24} md={8}>
          <Card
            size="small"
            title={<Text style={{ color: '#aaa' }}>{t('dashboard.monthly_trend')}</Text>}
            style={{ background: '#0e1a2e', border: '1px solid #1a3050', minHeight: 140 }}
          >
            <MiniBarChart data={s.monthly_trend} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* Recent Projects */}
        <Col xs={24} md={14}>
          <Card
            size="small"
            title={<Text style={{ color: '#aaa' }}>{t('dashboard.recent_projects')}</Text>}
            style={{ background: '#0e1a2e', border: '1px solid #1a3050' }}
          >
            {s.recent_projects.length === 0 ? (
              <Text type="secondary">{t('dashboard.no_recent_projects')}</Text>
            ) : (
              <Table
                dataSource={s.recent_projects}
                rowKey="id"
                size="small"
                pagination={false}
                style={{ background: 'transparent' }}
                columns={[
                  {
                    title: 'No.',
                    dataIndex: 'project_number',
                    width: 120,
                    render: v => <Text style={{ color: '#4fc3f7', fontSize: 12 }}>{v}</Text>,
                  },
                  {
                    title: 'Name',
                    dataIndex: 'name',
                    render: v => <Text style={{ color: '#ccc', fontSize: 12 }}>{v}</Text>,
                    ellipsis: true,
                  },
                  {
                    title: 'Status',
                    dataIndex: 'status',
                    width: 90,
                    render: v => <Tag color={STATUS_COLOR[v] || 'default'} style={{ fontSize: 10 }}>{v}</Tag>,
                  },
                  {
                    title: 'Created',
                    dataIndex: 'created_at',
                    width: 90,
                    render: v => <Text style={{ color: '#666', fontSize: 11 }}>{dayjs(v).fromNow()}</Text>,
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        {/* Recent Activity */}
        <Col xs={24} md={10}>
          <Card
            size="small"
            title={<Text style={{ color: '#aaa' }}>{t('dashboard.recent_activity')}</Text>}
            style={{ background: '#0e1a2e', border: '1px solid #1a3050', maxHeight: 380, overflowY: 'auto' }}
          >
            {s.recent_activity.length === 0 ? (
              <Text type="secondary">{t('dashboard.no_recent_activity')}</Text>
            ) : (
              <Timeline
                items={s.recent_activity.map(a => {
                  const areaStatus = a.survey_area_status
                  const dotColor = areaStatus === 'APPROVED' ? 'green'
                    : areaStatus === 'SUBMITTED' ? 'blue'
                    : areaStatus === 'UNDER_REVIEW' ? 'orange'
                    : areaStatus === 'RETURNED' ? 'red'
                    : areaStatus === 'PUBLISHED' ? '#52c41a'
                    : 'gray'
                  return {
                    color: dotColor,
                    children: (
                      <div style={{ marginBottom: 2 }}>
                        {a.survey_area_name ? (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <Text style={{ color: '#e0e0e0', fontSize: 12, fontWeight: 500 }}>{a.survey_area_name}</Text>
                              {a.survey_area_status && (
                                <Tag
                                  color={STATUS_COLOR[a.survey_area_status] ?? 'default'}
                                  style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}
                                >
                                  {a.survey_area_status}
                                </Tag>
                              )}
                            </div>
                            <Text style={{ color: '#6a9fc8', fontSize: 11 }}>{a.project_number} · {a.action}</Text>
                          </>
                        ) : (
                          <>
                            <Text style={{ color: '#4fc3f7', fontSize: 12 }}>{a.project_number}</Text>
                            <Text style={{ color: '#aaa', fontSize: 12 }}> — {a.action}</Text>
                          </>
                        )}
                        <br />
                        <Text style={{ color: '#555', fontSize: 11 }}>by {a.actor} · {dayjs(a.timestamp).fromNow()}</Text>
                      </div>
                    ),
                  }
                })}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* Survey Progress Dashboard (Admin View) */}
      {isAdmin && (
        <div style={{ marginTop: 24 }}>
          <Title level={4} style={{ color: '#4fc3f7', marginBottom: 16 }}>
            Survey Progress Dashboard (Admin View)
          </Title>
          <Row gutter={[16, 16]}>
            {/* Status Distribution Bar Chart */}
            <Col xs={24} md={12}>
              <Card
                size="small"
                title={<Text style={{ color: '#aaa', fontWeight: 600 }}>Survey Area Status Distribution</Text>}
                style={{ background: '#0e1a2e', border: '1px solid #1a3050', minHeight: 340 }}
              >
                <StatusBarChart stats={s.survey_areas} />
              </Card>
            </Col>

            {/* Pending counts per Checker/Approver & Overdue areas */}
            <Col xs={24} md={12}>
              <Row gutter={[16, 16]}>
                <Col span={12}>
                  <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050', textAlign: 'center', minHeight: 100 }}>
                    <Statistic
                      title={<Text style={{ color: '#aaa', fontSize: 12 }}>Pending Checker Review</Text>}
                      value={s.pending_checker}
                      valueStyle={{ color: '#1677ff', fontSize: 32 }}
                    />
                  </Card>
                </Col>
                <Col span={12}>
                  <Card size="small" style={{ background: '#0e1a2e', border: '1px solid #1a3050', textAlign: 'center', minHeight: 100 }}>
                    <Statistic
                      title={<Text style={{ color: '#aaa', fontSize: 12 }}>Pending Approver Review</Text>}
                      value={s.pending_approver}
                      valueStyle={{ color: '#fa8c16', fontSize: 32 }}
                    />
                  </Card>
                </Col>
                <Col span={24}>
                  <Card
                    size="small"
                    title={<Text style={{ color: '#aaa', fontWeight: 600 }}>Overdue Survey Areas (Submitted &gt; 5 Days)</Text>}
                    style={{ background: '#0e1a2e', border: '1px solid #1a3050', minHeight: 224 }}
                  >
                    {s.overdue_areas.length === 0 ? (
                      <div style={{ padding: 36, textAlign: 'center' }}>
                        <Text type="secondary">No overdue survey areas</Text>
                      </div>
                    ) : (
                      <Table
                        dataSource={s.overdue_areas}
                        rowKey="id"
                        size="small"
                        pagination={false}
                        style={{ background: 'transparent' }}
                        columns={[
                          {
                            title: 'Area Name',
                            dataIndex: 'name',
                            render: (v) => <Text style={{ color: '#ccc', fontSize: 12 }}>{v}</Text>,
                          },
                          {
                            title: 'Project',
                            dataIndex: 'project_number',
                            render: (v) => <Text style={{ color: '#4fc3f7', fontSize: 11 }}>{v}</Text>,
                          },
                          {
                            title: 'Status',
                            dataIndex: 'status',
                            render: (v) => <Tag color={STATUS_COLOR[v] || 'default'} style={{ fontSize: 10 }}>{v}</Tag>,
                          },
                          {
                            title: 'Days Stuck',
                            dataIndex: 'days_stuck',
                            render: (v) => <Tag color="red" style={{ fontSize: 10 }}>{v} days</Tag>,
                          },
                        ]}
                      />
                    )}
                  </Card>
                </Col>
              </Row>
            </Col>
          </Row>
        </div>
      )}
    </div>
  )
}
