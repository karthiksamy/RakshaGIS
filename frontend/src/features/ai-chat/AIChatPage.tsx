import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Layout, List, Button, Input, Typography, Spin, Space, Card, message,
  Modal, Alert, Tag, Upload, Tooltip, Badge, Select,
} from 'antd'
import {
  PlusOutlined, SendOutlined, RobotOutlined, UserOutlined,
  PaperClipOutlined, WarningOutlined, CheckCircleOutlined,
  LoadingOutlined, FileOutlined, CloseOutlined, AimOutlined,
  BookOutlined,
} from '@ant-design/icons'
import type { UploadFile } from 'antd'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { ChatSession, ChatMessage } from '@/types'

const { Sider, Content } = Layout

const ALLOWED_EXTENSIONS = ['.geojson', '.json', '.kml', '.gpkg', '.zip', '.csv']
const POLL_INTERVAL_MS = 2500

interface GISPreviewResult {
  upload_id: string
  filename: string
  sensitive_fields: string[]
}

interface IndexingStatus {
  taskId: number
  filename: string
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
}

export default function AIChatPage() {
  const qc = useQueryClient()
  const [activeSession, setActiveSession] = useState<number | null>(null)
  const [inputText, setInputText] = useState('')
  const [ragProjectId, setRagProjectId] = useState<number | null>(null)
  const [lastRagSources, setLastRagSources] = useState<any[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // GIS file upload state
  const [uploadingPreview, setUploadingPreview] = useState(false)
  const [preview, setPreview] = useState<GISPreviewResult | null>(null)
  const [sensitiveWarningOpen, setSensitiveWarningOpen] = useState(false)
  const [indexingTasks, setIndexingTasks] = useState<IndexingStatus[]>([])
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data: sessions, isLoading: sessionsLoading } = useQuery<ChatSession[]>({
    queryKey: qk.chatSessions(),
    queryFn: () => api.get('/ai/chat/').then((r) => r.data.results ?? r.data),
  })

  const { data: session, refetch: refetchSession } = useQuery<ChatSession>({
    queryKey: qk.chatSession(activeSession!),
    queryFn: () => api.get(`/ai/chat/${activeSession}/`).then((r) => r.data),
    enabled: !!activeSession,
  })

  const createSession = useMutation({
    mutationFn: () => api.post('/ai/chat/', { title: 'New Chat' }).then((r) => r.data),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: qk.chatSessions() })
      setActiveSession(s.id)
    },
  })

  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/?page_size=100').then(r => r.data.results ?? r.data),
  })

  const { data: ragStatus } = useQuery<any>({
    queryKey: ['rag-status', ragProjectId],
    queryFn: () =>
      ragProjectId
        ? api.get(`/ai/rag/embed-status/${ragProjectId}/`).then(r => r.data)
        : Promise.resolve(null),
    enabled: !!ragProjectId,
    refetchInterval: 15000,
  })

  const sendMessage = useMutation({
    mutationFn: (msg: string) =>
      api.post(`/ai/chat/${activeSession}/chat/`, {
        message: msg,
        ...(ragProjectId ? { project_id: ragProjectId } : {}),
      }).then((r) => r.data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: qk.chatSession(activeSession!) })
      setInputText('')
      if (data?.rag_sources?.length) setLastRagSources(data.rag_sources)
      else setLastRagSources([])
    },
    onError: (err: any) => {
      const detail = err?.response?.data?.detail || 'AI service unavailable'
      message.error({ content: detail, duration: 6 })
    },
  })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages])

  // Poll in-progress indexing tasks
  const pollIndexingTasks = useCallback(() => {
    const inFlight = indexingTasks.filter((t) => t.status === 'PENDING' || t.status === 'RUNNING')
    if (inFlight.length === 0) return

    inFlight.forEach((t) => {
      api.get(`/ai/tasks/${t.taskId}/`).then((r) => {
        const newStatus: IndexingStatus['status'] = r.data.status
        setIndexingTasks((prev) =>
          prev.map((x) => (x.taskId === t.taskId ? { ...x, status: newStatus } : x))
        )
        if (newStatus === 'DONE') {
          message.success(`GIS file "${t.filename}" indexed — AI now has context.`)
          refetchSession()
        } else if (newStatus === 'FAILED') {
          message.error(`GIS indexing failed for "${t.filename}".`)
        }
      }).catch(() => {})
    })
  }, [indexingTasks, refetchSession])

  useEffect(() => {
    const active = indexingTasks.some((t) => t.status === 'PENDING' || t.status === 'RUNNING')
    if (!active) {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      return
    }
    pollTimerRef.current = setInterval(pollIndexingTasks, POLL_INTERVAL_MS)
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current) }
  }, [indexingTasks, pollIndexingTasks])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      message.error(`File type "${ext}" not supported. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
      return
    }

    const formData = new FormData()
    formData.append('file', file)
    setUploadingPreview(true)

    api.post('/ai/tasks/index-gis/preview/', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then((r) => {
      const result: GISPreviewResult = r.data
      setPreview(result)
      if (result.sensitive_fields.length > 0) {
        setSensitiveWarningOpen(true)
      } else {
        confirmIndexing(result)
      }
    }).catch((err) => {
      message.error(err?.response?.data?.detail || 'Upload failed')
    }).finally(() => setUploadingPreview(false))
  }

  function confirmIndexing(result: GISPreviewResult) {
    setSensitiveWarningOpen(false)
    api.post('/ai/tasks/index-gis/confirm/', {
      upload_id: result.upload_id,
      filename: result.filename,
      session_id: activeSession,
    }).then((r) => {
      const taskId: number = r.data.task_id
      setIndexingTasks((prev) => [
        ...prev,
        { taskId, filename: result.filename, status: 'PENDING' },
      ])
      message.info(`Indexing "${result.filename}"…`)
      setPreview(null)
    }).catch((err) => message.error(err?.response?.data?.detail || 'Failed to queue indexing'))
  }

  const msgs = session?.messages ?? []
  const activeIndexing = indexingTasks.filter((t) => t.status === 'PENDING' || t.status === 'RUNNING')

  return (
    <Layout style={{ height: '100%' }}>
      {/* Session list */}
      <Sider width={240} style={{ background: '#0a0a1a', borderRight: '1px solid #1a1a2e', padding: 12 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          block
          size="small"
          onClick={() => createSession.mutate()}
          loading={createSession.isPending}
          style={{ marginBottom: 12 }}
        >
          New Chat
        </Button>
        {sessionsLoading ? (
          <Spin size="small" />
        ) : (
          <List
            dataSource={sessions}
            renderItem={(s) => (
              <List.Item
                onClick={() => setActiveSession(s.id)}
                style={{
                  cursor: 'pointer',
                  padding: '6px 8px',
                  borderRadius: 4,
                  background: activeSession === s.id ? '#1a2a4a' : 'transparent',
                  border: 'none',
                  color: '#ccc',
                  fontSize: 13,
                }}
              >
                {s.title}
              </List.Item>
            )}
          />
        )}
      </Sider>

      {/* Chat area */}
      <Content style={{ display: 'flex', flexDirection: 'column', background: '#0e0e1e' }}>
        {!activeSession ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555' }}>
            <Space direction="vertical" align="center">
              <RobotOutlined style={{ fontSize: 48 }} />
              <Typography.Text type="secondary">Select or create a chat session</Typography.Text>
            </Space>
          </div>
        ) : (
          <>
            {/* Indexing status bar */}
            {activeIndexing.length > 0 && (
              <div style={{
                padding: '6px 16px', background: '#0a1520', borderBottom: '1px solid #1a2a4a',
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                <LoadingOutlined style={{ color: '#4fc3f7' }} />
                <span style={{ color: '#4fc3f7', fontSize: 12 }}>Indexing GIS files:</span>
                {activeIndexing.map((t) => (
                  <Tag key={t.taskId} color="processing" icon={<LoadingOutlined />} style={{ fontSize: 11 }}>
                    {t.filename}
                  </Tag>
                ))}
              </div>
            )}

            {/* Done/failed indexing badges */}
            {indexingTasks.filter((t) => t.status === 'DONE' || t.status === 'FAILED').length > 0 && (
              <div style={{
                padding: '4px 16px', background: '#050a10', borderBottom: '1px solid #1a2a4a',
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              }}>
                <span style={{ color: '#666', fontSize: 11 }}>Indexed:</span>
                {indexingTasks.filter((t) => t.status === 'DONE').map((t) => (
                  <Tag key={t.taskId} color="success" icon={<CheckCircleOutlined />} style={{ fontSize: 11 }}>
                    {t.filename}
                  </Tag>
                ))}
                {indexingTasks.filter((t) => t.status === 'FAILED').map((t) => (
                  <Tag key={t.taskId} color="error" style={{ fontSize: 11 }}>
                    {t.filename} (failed)
                  </Tag>
                ))}
                <Button
                  size="small" type="text" icon={<CloseOutlined />}
                  style={{ color: '#555', fontSize: 10 }}
                  onClick={() => setIndexingTasks((prev) => prev.filter((t) => t.status !== 'DONE' && t.status !== 'FAILED'))}
                />
              </div>
            )}

            {/* Messages */}
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {msgs.map((msg) => {
                const isGisContext = msg.content.startsWith('[GIS File Context')
                return (
                  <div
                    key={msg.id}
                    style={{
                      display: 'flex',
                      gap: 10,
                      marginBottom: 16,
                      flexDirection: msg.role === 'USER' ? 'row-reverse' : 'row',
                    }}
                  >
                    <div
                      style={{
                        width: 28, height: 28, borderRadius: '50%',
                        background: msg.role === 'USER' ? '#1565c0' : '#1a3a1a',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}
                    >
                      {msg.role === 'USER' ? (
                        isGisContext
                          ? <FileOutlined style={{ fontSize: 14, color: '#ffb74d' }} />
                          : <UserOutlined style={{ fontSize: 14, color: '#90caf9' }} />
                      ) : (
                        <RobotOutlined style={{ fontSize: 14, color: '#81c784' }} />
                      )}
                    </div>
                    <Card
                      size="small"
                      style={{
                        maxWidth: '75%',
                        background: isGisContext ? '#1a1200'
                          : msg.role === 'USER' ? '#0d2244' : '#0d1a0d',
                        border: `1px solid ${isGisContext ? '#4a3a00'
                          : msg.role === 'USER' ? '#1a3a6a' : '#1a3a1a'}`,
                      }}
                      styles={{ body: { padding: '8px 12px' } }}
                    >
                      {isGisContext && (
                        <div style={{ color: '#ffb74d', fontSize: 10, marginBottom: 4 }}>
                          <FileOutlined style={{ marginRight: 4 }} />GIS CONTEXT
                        </div>
                      )}
                      <Typography.Text
                        style={{
                          color: '#e8e8e8', whiteSpace: 'pre-wrap', fontSize: 12,
                          fontFamily: isGisContext ? 'monospace' : undefined,
                        }}
                      >
                        {isGisContext ? msg.content.replace(/^\[GIS File Context[^\]]*\]\n/, '') : msg.content}
                      </Typography.Text>
                    </Card>
                  </div>
                )
              })}
              {sendMessage.isPending && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1a3a1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <RobotOutlined style={{ fontSize: 14, color: '#81c784' }} />
                  </div>
                  <Card size="small" style={{ background: '#0d1a0d', border: '1px solid #1a3a1a' }} styles={{ body: { padding: '8px 12px' } }}>
                    <Spin size="small" />
                  </Card>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* RAG project selector */}
            <div style={{ padding: '6px 12px', borderTop: '1px solid #1a1a2e', background: '#0a0a18', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <AimOutlined style={{ color: '#4fc3f7', fontSize: 12 }} />
              <span style={{ color: '#666', fontSize: 11 }}>RAG context:</span>
              <Select
                size="small"
                allowClear
                placeholder="No project (general chat)"
                style={{ width: 200 }}
                value={ragProjectId}
                onChange={setRagProjectId}
                options={projects.map((p: any) => ({ value: p.id, label: p.project_number || p.name }))}
              />
              {ragStatus && (
                <Tag
                  color={ragStatus.rag_ready ? 'green' : ragStatus.total_chunks > 0 ? 'orange' : 'default'}
                  icon={ragStatus.rag_ready ? <CheckCircleOutlined /> : undefined}
                  style={{ fontSize: 10 }}
                >
                  {ragStatus.rag_ready
                    ? `${ragStatus.total_chunks} chunks ready`
                    : ragStatus.pending_tasks > 0
                    ? `Embedding ${ragStatus.pending_tasks} docs…`
                    : 'No embeddings — go to Vision page → Embed Docs'}
                </Tag>
              )}
              {lastRagSources.length > 0 && (
                <Tooltip title={lastRagSources.map((s: any) => `${s.doc_title} (chunk ${s.chunk_index})`).join('\n')}>
                  <Tag color="blue" icon={<BookOutlined />} style={{ fontSize: 10, cursor: 'help' }}>
                    {lastRagSources.length} source{lastRagSources.length !== 1 ? 's' : ''} used
                  </Tag>
                </Tooltip>
              )}
            </div>

            {/* Input */}
            <div style={{ padding: 12, borderTop: '1px solid #1a1a2e' }}>
              <Input.TextArea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onPressEnter={(e) => {
                  if (!e.shiftKey && inputText.trim()) {
                    e.preventDefault()
                    sendMessage.mutate(inputText.trim())
                  }
                }}
                placeholder="Ask about GIS data, survey projects, or defence lands… (Enter to send)"
                autoSize={{ minRows: 1, maxRows: 4 }}
                style={{ resize: 'none', background: '#141424', borderColor: '#2a2a4a', color: '#e8e8e8' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <Tooltip title={`Attach GIS file (${ALLOWED_EXTENSIONS.join(', ')})`}>
                  <Button
                    size="small"
                    icon={uploadingPreview ? <LoadingOutlined /> : <PaperClipOutlined />}
                    style={{ color: '#aaa', borderColor: '#2a2a4a', background: 'transparent' }}
                    loading={uploadingPreview}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Attach GIS
                  </Button>
                </Tooltip>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ALLOWED_EXTENSIONS.join(',')}
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  size="small"
                  onClick={() => inputText.trim() && sendMessage.mutate(inputText.trim())}
                  loading={sendMessage.isPending}
                  disabled={!inputText.trim()}
                >
                  Send
                </Button>
              </div>
            </div>
          </>
        )}
      </Content>

      {/* Sensitive data warning modal */}
      <Modal
        title={<><WarningOutlined style={{ color: '#ff9800', marginRight: 8 }} />Sensitive Data Detected</>}
        open={sensitiveWarningOpen}
        onOk={() => preview && confirmIndexing(preview)}
        onCancel={() => { setSensitiveWarningOpen(false); setPreview(null) }}
        okText="Yes, index anyway"
        okButtonProps={{ danger: true }}
        cancelText="Cancel"
        width={480}
        styles={{ body: { background: '#0e0e1e' } }}
      >
        <Alert
          type="warning"
          showIcon
          message="Potential PII / sensitive fields found"
          description={
            <div>
              <p style={{ marginBottom: 8 }}>
                The file <strong>{preview?.filename}</strong> contains fields that may hold personally identifiable information:
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                {preview?.sensitive_fields.map((f) => (
                  <Tag key={f} color="orange">{f}</Tag>
                ))}
              </div>
              <p style={{ margin: 0, color: '#ccc', fontSize: 12 }}>
                This data will be sent to the local AI model for context. If this contains real PII,
                ensure you have appropriate authorisation before proceeding.
              </p>
            </div>
          }
          style={{ background: '#1a1000', border: '1px solid #4a3800' }}
        />
      </Modal>
    </Layout>
  )
}
