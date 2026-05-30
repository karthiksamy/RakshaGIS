import { useState } from 'react'
import {
  Typography, Form, Select, Upload, Button, Table, Tag, Alert,
  Space, Divider, Card, Spin, Collapse, Descriptions, message, Tooltip,
} from 'antd'
import {
  UploadOutlined, EyeOutlined, ReloadOutlined, FileImageOutlined,
  AimOutlined, ExperimentOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UploadFile } from 'antd/es/upload/interface'
import api from '@/services/api'

const { Title, Text, Paragraph } = Typography

interface ExtractionJob {
  id: number
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  vision_model: string
  parsed_result: any
  draft_features: any[]
  raw_response: string
  error_log: string
  created_at: string
  completed_at: string | null
  parcel_count?: number
}

interface MapInfo {
  title?: string
  scale?: string
  district?: string
  taluk?: string
  village?: string
  date?: string
  surveyor?: string
  north_arrow?: string
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'default', RUNNING: 'processing', DONE: 'success', FAILED: 'error',
}

export default function BoundaryExtractionPage() {
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [selectedProject, setSelectedProject] = useState<number | null>(null)
  const [pollingJobId, setPollingJobId] = useState<number | null>(null)

  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/?page_size=100').then(r => r.data.results ?? r.data),
  })

  const { data: visionModels = [] } = useQuery<string[]>({
    queryKey: ['vision-models'],
    queryFn: () =>
      api.get('/ai/tasks/health/').then(r => {
        const base = r.data?.ollama_available ? [] : []
        return [...base, 'llava:7b', 'llava:13b', 'llava-llama3:8b', 'moondream:latest', 'minicpm-v:latest']
      }).catch(() => ['llava:7b', 'llava:13b', 'moondream:latest']),
  })

  const { data: jobs = [], isLoading: jobsLoading } = useQuery<ExtractionJob[]>({
    queryKey: ['extraction-jobs', selectedProject],
    queryFn: () =>
      selectedProject
        ? api.get(`/ai/vision/list/${selectedProject}/`).then(r => r.data)
        : Promise.resolve([]),
    enabled: !!selectedProject,
    refetchInterval: (q) =>
      (q.state.data as ExtractionJob[] | undefined)?.some(j => j.status === 'PENDING' || j.status === 'RUNNING')
        ? 3000 : false,
  })

  const { data: pollingJob } = useQuery<ExtractionJob>({
    queryKey: ['extraction-job', pollingJobId],
    queryFn: () => api.get(`/ai/vision/status/${pollingJobId}/`).then(r => r.data),
    enabled: !!pollingJobId,
    refetchInterval: (q) => {
      const d = q.state.data as ExtractionJob | undefined
      return d && (d.status === 'PENDING' || d.status === 'RUNNING') ? 3000 : false
    },
  })

  const submit = useMutation({
    mutationFn: (fd: FormData) => api.post('/ai/vision/submit/', fd),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['extraction-jobs', selectedProject] })
      setPollingJobId(res.data.job_id)
      setFileList([])
      form.resetFields(['image', 'source_document_id'])
      message.success('Extraction job submitted — processing with vision model…')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Submission failed'),
  })

  const embedProject = useMutation({
    mutationFn: () =>
      api.post(`/ai/rag/embed-project/${selectedProject}/`, { embed_model: 'nomic-embed-text' }),
    onSuccess: (r) => message.success(`Queued ${r.data.queued} document(s) for embedding (RAG)`),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Embedding failed'),
  })

  const exportTraining = useMutation({
    mutationFn: () => api.post(`/ai/vision/export-training/${selectedProject}/`),
    onSuccess: () => message.success('Training dataset export queued'),
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Export failed'),
  })

  function onFinish(values: any) {
    if (!selectedProject) { message.error('Select a project'); return }
    if (!fileList.length && !values.source_document_id) {
      message.error('Provide a scanned map image or select an existing document')
      return
    }
    const fd = new FormData()
    fd.append('project_id', String(selectedProject))
    fd.append('vision_model', values.vision_model || 'llava:7b')
    if (fileList[0]?.originFileObj) fd.append('image', fileList[0].originFileObj)
    if (values.source_document_id) fd.append('source_document_id', values.source_document_id)
    submit.mutate(fd)
  }

  const activeJob = pollingJob ?? jobs.find(j => j.id === pollingJobId)

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <Title level={4} style={{ marginBottom: 4 }}>
        <ExperimentOutlined style={{ marginRight: 8, color: '#4fc3f7' }} />
        AI Vision — Map Boundary Extraction
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 20 }}>
        Upload scanned paper survey maps. The local vision LLM (LLaVA / Ollama) analyses
        the image and extracts parcel survey numbers, areas, shapes, and map metadata —
        fully offline, nothing leaves the server.
      </Paragraph>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="Vision model required"
        description={
          <>
            Pull a vision model first: <code>ollama pull llava:7b</code> (4.7 GB) or
            <code> moondream:latest</code> (850 MB — faster, lower detail).
            The model runs entirely on-premise.
          </>
        }
      />

      <Card size="small" style={{ marginBottom: 24 }}>
        <Form form={form} layout="vertical" onFinish={onFinish}
          initialValues={{ vision_model: 'llava:7b' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Form.Item label="Project" required>
              <Select
                placeholder="Select project"
                options={projects.map((p: any) => ({ value: p.id, label: p.project_number || p.name }))}
                value={selectedProject}
                onChange={setSelectedProject}
              />
            </Form.Item>
            <Form.Item name="vision_model" label="Vision Model" rules={[{ required: true }]}>
              <Select options={visionModels.map(m => ({ value: m, label: m }))} />
            </Form.Item>
          </div>

          <Form.Item label="Scanned Map Image (.jpg / .png / .tif)" required={!form.getFieldValue('source_document_id')}>
            <Upload
              fileList={fileList}
              beforeUpload={(f) => { setFileList([f as any]); return false }}
              onRemove={() => setFileList([])}
              accept=".jpg,.jpeg,.png,.tif,.tiff,.bmp"
              maxCount={1}
            >
              <Button icon={<UploadOutlined />}>Select image</Button>
            </Upload>
          </Form.Item>

          <Space>
            <Button type="primary" htmlType="submit" loading={submit.isPending}
              icon={<EyeOutlined />} disabled={!selectedProject || !fileList.length}>
              Extract Boundaries
            </Button>
            <Tooltip title="Embed all processed documents for RAG (context-aware AI chat)">
              <Button icon={<AimOutlined />} loading={embedProject.isPending}
                disabled={!selectedProject} onClick={() => embedProject.mutate()}>
                Embed Docs for RAG
              </Button>
            </Tooltip>
            <Tooltip title="Export training JSONL for local fine-tuning">
              <Button icon={<ExperimentOutlined />} loading={exportTraining.isPending}
                disabled={!selectedProject} onClick={() => exportTraining.mutate()}>
                Export Training Data
              </Button>
            </Tooltip>
          </Space>
        </Form>
      </Card>

      {/* Active job result */}
      {activeJob && (
        <Card
          size="small"
          style={{ marginBottom: 24, borderColor: activeJob.status === 'DONE' ? '#52c41a' : undefined }}
          title={
            <Space>
              <Tag color={STATUS_COLOR[activeJob.status]}>{activeJob.status}</Tag>
              <Text>Job #{activeJob.id} — {activeJob.vision_model}</Text>
              {(activeJob.status === 'PENDING' || activeJob.status === 'RUNNING') && <Spin size="small" />}
            </Space>
          }
        >
          {activeJob.status === 'DONE' && activeJob.parsed_result && (
            <>
              <MapInfoPanel info={activeJob.parsed_result.map_info} />
              <Divider style={{ margin: '12px 0' }}>
                Detected Parcels ({activeJob.draft_features.length})
              </Divider>
              <ParcelTable parcels={activeJob.draft_features} />

              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message="Georeferencing required"
                description="Extracted parcels have no coordinates yet — geometry is null. Open the Map and manually draw features using this data as reference, or use the QGIS integration to georeference the scanned image."
              />

              <Collapse ghost style={{ marginTop: 8 }}>
                <Collapse.Panel header="Raw model response" key="raw">
                  <pre style={{ fontSize: 11, color: '#888', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                    {activeJob.raw_response}
                  </pre>
                </Collapse.Panel>
              </Collapse>
            </>
          )}
          {activeJob.status === 'FAILED' && (
            <Alert type="error" message={activeJob.error_log || 'Extraction failed'} showIcon />
          )}
          {activeJob.status === 'RUNNING' && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
              <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                Vision model is analysing the image… this may take 2–5 minutes.
              </div>
            </div>
          )}
        </Card>
      )}

      <Divider>Extraction History</Divider>
      <Table
        rowKey="id"
        loading={jobsLoading}
        dataSource={jobs}
        size="small"
        pagination={{ pageSize: 10 }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 60 },
          { title: 'Status', dataIndex: 'status', width: 110,
            render: (s: string) => <Tag color={STATUS_COLOR[s]}>{s}</Tag> },
          { title: 'Model', dataIndex: 'vision_model', width: 160 },
          { title: 'Parcels', dataIndex: 'parcel_count', width: 80, render: (v: number) => v ?? '—' },
          { title: 'Created', dataIndex: 'created_at', width: 150,
            render: (v: string) => new Date(v).toLocaleString() },
          { title: '',  width: 70,
            render: (_: any, r: ExtractionJob) => (
              <Button size="small" icon={<ReloadOutlined />} onClick={() => setPollingJobId(r.id)}>
                View
              </Button>
            )},
        ]}
      />
    </div>
  )
}

