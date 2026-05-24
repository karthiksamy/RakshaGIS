import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Table, Tag, Button, Typography, Space, message, Upload } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { Document } from '@/types'

export default function DocumentsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: qk.documents(),
    queryFn: () => api.get('/documents/').then((r) => r.data),
  })

  const columns: ColumnsType<Document> = [
    { title: 'Title', dataIndex: 'title' },
    { title: 'Category', dataIndex: 'category' },
    { title: 'Size', dataIndex: 'file_size', render: (v) => v ? `${(v / 1024).toFixed(1)} KB` : '—' },
    {
      title: 'AI Status',
      dataIndex: 'ai_processed',
      render: (v) => v ? <Tag color="green">Processed</Tag> : <Tag>Pending</Tag>,
    },
    {
      title: 'Uploaded',
      dataIndex: 'uploaded_at',
      render: (v) => new Date(v).toLocaleDateString(),
    },
    {
      title: '',
      render: (_, doc) => !doc.ai_processed && (
        <Button
          size="small"
          onClick={() =>
            api.post(`/documents/${doc.id}/process_ai/`).then(() => {
              message.success('AI processing queued')
              qc.invalidateQueries({ queryKey: qk.documents() })
            })
          }
        >
          Process AI
        </Button>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          Documents
        </Typography.Title>
      </div>
      <Table
        dataSource={data?.results}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
      />
    </div>
  )
}
