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
  Upload,
  Alert,
  Spin,
  Descriptions,
  Badge,
  Timeline,
} from 'antd'
import {
  FileWordOutlined,
  RobotOutlined,
  DownloadOutlined,
  InboxOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons'
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
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<any>(null)

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

  const draggerProps = {
    name: 'file',
    multiple: false,
    showUploadList: false,
    customRequest: async (options: any) => {
      const { file, onSuccess, onError } = options
      const formData = new FormData()
      formData.append('file', file)

      setVerifying(true)
      setVerifyResult(null)
      try {
        const res = await api.post('/documents/verify-watermark/', formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
        })
        setVerifyResult(res.data)
        onSuccess?.(res.data)
        if (res.data.watermarked) {
          message.success('Watermark verified successfully!')
        } else {
          message.warning('No watermark found in this file.')
        }
      } catch (err: any) {
        console.error(err)
        onError?.(err)
        message.error(err.response?.data?.detail || 'Failed to verify file.')
      } finally {
        setVerifying(false)
      }
    },
  }

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
            }}
            headStyle={{
              borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <Typography.Paragraph style={{ color: '#aaa', fontSize: 13 }}>
              Upload any PDF, Office document, ZIP shapefile, GeoJSON, KML, GPKG, CSV, or Image exported from RakshaGIS to verify its origin and view signed metadata.
            </Typography.Paragraph>

            <Upload.Dragger
              {...draggerProps}
              disabled={verifying}
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px dashed rgba(255, 255, 255, 0.15)',
                borderRadius: 8,
                padding: '24px 0',
              }}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined style={{ color: '#1677ff', fontSize: 36 }} />
              </p>
              <p className="ant-upload-text" style={{ color: '#e8e8e8', fontSize: 13, fontWeight: 500 }}>
                Click or drag file to this area to scan
              </p>
              <p className="ant-upload-hint" style={{ color: '#666', fontSize: 11 }}>
                Supports GIS maps, documents, and images (Max 100MB)
              </p>
            </Upload.Dragger>

            {verifying && (
              <div style={{ textAlign: 'center', marginTop: 24 }}>
                <Spin tip="Scanning for digital watermarks..." size="large" style={{ color: '#1677ff' }} />
              </div>
            )}

            {verifyResult && (
              <div style={{ marginTop: 20 }}>
                {verifyResult.watermarked ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <Alert
                      message={
                        <span style={{ fontWeight: 'bold', color: '#52c41a' }}>
                          Verified RakshaGIS Document
                        </span>
                      }
                      description={
                        <div>
                          <div>This file contains a valid digital provenance watermark from RakshaGIS/DEMAP.</div>
                          {verifyResult.registry_verified ? (
                            <Tag color="success" style={{ background: '#092b00', border: '1px solid #237804', color: '#52c41a', marginTop: 8 }}>
                              ✓ CENTRAL REGISTRY AUTHENTICATED
                            </Tag>
                          ) : (
                            <Tag color="warning" style={{ marginTop: 8 }}>
                              ⚠ CRYPTOGRAPHIC VERIFIED (REGISTRY ABSENT)
                            </Tag>
                          )}
                        </div>
                      }
                      type="success"
                      showIcon
                      icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
                      style={{
                        background: 'rgba(82, 196, 26, 0.08)',
                        border: '1px solid rgba(82, 196, 26, 0.2)',
                      }}
                    />

                    <Descriptions
                      title={<span style={{ color: '#e8e8e8', fontSize: 13, fontWeight: 600 }}>Watermark Details</span>}
                      column={1}
                      bordered
                      size="small"
                      style={{
                        background: 'rgba(0, 0, 0, 0.2)',
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: '1px solid rgba(255, 255, 255, 0.05)',
                      }}
                      labelStyle={{
                        background: 'rgba(255, 255, 255, 0.02)',
                        color: '#999',
                        borderRight: '1px solid rgba(255, 255, 255, 0.05)',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                        fontSize: 12,
                      }}
                      contentStyle={{
                        color: '#fff',
                        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                        fontSize: 12,
                      }}
                    >
                      <Descriptions.Item label="System Source">
                        <Badge status="processing" text={<span style={{ color: '#52c41a', fontWeight: 'bold' }}>{verifyResult.metadata.source}</span>} />
                      </Descriptions.Item>
                      {verifyResult.metadata.project_number && (
                        <Descriptions.Item label="Project Ref">
                          {verifyResult.metadata.project_number}
                        </Descriptions.Item>
                      )}
                      {verifyResult.metadata.title && (
                        <Descriptions.Item label="File Title">
                          {verifyResult.metadata.title}
                        </Descriptions.Item>
                      )}
                      {verifyResult.metadata.export_format && (
                        <Descriptions.Item label="Export Format">
                          <Tag color="cyan" style={{ margin: 0 }}>{verifyResult.metadata.export_format.toUpperCase()}</Tag>
                        </Descriptions.Item>
                      )}
                      {verifyResult.metadata.features_count !== undefined && (
                        <Descriptions.Item label="GIS Elements">
                          {verifyResult.metadata.features_count} features
                        </Descriptions.Item>
                      )}
                      {verifyResult.metadata.uploaded_by && (
                        <Descriptions.Item label="Generated By">
                          {verifyResult.metadata.uploaded_by}
                        </Descriptions.Item>
                      )}
                      <Descriptions.Item label="Method">
                        <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#aaa' }}>
                          {verifyResult.verification_method}
                        </span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Confidence">
                        <span style={{ color: '#52c41a', fontWeight: 'bold' }}>
                          {(verifyResult.confidence * 100).toFixed(1)}%
                        </span>
                      </Descriptions.Item>
                    </Descriptions>

                    {verifyResult.registry_record && (
                      <Card
                        size="small"
                        title={<span style={{ color: '#e8e8e8', fontSize: 13, fontWeight: 600 }}>Provenance Timeline</span>}
                        style={{
                          background: 'rgba(0, 0, 0, 0.25)',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        <Timeline
                          mode="left"
                          style={{ marginTop: 12, marginLeft: 8 }}
                          items={[
                            {
                              color: 'green',
                              children: (
                                <div style={{ color: '#fff', fontSize: 11 }}>
                                  <div style={{ fontWeight: 'bold' }}>Asset Exported / Generated</div>
                                  <div style={{ color: '#aaa', fontSize: 10 }}>
                                    {new Date(verifyResult.registry_record.generated_at).toLocaleString()}
                                  </div>
                                  <div style={{ color: '#90b8d8', fontSize: 10 }}>
                                    By user: <strong>{verifyResult.registry_record.generated_by}</strong>
                                  </div>
                                  {verifyResult.registry_record.project_number && (
                                    <div style={{ color: '#888', fontSize: 10 }}>
                                      Project Context: <strong>{verifyResult.registry_record.project_number}</strong>
                                    </div>
                                  )}
                                </div>
                              ),
                            },
                            {
                              color: 'blue',
                              children: (
                                <div style={{ color: '#fff', fontSize: 11 }}>
                                  <div style={{ fontWeight: 'bold' }}>DNA Cryptographic Seal Applied</div>
                                  <div style={{ color: '#aaa', fontSize: 10 }}>
                                    DNA: <code style={{ fontSize: 9, color: '#1677ff' }}>{verifyResult.registry_record.dna_hash.slice(0, 16)}...</code>
                                  </div>
                                  {verifyResult.registry_record.file_hash && (
                                    <div style={{ color: '#aaa', fontSize: 10 }}>
                                      File Hash: <code style={{ fontSize: 9, color: '#722ed1' }}>{verifyResult.registry_record.file_hash.slice(0, 16)}...</code>
                                    </div>
                                  )}
                                </div>
                              ),
                            },
                            {
                              color: 'gold',
                              children: (
                                <div style={{ color: '#fff', fontSize: 11 }}>
                                  <div style={{ fontWeight: 'bold' }}>Local File Verified</div>
                                  <div style={{ color: '#aaa', fontSize: 10 }}>
                                    Method: <strong>{verifyResult.verification_method.replace(/_/g, ' ')}</strong>
                                  </div>
                                  <div style={{ color: '#52c41a', fontSize: 10, fontWeight: 'bold' }}>
                                    Confidence: {(verifyResult.confidence * 100).toFixed(1)}%
                                  </div>
                                </div>
                              ),
                            },
                          ]}
                        />
                      </Card>
                    )}
                  </div>
                ) : (
                  <Alert
                    message={
                      <span style={{ fontWeight: 'bold', color: '#faad14' }}>
                        No Watermark Detected
                      </span>
                    }
                    description="This file does not contain a digital watermark from this platform, or the signature could not be verified."
                    type="warning"
                    showIcon
                    icon={<WarningOutlined style={{ color: '#faad14' }} />}
                    style={{
                      background: 'rgba(250, 173, 20, 0.08)',
                      border: '1px solid rgba(250, 173, 20, 0.2)',
                    }}
                  />
                )}
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}
