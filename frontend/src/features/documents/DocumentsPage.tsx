import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Table, Tag, Button, Typography, Space, message, Tooltip } from 'antd'
import { FileWordOutlined, RobotOutlined, DownloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { Document } from '@/types'
import { openDocumentInNewTab } from '@/services/documentUtils'

const OFFICE_EXTS = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'])

function fileExt(path: string) {
  return (path ?? '').split('.').pop()?.toLowerCase() ?? ''
}

export default function DocumentsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: qk.documents(),
    queryFn: () => api.get('/documents/?page_size=200').then((r) => r.data),
  })


  const processAI = useMutation({
    mutationFn: (id: number) => api.post(`/documents/${id}/process_ai/`),
    onSuccess: () => {
      message.success('AI processing queued')
      qc.invalidateQueries({ queryKey: qk.documents() })
    },
    onError: () => message.error('Failed to queue AI processing'),
  })

  const docs: Document[] = data?.results ?? data ?? []

  const columns: ColumnsType<Document> = [
    {
      title: 'Title',
      dataIndex: 'title',
      ellipsis: true,
    },
    {
      title: 'Category',
      dataIndex: 'category',
      width: 110,
      render: (v) => <Tag style={{ fontSize: 10 }}>{v || '—'}</Tag>,
    },
    {
      title: 'Size',
      dataIndex: 'file_size',
      width: 80,
      render: (v) => v ? `${(v / 1024).toFixed(1)} KB` : '—',
    },
    {
      title: 'AI',
      dataIndex: 'ai_processed',
      width: 80,
      render: (v) => v
        ? <Tag color="green">Processed</Tag>
        : <Tag>Pending</Tag>,
    },
    {
      title: 'Uploaded',
      dataIndex: 'uploaded_at',
      width: 100,
      render: (v) => new Date(v).toLocaleDateString(),
    },
    {
      title: 'Actions',
      width: 180,
      render: (_, doc) => {
        const isOffice = OFFICE_EXTS.has(fileExt(doc.file ?? ''))
        return (
          <Space size={4}>
            {isOffice && (
              <Tooltip title="Open in OnlyOffice (new tab)">
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<FileWordOutlined />}
                  onClick={() => openDocumentInNewTab(doc.id)}
                >
                  Open
                </Button>
              </Tooltip>
            )}
            {doc.file_url && (
              <Tooltip title="Download file">
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  href={doc.file_url}
                  target="_blank"
                />
              </Tooltip>
            )}
            <Tooltip title={doc.ai_processed ? 'Re-run AI analysis' : 'Run AI analysis'}>
              <Button
                size="small"
                icon={<RobotOutlined />}
                loading={processAI.isPending}
                onClick={() => processAI.mutate(doc.id)}
              />
            </Tooltip>
          </Space>
        )
      },
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
        dataSource={docs}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
      />
    </div>
  )
}
