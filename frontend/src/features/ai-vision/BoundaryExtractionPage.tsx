import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Typography, Form, Select, Upload, Button, Table, Tag, Alert,
  Space, Divider, Card, Spin, Collapse, Descriptions, message,
  Tooltip, Modal, Input, Radio, Checkbox, Slider, Switch,
  Tabs, InputNumber, Progress,
} from 'antd'
import {
  UploadOutlined, EyeOutlined, ReloadOutlined, FileImageOutlined,
  AimOutlined, ExperimentOutlined, SaveOutlined, PlusOutlined,
  CheckSquareOutlined, GlobalOutlined, PartitionOutlined,
  ThunderboltOutlined, SettingOutlined, EditOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UploadFile } from 'antd/es/upload/interface'
import api from '@/services/api'

const { Title, Text, Paragraph } = Typography

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractionJob {
  id: number
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  vision_model: string
  parsed_result: any
  draft_features: GeoFeature[]
  raw_response: string
  error_log: string
  created_at: string
  completed_at: string | null
}

interface GeoFeature {
  type: 'Feature'
  geometry: { type: string; coordinates: any } | null
  properties: Record<string, any>
}

interface GeoTiffLayer { id: number; name: string; status: string; created_at: string }
interface SurveyArea   { id: number; name: string; area_code: string; status: string }

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'default', RUNNING: 'processing', DONE: 'success', FAILED: 'error',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BoundaryExtractionPage() {
  const qc       = useQueryClient()
  const navigate = useNavigate()
  const [form]     = Form.useForm()
  const [saveForm] = Form.useForm()

  // Common state
  const [selectedProject, setSelectedProject]   = useState<number | null>(null)
  const [pollingJobId, setPollingJobId]          = useState<number | null>(null)
  const [extractMode, setExtractMode]            = useState<'classical' | 'vision' | 'pipeline'>('classical')

  // AI Vision mode
  const [fileList, setFileList]             = useState<UploadFile[]>([])
  const [selectedGeotiff, setSelectedGeotiff] = useState<number | null>(null)
  const [visionSourceMode, setVisionSourceMode] = useState<'scan' | 'geotiff'>('geotiff')

  // Classical GIS mode
  const [edgeSensitivity,   setEdgeSensitivity]   = useState(0.3)
  const [minAreaM2,         setMinAreaM2]          = useState(500)
  const [dilationPx,        setDilationPx]         = useState(3)
  const [simplifyTol,       setSimplifyTol]        = useState(0.00005)
  const [aiLabel,           setAiLabel]            = useState(false)
  const [classicalGeotiff,  setClassicalGeotiff]   = useState<number | null>(null)

  // AI Pipeline mode
  const [pipelineGeotiff,   setPipelineGeotiff]    = useState<number | null>(null)
  const [pipelineTileSize,  setPipelineTileSize]   = useState<number>(1024)

  // Save modal
  const [saveOpen,        setSaveOpen]         = useState(false)
  const [saveJobId,       setSaveJobId]        = useState<number | null>(null)
  const [saveDraft,       setSaveDraft]        = useState<GeoFeature[]>([])
  const [selectedFeatIdx, setSelectedFeatIdx]  = useState<number[]>([])
  const [areaMode,        setAreaMode]         = useState<'existing' | 'new'>('existing')
  const [saving,          setSaving]           = useState(false)

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: projects = [] } = useQuery<any[]>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/?page_size=100').then(r => r.data.results ?? r.data),
  })

  const { data: ollamaHealth } = useQuery<any>({
    queryKey: ['ollama-health'],
    queryFn: () => api.get('/ai/tasks/health/').then(r => r.data),
    refetchInterval: 15000,
  })

  const { data: visionModels = [] } = useQuery<string[]>({
    queryKey: ['vision-models-installed'],
    queryFn: () => api.get('/ai/vision/list-vision-models/').then(r => r.data?.models ?? []).catch(() => []),
    refetchInterval: 15000,
  })

  // AI compute mode — vision pipelines require GPU; classical runs on CPU or GPU.
  const { data: capabilities } = useQuery<any>({
    queryKey: ['ai-vision-capabilities'],
    queryFn: () => api.get('/ai/vision/capabilities/').then(r => r.data).catch(() => null),
    refetchInterval: 30000,
  })
  const gpuEnabled = capabilities?.gpu_enabled ?? false

  // In CPU mode the vision pipelines are unavailable — keep the user on classical.
  useEffect(() => {
    if (!gpuEnabled && (extractMode === 'vision' || extractMode === 'pipeline')) {
      setExtractMode('classical')
    }
  }, [gpuEnabled, extractMode])

  useEffect(() => {
    if (visionModels.length > 0) {
      const current = form.getFieldValue('vision_model')
      if (!visionModels.includes(current)) form.setFieldValue('vision_model', visionModels[0])
    }
  }, [visionModels])

  const { data: geotiffLayers = [] } = useQuery<GeoTiffLayer[]>({
    queryKey: ['geotiffs-for-vision', selectedProject],
    queryFn: () =>
      api.get('/projects/geotiffs/', { params: { project: selectedProject, page_size: 100 } })
        .then(r => r.data.results ?? r.data),
    enabled: !!selectedProject,
  })

  const { data: surveyAreas = [] } = useQuery<SurveyArea[]>({
    queryKey: ['survey-areas-save', selectedProject],
    queryFn: () =>
      api.get('/projects/survey-areas/', { params: { project: selectedProject, page_size: 200 } })
        .then(r => r.data.results ?? r.data),
    enabled: !!selectedProject && saveOpen,
  })

  const { data: jobs = [], isLoading: jobsLoading } = useQuery<ExtractionJob[]>({
    queryKey: ['extraction-jobs', selectedProject],
    queryFn: () =>
      selectedProject
        ? api.get(`/ai/vision/list/${selectedProject}/`).then(r => r.data)
        : Promise.resolve([]),
    enabled: !!selectedProject,
    refetchInterval: q =>
      (q.state.data as ExtractionJob[] | undefined)?.some(
        j => j.status === 'PENDING' || j.status === 'RUNNING'
      ) ? 3000 : false,
  })

  const { data: pollingJob } = useQuery<ExtractionJob>({
    queryKey: ['extraction-job', pollingJobId],
    queryFn: () => api.get(`/ai/vision/status/${pollingJobId}/`).then(r => r.data),
    enabled: !!pollingJobId,
    refetchInterval: q => {
      const d = q.state.data as ExtractionJob | undefined
      return d && (d.status === 'PENDING' || d.status === 'RUNNING') ? 3000 : false
    },
  })

  // After a Classical extraction completes, redirect to the dedicated review/edit
  // viewer so the user can validate and correct the polygons before saving.
  const redirectedJobRef = useRef<number | null>(null)
  useEffect(() => {
    const j = pollingJob
    if (!j || j.status !== 'DONE') return
    const isClassicalJob = j.parsed_result?.source === 'classical_gis'
    const hasGeo = j.draft_features?.some(f => f.geometry)
    if (isClassicalJob && hasGeo && redirectedJobRef.current !== j.id) {
      redirectedJobRef.current = j.id
      message.success('Extraction complete — opening boundary review…')
      setTimeout(() => navigate(`/boundary-review/${j.id}`), 700)
    }
  }, [pollingJob, navigate])

  // ── Submit ─────────────────────────────────────────────────────────────────

  const submitVision = useMutation({
    mutationFn: (fd: FormData) => api.post('/ai/vision/submit/', fd),
    onSuccess: res => {
      qc.invalidateQueries({ queryKey: ['extraction-jobs', selectedProject] })
      setPollingJobId(res.data.job_id)
      setFileList([])
      setSelectedGeotiff(null)
      message.success('Vision extraction queued — model is analysing the image…')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Submission failed'),
  })

  const submitClassical = useMutation({
    mutationFn: (body: Record<string, any>) => api.post('/ai/vision/extract-classical/', body),
    onSuccess: res => {
      qc.invalidateQueries({ queryKey: ['extraction-jobs', selectedProject] })
      setPollingJobId(res.data.job_id)
      message.success('Classical GIS extraction queued…')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Extraction failed'),
  })

  const submitPipeline = useMutation({
    mutationFn: (body: Record<string, any>) => api.post('/ai/vision/extract-pipeline/', body),
    onSuccess: res => {
      qc.invalidateQueries({ queryKey: ['extraction-jobs', selectedProject] })
      setPollingJobId(res.data.job_id)
      message.success('AI Vision Pipeline extraction queued…')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Pipeline extraction failed'),
  })

  function onSubmitClassical() {
    if (!selectedProject)    { message.error('Select a project'); return }
    if (!classicalGeotiff)   { message.error('Select a GeoTiff layer'); return }
    submitClassical.mutate({
      project_id:         selectedProject,
      source_geotiff_id:  classicalGeotiff,
      edge_sensitivity:   edgeSensitivity,
      min_area_m2:        minAreaM2,
      dilation_px:        dilationPx,
      simplify_tolerance: simplifyTol,
      ai_label:           aiLabel,
      vision_model:       form.getFieldValue('vision_model') || 'llava:7b',
    })
  }

  function onSubmitPipeline() {
    if (!selectedProject)   { message.error('Select a project'); return }
    if (!pipelineGeotiff)   { message.error('Select a GeoTiff layer'); return }
    submitPipeline.mutate({
      project_id:         selectedProject,
      source_geotiff_id:  pipelineGeotiff,
      tile_size:          pipelineTileSize,
      edge_sensitivity:   edgeSensitivity,
      min_area_m2:        minAreaM2,
      dilation_px:        dilationPx,
      simplify_tolerance: simplifyTol,
      vision_model:       form.getFieldValue('vision_model') || 'llava:7b',
    })
  }

  function onSubmitVision(values: any) {
    if (!selectedProject) { message.error('Select a project'); return }
    if (visionSourceMode === 'scan' && !fileList.length && !values.source_document_id) {
      message.error('Provide a scanned map image'); return
    }
    if (visionSourceMode === 'geotiff' && !selectedGeotiff) {
      message.error('Select a GeoTiff layer'); return
    }
    const fd = new FormData()
    fd.append('project_id',   String(selectedProject))
    fd.append('vision_model', values.vision_model || 'llava:7b')
    if (visionSourceMode === 'geotiff') {
      fd.append('source_geotiff_id', String(selectedGeotiff))
    } else {
      if (fileList[0]?.originFileObj) fd.append('image', fileList[0].originFileObj)
    }
    submitVision.mutate(fd)
  }

  // ── Save to survey area ────────────────────────────────────────────────────

  function openSaveModal(job: ExtractionJob) {
    const withCoords = job.draft_features.filter(f => f.geometry !== null)
    if (!withCoords.length) { message.warning('No georeferenced features to save'); return }
    setSaveJobId(job.id)
    setSaveDraft(withCoords)
    setSelectedFeatIdx(withCoords.map((_, i) => i))
    setAreaMode('existing')
    saveForm.resetFields()
    setSaveOpen(true)
  }

  async function handleSave(values: any) {
    if (!saveJobId) return
    setSaving(true)
    try {
      const body: Record<string, any> = {
        layer_name: values.layer_name,
        feature_indices: selectedFeatIdx,
      }
      if (areaMode === 'existing') body.survey_area_id = values.survey_area_id
      else                          body.new_area_name  = values.new_area_name
      const res = await api.post(`/ai/vision/accept-features/${saveJobId}/`, body)
      message.success(
        `Saved ${res.data.created} polygon(s) to "${res.data.survey_area_name}"`, 4
      )
      setSaveOpen(false)
      qc.invalidateQueries({ queryKey: ['extraction-jobs', selectedProject] })
      if (res.data.project_id) setTimeout(() => navigate(`/map?project=${res.data.project_id}`), 600)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const activeJob = pollingJob ?? jobs.find(j => j.id === pollingJobId)
  const isClassical = (job: ExtractionJob) => job.parsed_result?.source === 'classical_gis'
  const isPipeline  = (job: ExtractionJob) => job.parsed_result?.source === 'ai_vision_pipeline'
  const isGeoTiff   = (job: ExtractionJob) =>
    job.parsed_result?.source === 'geotiff' || isClassical(job) || isPipeline(job) ||
    job.draft_features?.some(f => f.geometry !== null)

  const geotiffOptions = geotiffLayers
    .filter(g => g.status === 'DONE')
    .map(g => ({ value: g.id, label: g.name }))

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <Title level={4} style={{ marginBottom: 4 }}>
        <PartitionOutlined style={{ marginRight: 8, color: '#4fc3f7' }} />
        GeoTiff Polygon Extraction
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Automatically extract land parcel polygons from GeoTiff drone/satellite images —
        replacing manual QGIS polygon drawing. Choose between the deterministic
        <strong> Classical GIS pipeline</strong> (no AI needed, production-grade) or the
        <strong> AI Vision</strong> approach (LLaVA describes features).
        Extracted polygons are saved directly to a survey area as GIS features.
      </Paragraph>

      {/* ── Ollama status (for AI Vision mode) ── */}
      {ollamaHealth?.ollama_available && visionModels.length === 0 && extractMode === 'vision' && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="No vision model installed"
          description={<><code>ollama pull moondream:latest</code> (850 MB) or <code>ollama pull llava:7b</code> (4.7 GB)</>}
        />
      )}

      {/* ── Project selector ── */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <span style={{ fontWeight: 500 }}>Project:</span>
          <Select
            style={{ width: 280 }}
            placeholder="Select project"
            value={selectedProject}
            onChange={v => { setSelectedProject(v); setClassicalGeotiff(null); setSelectedGeotiff(null) }}
            options={projects.map((p: any) => ({ value: p.id, label: p.project_number || p.name }))}
          />
        </Space>
      </Card>

      {/* ── Extraction mode tabs ── */}
      <Tabs
        activeKey={extractMode}
        onChange={v => setExtractMode(v as 'classical' | 'vision')}
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'classical',
            label: (
              <Space>
                <ThunderboltOutlined style={{ color: '#52c41a' }} />
                Classical GIS Pipeline
                <Tag color="green" style={{ fontSize: 10 }}>Recommended · No AI needed</Tag>
              </Space>
            ),
            children: (
              <Card size="small">
                <Alert type="success" showIcon style={{ marginBottom: 16 }}
                  message="Industry-standard pipeline (same as QGIS, ArcGIS Pro, Orfeo Toolbox)"
                  description="Edge detection → morphological gap closing → connected components → GDAL Polygonize. Deterministic, fast, works offline, no GPU required."
                />

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <Form.Item label="GeoTiff Layer" required style={{ margin: 0 }}>
                    <Select
                      placeholder={selectedProject ? 'Select GeoTiff (DONE status)' : 'Select project first'}
                      disabled={!selectedProject}
                      value={classicalGeotiff}
                      onChange={setClassicalGeotiff}
                      options={geotiffOptions}
                    />
                    {geotiffLayers.length > 0 && geotiffOptions.length === 0 && (
                      <div style={{ color: '#fa8c16', fontSize: 11, marginTop: 4 }}>
                        No DONE layers yet — wait for COG conversion to complete.
                      </div>
                    )}
                  </Form.Item>
                </div>

                <Collapse ghost>
                  <Collapse.Panel header={<Space><SettingOutlined />Pipeline Parameters</Space>} key="params">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <Form.Item label={
                        <Tooltip title="Controls edge detection sensitivity. Higher = detect more edges (noisier). Lower = only strong edges.">
                          Edge Sensitivity (0–1)
                        </Tooltip>
                      } style={{ margin: 0 }}>
                        <Slider
                          min={0.05} max={0.95} step={0.05}
                          value={edgeSensitivity}
                          onChange={setEdgeSensitivity}
                          marks={{ 0.1: 'Low', 0.3: 'Medium', 0.6: 'High' }}
                        />
                        <div style={{ textAlign: 'right', fontSize: 11, color: '#888' }}>{edgeSensitivity}</div>
                      </Form.Item>

                      <Form.Item label={
                        <Tooltip title="Minimum parcel area in m². Smaller polygons are discarded as noise.">
                          Min Polygon Area (m²)
                        </Tooltip>
                      } style={{ margin: 0 }}>
                        <Select
                          value={minAreaM2}
                          onChange={setMinAreaM2}
                          options={[
                            { value: 100,   label: '100 m² (very small)' },
                            { value: 500,   label: '500 m² (default)' },
                            { value: 1000,  label: '1 000 m² (~40×25 m)' },
                            { value: 5000,  label: '5 000 m² (0.5 ha)' },
                            { value: 10000, label: '10 000 m² (1 ha)' },
                          ]}
                        />
                      </Form.Item>

                      <Form.Item label={
                        <Tooltip title="Morphological dilation radius in pixels. Larger = closes wider gaps between boundary lines.">
                          Gap Closing (px)
                        </Tooltip>
                      } style={{ margin: 0 }}>
                        <Select
                          value={dilationPx}
                          onChange={setDilationPx}
                          options={[
                            { value: 1, label: '1 px (minimal)' },
                            { value: 3, label: '3 px (default)' },
                            { value: 5, label: '5 px (wider gaps)' },
                            { value: 8, label: '8 px (large gaps)' },
                          ]}
                        />
                      </Form.Item>

                      <Form.Item label={
                        <Tooltip title="Douglas-Peucker simplification tolerance in degrees. Reduces polygon vertex count.">
                          Simplify Tolerance
                        </Tooltip>
                      } style={{ margin: 0 }}>
                        <Select
                          value={simplifyTol}
                          onChange={setSimplifyTol}
                          options={[
                            { value: 0,        label: 'None (full detail)' },
                            { value: 0.00001,  label: '0.00001° (~1 m)' },
                            { value: 0.00005,  label: '0.00005° (~5 m, default)' },
                            { value: 0.0001,   label: '0.0001° (~10 m)' },
                            { value: 0.0005,   label: '0.0005° (~50 m)' },
                          ]}
                        />
                      </Form.Item>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <Space>
                        <Switch checked={aiLabel} onChange={setAiLabel} size="small" />
                        <span style={{ fontSize: 13 }}>
                          AI-assisted labeling <span style={{ color: '#888', fontSize: 11 }}>(after extraction, send each polygon thumbnail to vision model for type labeling: parcel/building/road/water)</span>
                        </span>
                      </Space>
                      {aiLabel && (
                        <div style={{ marginTop: 8 }}>
                          <Form form={form} layout="inline" initialValues={{ vision_model: visionModels[0] || 'llava:7b' }}>
                            <Form.Item name="vision_model" label="Vision Model" style={{ margin: 0 }}>
                              <Select
                                style={{ width: 200 }}
                                options={(visionModels.length > 0 ? visionModels : ['llava:7b', 'moondream:latest'])
                                  .map(m => ({ value: m, label: visionModels.includes(m) ? `${m} ✓` : m }))}
                              />
                            </Form.Item>
                          </Form>
                        </div>
                      )}
                    </div>
                  </Collapse.Panel>
                </Collapse>

                <div style={{ marginTop: 16 }}>
                  <Button
                    type="primary"
                    icon={<ThunderboltOutlined />}
                    size="large"
                    loading={submitClassical.isPending}
                    disabled={!selectedProject || !classicalGeotiff}
                    onClick={onSubmitClassical}
                  >
                    Extract Polygons (Classical GIS)
                  </Button>
                </div>
              </Card>
            ),
          },
          {
            key: 'vision',
            disabled: !gpuEnabled,
            label: (
              <Space>
                <EyeOutlined style={{ color: '#1890ff' }} />
                AI Vision (LLaVA)
                <Tag color={gpuEnabled ? 'blue' : 'default'} style={{ fontSize: 10 }}>GPU only</Tag>
              </Space>
            ),
            children: (
              <Card size="small">
                {!gpuEnabled && (
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    message="AI Vision requires GPU mode"
                    description="The AI backend is running in CPU mode (AI_BACKEND_GPU). Start a GPU backend (docker compose --profile docker-ollama-gpu up -d, AI_BACKEND_GPU=true) or use the Classical GIS Pipeline, which runs on CPU."
                  />
                )}
                <Alert type="info" showIcon style={{ marginBottom: 12 }}
                  message="Sends image to local LLaVA vision model — requires Ollama with a vision model installed"
                  description={<>Run <code>ollama pull moondream:latest</code> or <code>ollama pull llava:7b</code> first.</>}
                />

                <Form form={form} layout="vertical" onFinish={onSubmitVision}
                  initialValues={{ vision_model: visionModels[0] || 'llava:7b' }}>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Form.Item name="vision_model" label="Vision Model" rules={[{ required: true }]}>
                      <Select
                        options={(visionModels.length > 0 ? visionModels : ['llava:7b', 'moondream:latest'])
                          .map(m => ({ value: m, label: visionModels.includes(m) ? `${m} ✓` : m }))}
                      />
                    </Form.Item>
                  </div>

                  <Form.Item label="Image Source">
                    <Radio.Group value={visionSourceMode} onChange={e => setVisionSourceMode(e.target.value)}
                      optionType="button" buttonStyle="solid">
                      <Radio.Button value="geotiff"><GlobalOutlined /> GeoTiff Layer</Radio.Button>
                      <Radio.Button value="scan"><FileImageOutlined /> Scanned Map</Radio.Button>
                    </Radio.Group>
                  </Form.Item>

                  {visionSourceMode === 'geotiff' ? (
                    <Form.Item label="GeoTiff Layer" required>
                      <Select
                        placeholder={selectedProject ? 'Select GeoTiff (DONE status)' : 'Select project first'}
                        disabled={!selectedProject}
                        value={selectedGeotiff}
                        onChange={setSelectedGeotiff}
                        options={geotiffOptions}
                      />
                    </Form.Item>
                  ) : (
                    <Form.Item label="Scanned Map Image">
                      <Upload fileList={fileList} beforeUpload={f => { setFileList([f as any]); return false }}
                        onRemove={() => setFileList([])} accept=".jpg,.jpeg,.png,.tif,.tiff" maxCount={1}>
                        <Button icon={<UploadOutlined />}>Select image</Button>
                      </Upload>
                    </Form.Item>
                  )}

                  <Button type="primary" htmlType="submit" icon={<EyeOutlined />}
                    loading={submitVision.isPending}
                    disabled={!selectedProject || (visionSourceMode === 'geotiff' && !selectedGeotiff) ||
                      (visionSourceMode === 'scan' && !fileList.length)}>
                    Extract with AI Vision
                  </Button>
                </Form>
              </Card>
            ),
          },
          {
            key: 'pipeline',
            disabled: !gpuEnabled,
            label: (
              <Space>
                <ExperimentOutlined style={{ color: '#722ed1' }} />
                Advanced AI Vision Pipeline
                <Tag color="purple" style={{ fontSize: 10 }}>10-Stage</Tag>
                <Tag color={gpuEnabled ? 'blue' : 'default'} style={{ fontSize: 10 }}>GPU only</Tag>
              </Space>
            ),
            children: (
              <Card size="small">
                {!gpuEnabled && (
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    message="The Advanced AI Vision Pipeline requires GPU mode"
                    description="The AI backend is running in CPU mode (AI_BACKEND_GPU). Start a GPU backend (docker compose --profile docker-ollama-gpu up -d, AI_BACKEND_GPU=true) or use the Classical GIS Pipeline, which runs on CPU."
                  />
                )}
                <Alert type="info" showIcon style={{ marginBottom: 12 }}
                  message="Executes the full 10-stage AI Vision pipeline (SAM 2.1 + U-Net++ Refinement + Graph Topology + PaddleOCR + LLM QA Review)"
                  description="Uses local models or auto-falls back to the selected Ollama vision model to segment the GeoTIFF in parallel tiles, reconstruct parcel geometry, extract survey numbers, and audit outputs."
                />

                <Form form={form} layout="vertical" onFinish={onSubmitPipeline}
                  initialValues={{ vision_model: visionModels[0] || 'llava:7b' }}>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Form.Item name="vision_model" label="Vision Model" rules={[{ required: true }]}>
                      <Select
                        options={(visionModels.length > 0 ? visionModels : ['llava:7b', 'moondream:latest'])
                          .map(m => ({ value: m, label: visionModels.includes(m) ? `${m} ✓` : m }))}
                      />
                    </Form.Item>

                    <Form.Item label="GeoTiff Layer" required>
                      <Select
                        placeholder={selectedProject ? 'Select GeoTiff (DONE status)' : 'Select project first'}
                        disabled={!selectedProject}
                        value={pipelineGeotiff}
                        onChange={setPipelineGeotiff}
                        options={geotiffOptions}
                      />
                    </Form.Item>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Form.Item label={
                      <Tooltip title="Size of overlapping tile blocks in pixels to run segmenter (1024 or 2048).">
                        Tile Size (pixels)
                      </Tooltip>
                    }>
                      <Radio.Group value={pipelineTileSize} onChange={e => setPipelineTileSize(e.target.value)}
                        optionType="button" buttonStyle="solid">
                        <Radio.Button value={1024}>1024 px</Radio.Button>
                        <Radio.Button value={2048}>2048 px</Radio.Button>
                      </Radio.Group>
                    </Form.Item>

                    <Form.Item label={
                      <Tooltip title="Minimum parcel area in m². Smaller polygons are discarded as noise.">
                        Min Polygon Area (m²)
                      </Tooltip>
                    }>
                      <Select
                        value={minAreaM2}
                        onChange={setMinAreaM2}
                        options={[
                          { value: 100,   label: '100 m² (very small)' },
                          { value: 500,   label: '500 m² (default)' },
                          { value: 1000,  label: '1 000 m²' },
                          { value: 5000,  label: '5 000 m²' },
                        ]}
                      />
                    </Form.Item>
                  </div>

                  <Collapse ghost style={{ marginBottom: 16 }}>
                    <Collapse.Panel header={<Space><SettingOutlined />Advanced Tuning Parameters</Space>} key="adv-params">
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <Form.Item label="Edge Sensitivity (0-1)">
                          <Slider
                            min={0.05} max={0.95} step={0.05}
                            value={edgeSensitivity}
                            onChange={setEdgeSensitivity}
                            marks={{ 0.1: 'Low', 0.3: 'Medium', 0.6: 'High' }}
                          />
                          <div style={{ textAlign: 'right', fontSize: 11, color: '#888' }}>{edgeSensitivity}</div>
                        </Form.Item>

                        <Form.Item label="Gap Closing / Dilation (px)">
                          <Select
                            value={dilationPx}
                            onChange={setDilationPx}
                            options={[
                              { value: 1, label: '1 px' },
                              { value: 3, label: '3 px' },
                              { value: 5, label: '5 px' },
                              { value: 8, label: '8 px' },
                            ]}
                          />
                        </Form.Item>

                        <Form.Item label="Simplify Tolerance (degrees)">
                          <Select
                            value={simplifyTol}
                            onChange={setSimplifyTol}
                            options={[
                              { value: 0,        label: 'None' },
                              { value: 0.00001,  label: '0.00001° (~1 m)' },
                              { value: 0.00005,  label: '0.00005° (~5 m)' },
                              { value: 0.0001,   label: '0.0001° (~10 m)' },
                            ]}
                          />
                        </Form.Item>
                      </div>
                    </Collapse.Panel>
                  </Collapse>

                  <Button type="primary" htmlType="submit" icon={<ExperimentOutlined />}
                    loading={submitPipeline.isPending}
                    disabled={!selectedProject || !pipelineGeotiff}>
                    Extract Polygons (AI Pipeline)
                  </Button>
                </Form>
              </Card>
            ),
          },
        ]}
      />

      {/* ── Active job result ── */}
      {activeJob && (
        <Card
          size="small"
          style={{ marginBottom: 24, borderColor: activeJob.status === 'DONE' ? '#52c41a' : undefined }}
          title={
            <Space>
              <Tag color={STATUS_COLOR[activeJob.status]}>{activeJob.status}</Tag>
              {isClassical(activeJob) && <><ThunderboltOutlined style={{ color: '#52c41a' }} /> <Text>Classical GIS — Job #{activeJob.id}</Text></>}
              {isPipeline(activeJob) && <><ExperimentOutlined style={{ color: '#722ed1' }} /> <Text>AI Vision Pipeline — Job #{activeJob.id} ({activeJob.vision_model})</Text></>}
              {!isClassical(activeJob) && !isPipeline(activeJob) && <><EyeOutlined style={{ color: '#1890ff' }} /> <Text>AI Vision — Job #{activeJob.id} ({activeJob.vision_model})</Text></>}
              {(activeJob.status === 'PENDING' || activeJob.status === 'RUNNING') && <Spin size="small" />}
            </Space>
          }
          extra={
            activeJob.status === 'DONE' && activeJob.draft_features?.some(f => f.geometry) && (
              <Space>
                <Button type="primary" icon={<EditOutlined />}
                  onClick={() => navigate(`/boundary-review/${activeJob.id}`)}>
                  Review & Edit Boundaries
                </Button>
                <Button icon={<SaveOutlined />} onClick={() => openSaveModal(activeJob)}>
                  Quick Save
                </Button>
              </Space>
            )
          }
        >
          {activeJob.status === 'DONE' && <JobResultPanel job={activeJob} onSave={() => openSaveModal(activeJob)} />}
          {activeJob.status === 'FAILED' && (
            <Alert type="error" showIcon message="Extraction failed"
              description={<pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#ff6b6b' }}>{activeJob.error_log}</pre>}
            />
          )}
          {(activeJob.status === 'PENDING' || activeJob.status === 'RUNNING') && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin size="large" />
              <div style={{ marginTop: 10, color: '#888' }}>
                {isClassical(activeJob) && 'Running classical GIS pipeline: edge detection → gap closing → polygonize…'}
                {isPipeline(activeJob) && 'Running 10-stage AI Vision pipeline: tiling → SAM → U-Net++ → graph → OCR → validation → LLM review…'}
                {!isClassical(activeJob) && !isPipeline(activeJob) && 'Vision model is analysing the image… (2–5 min)'}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ── Job history ── */}
      <Divider>Extraction History</Divider>
      <Table rowKey="id" loading={jobsLoading} dataSource={jobs} size="small" pagination={{ pageSize: 10 }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 60 },
          { title: 'Status', dataIndex: 'status', width: 110,
            render: (s: string) => <Tag color={STATUS_COLOR[s]}>{s}</Tag> },
          { title: 'Mode', width: 120,
            render: (_: any, r: ExtractionJob) => {
              if (isClassical(r)) return <Tag color="green" icon={<ThunderboltOutlined />}>Classical</Tag>
              if (isPipeline(r)) return <Tag color="purple" icon={<ExperimentOutlined />}>AI Pipeline</Tag>
              return <Tag color="blue" icon={<EyeOutlined />}>AI Vision</Tag>
            }
          },
          { title: 'Polygons', width: 80,
            render: (_: any, r: ExtractionJob) =>
              r.parsed_result?.polygon_count ?? r.draft_features?.length ?? '—' },
          { title: 'Created', dataIndex: 'created_at', width: 150,
            render: (v: string) => new Date(v).toLocaleString() },
          { title: '', width: 140,
            render: (_: any, r: ExtractionJob) => (
              <Space>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => setPollingJobId(r.id)}>View</Button>
                {r.status === 'DONE' && r.draft_features?.some(f => f.geometry) && (
                  <Button size="small" type="primary" icon={<EditOutlined />}
                    onClick={() => navigate(`/boundary-review/${r.id}`)}>
                    Review
                  </Button>
                )}
              </Space>
            ) },
        ]}
      />

      {/* ── Save to Survey Area Modal ── */}
      <Modal
        title={<Space><SaveOutlined style={{ color: '#52c41a' }} />Save Polygons to Survey Area</Space>}
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onOk={() => saveForm.submit()}
        okText={saving ? 'Saving…' : `Save ${selectedFeatIdx.length} Polygon(s)`}
        confirmLoading={saving}
        width={640}
      >
        <Form form={saveForm} layout="vertical" onFinish={handleSave} style={{ marginTop: 8 }}>
          {/* Feature selection */}
          <Form.Item label={`Select Polygons (${selectedFeatIdx.length} / ${saveDraft.length} selected)`}>
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #d9d9d9', borderRadius: 4, padding: 8 }}>
              {saveDraft.map((feat, i) => {
                const props = feat.properties || {}
                const areaM2 = props.area_m2 ? ` — ${(props.area_m2 / 10000).toFixed(3)} ha` : ''
                const conf   = props.confidence || 'medium'
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <Checkbox
                      checked={selectedFeatIdx.includes(i)}
                      onChange={e => {
                        if (e.target.checked) setSelectedFeatIdx(p => [...p, i])
                        else setSelectedFeatIdx(p => p.filter(x => x !== i))
                      }}
                    />
                    <Tag color={conf === 'high' ? 'green' : conf === 'low' ? 'red' : 'orange'} style={{ fontSize: 10 }}>
                      {conf}
                    </Tag>
                    <Tag color="blue" style={{ fontSize: 10 }}>{props.feature_type || 'parcel'}</Tag>
                    <Text style={{ fontSize: 12 }}>{props.label || `Polygon ${i + 1}`}{areaM2}</Text>
                  </div>
                )
              })}
            </div>
            <Space style={{ marginTop: 6 }}>
              <Button size="small" onClick={() => setSelectedFeatIdx(saveDraft.map((_, i) => i))}>Select All</Button>
              <Button size="small" onClick={() => setSelectedFeatIdx([])}>Clear</Button>
            </Space>
          </Form.Item>

          {/* Layer name */}
          <Form.Item name="layer_name" label="GIS Layer Name"
            rules={[{ required: true }]} initialValue="AI Extracted Parcels">
            <Input placeholder="e.g. AI_Extracted_Parcels" />
          </Form.Item>

          {/* Survey area */}
          <Form.Item label="Survey Area">
            <Radio.Group value={areaMode} onChange={e => setAreaMode(e.target.value)}
              optionType="button" buttonStyle="solid" style={{ marginBottom: 10 }}>
              <Radio.Button value="existing">Use Existing Survey Area</Radio.Button>
              <Radio.Button value="new"><PlusOutlined /> Create New</Radio.Button>
            </Radio.Group>
            {areaMode === 'existing' ? (
              <Form.Item name="survey_area_id" noStyle rules={[{ required: true, message: 'Select a survey area' }]}>
                <Select style={{ width: '100%' }} placeholder="Select survey area"
                  options={surveyAreas.map(a => ({
                    value: a.id,
                    label: a.area_code ? `${a.name} (${a.area_code})` : a.name,
                  }))}
                />
              </Form.Item>
            ) : (
              <Form.Item name="new_area_name" noStyle rules={[{ required: true, message: 'Enter area name' }]}>
                <Input placeholder="e.g. Sector A — GeoTiff Extract" />
              </Form.Item>
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

// ── Sub-component: job result panel ──────────────────────────────────────────

function JobResultPanel({ job, onSave }: { job: ExtractionJob; onSave: () => void }) {
  const isClassical = job.parsed_result?.source === 'classical_gis'
  const isPipeline  = job.parsed_result?.source === 'ai_vision_pipeline'
  const pr    = job.parsed_result || {}
  const feats = job.draft_features || []
  const withCoords = feats.filter(f => f.geometry !== null)
  const noCoords   = feats.filter(f => f.geometry === null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Summary */}
      <Alert
        type={withCoords.length > 0 ? 'success' : 'warning'} showIcon
        message={
          withCoords.length > 0
            ? `${withCoords.length} polygon(s) extracted with real WGS-84 coordinates`
            : 'No valid polygons produced — try adjusting parameters'
        }
        description={
          <Space wrap>
            {pr.bounds && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                Bounds: {pr.bounds.west?.toFixed(4)}°E – {pr.bounds.east?.toFixed(4)}°E,{' '}
                {pr.bounds.south?.toFixed(4)}°N – {pr.bounds.north?.toFixed(4)}°N
              </Text>
            )}
            {isClassical && pr.otsu_threshold && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                Auto threshold: {pr.applied_threshold} (Otsu: {pr.otsu_threshold})
                · Components: {pr.n_components}
              </Text>
            )}
            {isPipeline && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                10-Stage Pipeline Completed · Check QA & validation checks below.
              </Text>
            )}
          </Space>
        }
      />

      {/* Classical diagnostics */}
      {isClassical && pr.params && (
        <Descriptions size="small" bordered column={3}
          labelStyle={{ color: '#aaa', background: '#1a1a1a', fontSize: 11 }}
          contentStyle={{ background: '#111', fontSize: 12 }}>
          <Descriptions.Item label="Edge sensitivity">{pr.params.edge_sensitivity}</Descriptions.Item>
          <Descriptions.Item label="Min area">{pr.params.min_area_m2} m²</Descriptions.Item>
          <Descriptions.Item label="Dilation">{pr.params.dilation_px} px</Descriptions.Item>
          <Descriptions.Item label="Image size">{pr.image_size?.[0]}×{pr.image_size?.[1]} px</Descriptions.Item>
          <Descriptions.Item label="Processed">{pr.processed_size?.[0]}×{pr.processed_size?.[1]} px</Descriptions.Item>
          <Descriptions.Item label="Polygons">{pr.polygon_count}</Descriptions.Item>
        </Descriptions>
      )}

      {/* Feature table */}
      {withCoords.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13, color: '#52c41a' }}>
            <CheckSquareOutlined style={{ marginRight: 4 }} />
            {withCoords.length} polygon(s) ready to save
          </div>
          <Table
            rowKey={(_, i) => String(i)}
            dataSource={withCoords}
            size="small"
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            scroll={{ y: 280 }}
            columns={
              isPipeline
                ? [
                    { title: 'Type', dataIndex: ['properties', 'feature_type'], width: 100,
                      render: (v: string) => <Tag color="blue" style={{ fontSize: 10 }}>{v || 'parcel'}</Tag> },
                    { title: 'Survey No.', dataIndex: ['properties', 'survey_number'], ellipsis: true,
                      render: (v: string, record: any) => v || record.properties?.label || '—' },
                    { title: 'Area', dataIndex: ['properties', 'area_m2'], width: 110,
                      render: (v: number) => v != null ? `${(v / 10000).toFixed(4)} ha` : '—' },
                    { title: 'OCR Conf', dataIndex: ['properties', 'ocr_confidence'], width: 90,
                      render: (v: number) => v != null ? `${(v * 100).toFixed(0)}%` : '—' },
                    { title: 'Validation', width: 130,
                      render: (_: any, record: any) => {
                        const errs = record.properties?.validation_errors || []
                        if (errs.length === 0) return <Tag color="success">Valid</Tag>
                        return (
                          <Tooltip title={errs.join(' ')}>
                            <Tag color="warning">Flags ({errs.length})</Tag>
                          </Tooltip>
                        )
                      }
                    },
                    { title: 'Confidence', dataIndex: ['properties', 'confidence'], width: 90,
                      render: (v: string) => <Tag color={v === 'high' ? 'green' : v === 'low' ? 'red' : 'orange'} style={{ fontSize: 10 }}>{v}</Tag> },
                  ]
                : [
                    { title: 'Type', dataIndex: ['properties', 'feature_type'], width: 110,
                      render: (v: string) => <Tag color="blue" style={{ fontSize: 10 }}>{v || 'parcel'}</Tag> },
                    { title: 'Label', dataIndex: ['properties', 'label'], ellipsis: true },
                    { title: 'Area', dataIndex: ['properties', 'area_m2'], width: 110,
                      render: (v: number) => v != null ? `${(v / 10000).toFixed(4)} ha` : '—' },
                    { title: 'Confidence', dataIndex: ['properties', 'confidence'], width: 90,
                      render: (v: string) => <Tag color={v === 'high' ? 'green' : v === 'low' ? 'red' : 'orange'} style={{ fontSize: 10 }}>{v}</Tag> },
                  ]
            }
          />
          <Button type="primary" icon={<SaveOutlined />} onClick={onSave} style={{ alignSelf: 'flex-start' }}>
            Save Polygons to Survey Area…
          </Button>
        </>
      )}

      {/* Zero polygon diagnostics */}
      {withCoords.length === 0 && (
        <Alert type="warning" showIcon
          message="Suggestions to improve polygon yield"
          description={
            <ul style={{ paddingLeft: 16, margin: 0 }}>
              <li>Lower <strong>Edge Sensitivity</strong> (e.g. 0.15) to detect fainter boundaries</li>
              <li>Increase <strong>Gap Closing</strong> to 5–8 px for imagery with broken boundary lines</li>
              <li>Reduce <strong>Min Area</strong> to 100 m² if parcels are small</li>
              <li>Ensure the GeoTiff COG conversion completed successfully</li>
              {pr.skipped_features?.length > 0 && (
                <li>Skip reasons: {(pr.skipped_features || []).slice(0, 3).join('; ')}</li>
              )}
            </ul>
          }
        />
      )}

      {/* LLM QA Review Report */}
      {isPipeline && pr.qa_review && (
        <Card size="small" title={<Space><ExperimentOutlined style={{ color: '#722ed1' }} />LLM QA Review Report</Space>} style={{ marginTop: 12, background: '#141414', border: '1px solid #722ed1' }}>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, maxHeight: 300, overflow: 'auto', color: '#d9d9d9', fontFamily: 'monospace' }}>
            {pr.qa_review}
          </pre>
        </Card>
      )}

      {/* Raw response (for AI Vision) */}
      {!isClassical && !isPipeline && job.raw_response && (
        <Collapse ghost>
          <Collapse.Panel header="Raw model response" key="raw">
            <pre style={{ fontSize: 11, color: '#888', maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {job.raw_response}
            </pre>
          </Collapse.Panel>
        </Collapse>
      )}
    </div>
  )
}