function MapInfoPanel({ info }: { info?: MapInfo }) {
  if (!info) return null
  const items = Object.entries(info).filter(([, v]) => v)
  if (!items.length) return null
  return (
    <Descriptions size="small" bordered column={2} title="Map Information">
      {items.map(([k, v]) => (
        <Descriptions.Item key={k} label={k.replace(/_/g, ' ')}>
          {String(v)}
        </Descriptions.Item>
      ))}
    </Descriptions>
  )
}

function ParcelTable({ parcels }: { parcels: any[] }) {
  if (!parcels.length) return <Text type="secondary">No parcels detected.</Text>
  return (
    <Table
      rowKey={(r, i) => String(i)}
      dataSource={parcels}
      size="small"
      pagination={false}
      columns={[
        { title: 'Survey No.', dataIndex: ['properties', 'survey_number'], width: 110 },
        { title: 'Area', dataIndex: ['properties', 'area_text'], width: 100 },
        { title: 'Shape', dataIndex: ['properties', 'shape'], width: 110 },
        { title: 'Owner text', dataIndex: ['properties', 'owner_text'], ellipsis: true },
        { title: 'Notes', dataIndex: ['properties', 'notes'], ellipsis: true },
        { title: 'Adjacent', dataIndex: ['properties', 'adjacent_surveys'],
          render: (v: string[]) => v?.join(', ') || '—' },
      ]}
    />
  )
}
