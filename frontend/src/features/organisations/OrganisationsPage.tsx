import { useQuery } from '@tanstack/react-query'
import { Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { Organisation } from '@/types'

const LEVEL_COLORS: Record<string, string> = {
  DGDE: 'purple', PDDE: 'blue', DEO: 'cyan', CEO: 'green', ADEO: 'orange',
}

export default function OrganisationsPage() {
  const { data, isLoading } = useQuery({
    queryKey: qk.organisations(),
    queryFn: () => api.get('/accounts/organisations/').then((r) => r.data.results ?? r.data),
  })

  const columns: ColumnsType<Organisation> = [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Code', dataIndex: 'code' },
    {
      title: 'Level',
      dataIndex: 'level',
      render: (l) => <Tag color={LEVEL_COLORS[l] ?? 'default'}>{l}</Tag>,
    },
    { title: 'Level Name', dataIndex: 'level_display' },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <Typography.Title level={4} style={{ marginBottom: 16, color: '#e8e8e8' }}>
        Organisations
      </Typography.Title>
      <Table
        dataSource={data}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
      />
    </div>
  )
}
