import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Breadcrumb, Card, Col, Empty, Row, Spin, Statistic, Table, Tag, Typography,
} from 'antd'
import {
  ApartmentOutlined, BankOutlined, RightOutlined, TeamOutlined,
  FolderOutlined, EnvironmentOutlined, CheckCircleOutlined, ClockCircleOutlined,
} from '@ant-design/icons'
import api from '@/services/api'

const { Title, Text } = Typography

interface OrgStats {
  projects: number
  projects_published: number
  areas: number
  areas_published: number
  areas_in_review: number
  features: number
  users: number
}

interface DrilldownChild {
  id: number
  name: string
  level: string
  level_display: string
  has_children: boolean
  stats: OrgStats
}

interface DrilldownResponse {
  org: { id: number; name: string; level: string; level_display: string }
  breadcrumb: { id: number; name: string; level: string }[]
  own_stats: OrgStats
  total_stats: OrgStats
  children: DrilldownChild[]
}

const LEVEL_COLOR: Record<string, string> = {
  DGDE: 'magenta', PDDE: 'purple', DEO: 'gold', CEO: 'cyan', ADEO: 'blue',
}

/** Hierarchical aggregate dashboard: DGDE → command → office → sub-office.
 *  Aggregates only — office-level project data stays isolated. */
export default function OrgDrilldownPage() {
  const [orgId, setOrgId] = useState<number | null>(null)

  const { data, isLoading } = useQuery<DrilldownResponse>({
    queryKey: ['org-drilldown', orgId],
    queryFn: () =>
      api.get(`/dashboard/org-drilldown/${orgId ? `?org=${orgId}` : ''}`)
        .then((r) => r.data),
  })

  const statCard = (label: string, value: number, icon: React.ReactNode, color?: string) => (
    <Col xs={12} sm={8} md={6} lg={3}>
      <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
        <Statistic
          title={<span style={{ color: '#888', fontSize: 11 }}>{label}</span>}
          value={value}
          prefix={icon}
          valueStyle={{ color: color ?? '#e0e0e0', fontSize: 20 }}
        />
      </Card>
    </Col>
  )

  return (
    <div style={{ padding: '20px 24px', overflowY: 'auto', height: '100%', background: '#050510' }}>
      <Title level={4} style={{ color: '#4fc3f7', marginBottom: 4 }}>
        <ApartmentOutlined /> Office Drilldown
      </Title>
      <Text style={{ color: '#556f8a', fontSize: 12, display: 'block', marginBottom: 16 }}>
        Aggregate survey statistics down the office hierarchy. Click an office to drill in.
      </Text>

      {isLoading && <Spin style={{ display: 'block', margin: '60px auto' }} size="large" />}

      {data && (
        <>
          <Breadcrumb
            style={{ marginBottom: 16 }}
            items={data.breadcrumb.map((b, i) => ({
              title: (
                <a
                  onClick={(e) => { e.preventDefault(); setOrgId(i === 0 ? null : b.id) }}
                  style={{ color: b.id === data.org.id ? '#4fc3f7' : '#8ab0d0' }}
                >
                  <Tag color={LEVEL_COLOR[b.level]} style={{ fontSize: 9, marginRight: 4 }}>{b.level}</Tag>
                  {b.name}
                </a>
              ),
            }))}
          />

          {/* Subtree totals for the current office */}
          <Row gutter={[10, 10]} style={{ marginBottom: 16 }}>
            {statCard('Projects', data.total_stats.projects, <FolderOutlined />, '#4fc3f7')}
            {statCard('Published Projects', data.total_stats.projects_published, <CheckCircleOutlined />, '#52c41a')}
            {statCard('Survey Areas', data.total_stats.areas, <EnvironmentOutlined />, '#4fc3f7')}
            {statCard('Published Areas', data.total_stats.areas_published, <CheckCircleOutlined />, '#52c41a')}
            {statCard('In Review', data.total_stats.areas_in_review, <ClockCircleOutlined />, '#faad14')}
            {statCard('Features', data.total_stats.features, <EnvironmentOutlined />)}
            {statCard('Active Users', data.total_stats.users, <TeamOutlined />)}
          </Row>

          <Card
            size="small"
            title={
              <span style={{ fontSize: 13 }}>
                <BankOutlined style={{ marginRight: 6 }} />
                Offices under {data.org.name}
                <Tag color={LEVEL_COLOR[data.org.level]} style={{ marginLeft: 8, fontSize: 10 }}>
                  {data.org.level_display}
                </Tag>
              </span>
            }
          >
            {data.children.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span style={{ color: '#556f8a' }}>Drilldown ends here — only this office's own statistics are shown. Sub-office data is not aggregated.</span>}
              />
            ) : (
              <Table<DrilldownChild>
                dataSource={data.children}
                rowKey="id"
                size="small"
                pagination={false}
                onRow={(row) => ({
                  onClick: () => setOrgId(row.id),
                  style: { cursor: 'pointer' },
                })}
                columns={[
                  {
                    title: 'Office', dataIndex: 'name',
                    render: (v, r) => (
                      <span>
                        <Tag color={LEVEL_COLOR[r.level]} style={{ fontSize: 9 }}>{r.level}</Tag>
                        <Text style={{ color: '#e0e0e0' }}>{v}</Text>
                      </span>
                    ),
                  },
                  { title: 'Projects', dataIndex: ['stats', 'projects'], width: 90, align: 'center' },
                  {
                    title: 'Published', dataIndex: ['stats', 'areas_published'], width: 90, align: 'center',
                    render: (v) => <Text style={{ color: '#52c41a' }}>{v}</Text>,
                  },
                  { title: 'Survey Areas', dataIndex: ['stats', 'areas'], width: 110, align: 'center' },
                  {
                    title: 'In Review', dataIndex: ['stats', 'areas_in_review'], width: 90, align: 'center',
                    render: (v) => <Text style={{ color: v ? '#faad14' : '#555' }}>{v}</Text>,
                  },
                  { title: 'Features', dataIndex: ['stats', 'features'], width: 100, align: 'center' },
                  { title: 'Users', dataIndex: ['stats', 'users'], width: 80, align: 'center' },
                  {
                    title: '', width: 40,
                    render: (_, r) => <RightOutlined style={{ color: r.has_children ? '#4fc3f7' : '#333' }} />,
                  },
                ]}
              />
            )}
          </Card>
        </>
      )}
    </div>
  )
}
