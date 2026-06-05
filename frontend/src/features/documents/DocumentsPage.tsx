import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table,
  Tag,
  Button,
  Typography,
  Space,
  message,
  Tooltip,
  Row,
  Col,
  Card,
} from 'antd'
import {
  FileWordOutlined,
  RobotOutlined,
  DownloadOutlined,
  SafetyCertificateOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { Document } from '@/types'
import { openDocumentInNewTab } from '@/services/documentUtils'

async function downloadDocument(doc: Document) {
  const response = await api.get(`/documents/${doc.id}/download/`, { responseType: 'blob' })
  const blob = new Blob([response.data], {
    type: response.headers['content-type'] || 'application/octet-stream',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  // Prefer original filename from Content-Disposition, fall back to title
  const cd = response.headers['content-disposition'] || ''
  const match = cd.match(/filename="?([^";\n]+)"?/)
  link.download = match ? match[1] : (doc.title || 'document')
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const OFFICE_EXTS = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'])

function fileExt(path: string) {
  return (path ?? '').split('.').pop()?.toLowerCase() ?? ''
}

export default function DocumentsPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [downloadingId, setDownloadingId] = useState<number | null>(null)

  const handleDownload = async (doc: Document) => {
    setDownloadingId(doc.id)
    try {
      await downloadDocument(doc)
    } catch {
      message.error('Download failed. Please try again.')
    } finally {
      setDownloadingId(null)
    }
  }

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
      render: (v, doc) => {
        const ext = fileExt(doc.file ?? '')
        const isOffice = OFFICE_EXTS.has(ext)
        if (isOffice) {
          return (
            <a
              style={{ cursor: 'pointer', color: '#1677ff', textDecoration: 'underline' }}
              onClick={(e) => {
                e.preventDefault()
                openDocumentInNewTab(doc.id)
              }}
            >
              {v}
            </a>
          )
        }
        return doc.file_url ? (
          <a href={doc.file_url} target="_blank" rel="noreferrer" style={{ color: '#aaa' }}>
            {v}
          </a>
        ) : (
          v
        )
      },
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
      render: (v) => (v ? `${(v / 1024).toFixed(1)} KB` : '—'),
    },
    {
      title: 'AI',
      dataIndex: 'ai_processed',
      width: 80,
      render: (v) => (v ? <Tag color="green">Processed</Tag> : <Tag>Pending</Tag>),
    },
    {
      title: 'Uploaded',
      dataIndex: 'uploaded_at',
      width: 100,
      render: (v) => new Date(v).toLocaleDateString(),
    },
    {
      title: 'Actions',
      width: 150,
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
            {doc.file && (
              <Tooltip title="Download file">
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  loading={downloadingId === doc.id}
                  onClick={() => handleDownload(doc)}
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
      <Row gutter={[24, 24]} style={{ minHeight: '100%' }}>
        <Col xs={24} lg={16}>
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
            style={{
              background: '#141424',
              borderRadius: 8,
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}
          />
        </Col>

        <Col xs={24} lg={8}>
          <Card
            title={
              <Space style={{ color: '#e8e8e8' }}>
                <SafetyCertificateOutlined style={{ color: '#1677ff' }} />
                <span>Verify File Authenticity</span>
              </Space>
            }
            bordered={false}
            style={{
              background: '#1a1a2e',
              borderRadius: 12,
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              cursor: 'pointer',
            }}
            onClick={() => navigate('/verify')}
            hoverable
            headStyle={{
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '8px 0 4px' }}>
              <SafetyCertificateOutlined style={{ fontSize: 52, color: '#1677ff', opacity: 0.8 }} />
              <Typography.Paragraph style={{ color: '#aaa', fontSize: 13, textAlign: 'center', margin: 0 }}>
                Verify the origin of any file exported from RakshaGIS — checks both signed
                <strong style={{ color: '#4fc3f7' }}> C2PA manifests</strong> and the
                <strong style={{ color: '#b37feb' }}> legacy provenance token</strong>.
              </Typography.Paragraph>
              <Button
                type="primary"
                icon={<ArrowRightOutlined />}
                onClick={() => navigate('/verify')}
                style={{ width: '100%', marginTop: 4 }}
              >
                Open Verification Tool
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
