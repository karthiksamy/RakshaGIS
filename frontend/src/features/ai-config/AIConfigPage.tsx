import { useState } from 'react'
import {
  Table, Button, Space, Tag, Modal, Form, Input, Select, InputNumber,
  message, Tooltip, Typography, Card, Alert, Divider, Badge, Tabs,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined, UnorderedListOutlined,
  PlayCircleOutlined, RobotOutlined, CloudDownloadOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import ModelHubPanel from './ModelHubPanel'

const { Text, Title } = Typography

interface LLMConfig {
  id: number
  name: string
  provider: 'ollama' | 'openai_compat' | 'huggingface'
  provider_display: string
  base_url: string
  model_name: string
  api_key: string
  timeout: number
  is_active: boolean
  notes: string
  updated_by_name: string
  updated_at: string
}

interface PresetDef {
  label: string; url: string; modelHint: string; notes: string
  gpu?: boolean; profile?: string; gpuProfile?: string
}

const PROVIDER_PRESETS: Record<string, PresetDef> = {
  ollama:            { label: 'Ollama (CPU)',        url: 'http://host.docker.internal:11434', modelHint: 'llama3.2',     notes: 'No API key needed.',                                         profile: 'docker-ollama',     gpuProfile: 'docker-ollama-gpu' },
  'ollama-gpu':      { label: 'Ollama (GPU)',         url: 'http://host.docker.internal:11434', modelHint: 'llama3.2',     notes: 'Requires NVIDIA Container Toolkit.',                         profile: 'docker-ollama-gpu', gpu: true },
  localai:           { label: 'LocalAI (CPU)',        url: 'http://localai:8080',               modelHint: 'ggml-gpt4all-j', notes: 'OpenAI-compatible CPU build.',                             profile: 'localai',           gpuProfile: 'localai-gpu' },
  'localai-gpu':     { label: 'LocalAI (GPU)',        url: 'http://localai:8080',               modelHint: 'ggml-gpt4all-j', notes: 'NVIDIA CUDA 12 — offloads all layers to GPU.',              profile: 'localai-gpu',       gpu: true },
  llamacpp:          { label: 'LlamaCpp (CPU)',       url: 'http://llamacpp:8081',              modelHint: 'model',        notes: 'Place GGUF file at DATA_DIR/models/llamacpp/model.gguf',    profile: 'llamacpp',          gpuProfile: 'llamacpp-gpu' },
  'llamacpp-gpu':    { label: 'LlamaCpp (GPU)',       url: 'http://llamacpp:8081',              modelHint: 'model',        notes: 'CUDA build — 99 layers offloaded to GPU.',                  profile: 'llamacpp-gpu',      gpu: true },
  lmstudio:          { label: 'LM Studio',            url: 'http://host.docker.internal:1234',  modelHint: 'local-model',  notes: 'Host-only app (no Docker). Start server inside LM Studio.' },
  anythingllm:       { label: 'AnythingLLM (CPU)',    url: 'http://anythingllm:3001/api/v1/openai', modelHint: 'anything-llm', notes: 'Full AI workspace.',                                    profile: 'anythingllm',       gpuProfile: 'anythingllm-gpu' },
  'anythingllm-gpu': { label: 'AnythingLLM (GPU)',    url: 'http://anythingllm:3001/api/v1/openai', modelHint: 'anything-llm', notes: 'NVIDIA GPU variant.',                                   profile: 'anythingllm-gpu',   gpu: true },
  huggingface:       { label: 'HuggingFace',          url: 'https://api-inference.huggingface.co/models', modelHint: 'meta-llama/Llama-2-7b-chat-hf', notes: 'Requires HF API token with Inference access.' },
}

const PROVIDER_COLOR: Record<string, string> = {
  ollama:        'blue',
  openai_compat: 'purple',
  huggingface:   'orange',
}

export default function AIConfigPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editRecord, setEditRecord] = useState<LLMConfig | null>(null)
  const [form] = Form.useForm()
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [modelsFor, setModelsFor] = useState<{ id: number; models: string[] } | null>(null)
  const [selectedPreset, setSelectedPreset] = useState<string>('')

  const { data: configs = [], isLoading } = useQuery<LLMConfig[]>({
    queryKey: ['llm-configs'],
    queryFn: () => api.get('/ai/llm-configs/').then(r => r.data.results ?? r.data),
  })

  const active = configs.find(c => c.is_active)

  const saveMut = useMutation({
    mutationFn: (values: any) => editRecord
      ? api.patch(`/ai/llm-configs/${editRecord.id}/`, values).then(r => r.data)
      : api.post('/ai/llm-configs/', values).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llm-configs'] })
      message.success(editRecord ? 'Config updated' : 'Config created')
      closeModal()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Save failed'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/ai/llm-configs/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-configs'] }); message.success('Deleted') },
    onError: () => message.error('Delete failed'),
  })

  const activateMut = useMutation({
    mutationFn: (id: number) => api.post(`/ai/llm-configs/${id}/activate/`).then(r => r.data),
    onSuccess: (data) => { qc.invalidateQueries({ queryKey: ['llm-configs'] }); message.success(data.detail) },
    onError: () => message.error('Activate failed'),
  })

  function openCreate() {
    setEditRecord(null)
    setSelectedPreset('')
    setTestResult(null)
    form.resetFields()
    form.setFieldsValue({ provider: 'ollama', timeout: 120 })
    setModalOpen(true)
  }

  function openEdit(rec: LLMConfig) {
    setEditRecord(rec)
    setSelectedPreset('')
    setTestResult(null)
    form.setFieldsValue({
      name: rec.name, provider: rec.provider,
      base_url: rec.base_url, model_name: rec.model_name,
      api_key: '', timeout: rec.timeout, notes: rec.notes,
    })
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditRecord(null)
    setTestResult(null)
    setSelectedPreset('')
    form.resetFields()
  }

  function applyPreset(key: string) {
    setSelectedPreset(key)
    const p = PROVIDER_PRESETS[key]
    if (!p) return
    const provider = key.startsWith('ollama') ? 'ollama'
      : key === 'huggingface' ? 'huggingface'
      : 'openai_compat'
    form.setFieldsValue({
      provider,
      base_url: p.url,
      model_name: p.modelHint,
      notes: p.notes,
      name: p.label,
    })
  }

  async function handleTest() {
    if (!editRecord) { message.warning('Save the config first, then test it.'); return }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.post(`/ai/llm-configs/${editRecord.id}/test/`).then(r => r.data)
      setTestResult(res)
    } catch (e: any) {
      setTestResult({ ok: false, detail: e?.response?.data?.detail || 'Request failed' })
    } finally {
      setTesting(false)
    }
  }

  async function handleListModels(id: number) {
    try {
      const res = await api.get(`/ai/llm-configs/${id}/models/`).then(r => r.data)
      setModelsFor({ id, models: res.models })
    } catch {
      message.error('Could not list models')
    }
  }

  const columns: ColumnsType<LLMConfig> = [
    {
      title: 'Status', width: 70,
      render: (_, r) => r.is_active
        ? <Badge status="success" text={<Text style={{ color: '#52c41a', fontSize: 12 }}>Active</Text>} />
        : <Badge status="default" text={<Text style={{ color: '#666', fontSize: 12 }}>Idle</Text>} />,
    },
    { title: 'Name', dataIndex: 'name', render: v => <Text strong style={{ fontSize: 13 }}>{v}</Text> },
    {
      title: 'Provider', dataIndex: 'provider_display', width: 180,
      render: (v, r) => <Tag color={PROVIDER_COLOR[r.provider] ?? 'default'} style={{ fontSize: 11 }}>{v}</Tag>,
    },
    {
      title: 'URL', dataIndex: 'base_url', ellipsis: true,
      render: v => <Text style={{ fontSize: 11, fontFamily: 'monospace', color: '#aaa' }}>{v}</Text>,
    },
    { title: 'Model', dataIndex: 'model_name', ellipsis: true, render: v => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
    {
      title: 'Updated', dataIndex: 'updated_at', width: 120,
      render: v => <Text style={{ fontSize: 11, color: '#666' }}>{new Date(v).toLocaleDateString()}</Text>,
    },
    {
      title: 'Actions', width: 160,
      render: (_, r) => (
        <Space size={4}>
          {!r.is_active && (
            <Tooltip title="Set as active config">
              <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                onClick={() => activateMut.mutate(r.id)}>
                Activate
              </Button>
            </Tooltip>
          )}
          <Tooltip title="List available models">
            <Button size="small" icon={<UnorderedListOutlined />}
              onClick={() => handleListModels(r.id)} />
          </Tooltip>
          <Tooltip title="Edit">
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          </Tooltip>
          {!r.is_active && (
            <Tooltip title="Delete">
              <Button size="small" danger icon={<DeleteOutlined />}
                onClick={() => deleteMut.mutate(r.id)} />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ]

  // Page-level tabs: LLM Configs | Model Hub
  const pageTabs = [
    {
      key: 'configs',
      label: (
        <span>
          <RobotOutlined style={{ marginRight: 6 }} />
          LLM Configs
        </span>
      ),
      children: (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Space>
              <Title level={5} style={{ margin: 0 }}>Backend Configurations</Title>
            </Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Config</Button>
          </div>

          {active && (
            <Alert
              type="success" showIcon icon={<CheckCircleOutlined />}
              message={
                <span>
                  Active: <strong>{active.name}</strong> — {active.provider_display} —{' '}
                  <code style={{ fontSize: 12 }}>{active.model_name}</code> at{' '}
                  <code style={{ fontSize: 12 }}>{active.base_url}</code>
                </span>
              }
              style={{ marginBottom: 16 }}
            />
          )}

          <Card size="small">
            <Table
              columns={columns}
              dataSource={configs}
              rowKey="id"
              loading={isLoading}
              size="small"
              pagination={false}
            />
          </Card>
        </div>
      ),
    },
    {
      key: 'hub',
      label: (
        <span>
          <CloudDownloadOutlined style={{ marginRight: 6 }} />
          Model Hub
        </span>
      ),
      children: (
        <Card size="small">
          <ModelHubPanel configs={configs.map(c => ({
            id: c.id, name: c.name, provider: c.provider,
            base_url: c.base_url, is_active: c.is_active,
          }))} />
        </Card>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <RobotOutlined style={{ fontSize: 22 }} />
        <Title level={4} style={{ margin: 0 }}>AI / LLM Configuration</Title>
      </div>

      <Tabs items={pageTabs} />

      {/* Models modal */}
      <Modal
        title={`Available Models`}
        open={!!modelsFor}
        onCancel={() => setModelsFor(null)}
        footer={<Button onClick={() => setModelsFor(null)}>Close</Button>}
        width={480}
      >
        {modelsFor?.models.length === 0 ? (
          <Alert type="warning" message="No models found or endpoint unreachable" showIcon />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {modelsFor?.models.map(m => (
              <Tag key={m} style={{ fontFamily: 'monospace', fontSize: 11 }}>{m}</Tag>
            ))}
          </div>
        )}
      </Modal>

      {/* Create / Edit modal */}
      <Modal
        title={editRecord ? `Edit: ${editRecord.name}` : 'Add LLM Config'}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText={saveMut.isPending ? 'Saving…' : 'Save'}
        confirmLoading={saveMut.isPending}
        width={620}
      >
        {/* Quick-fill presets */}
        <div style={{ marginBottom: 16 }}>
          <Text style={{ fontSize: 12, color: '#aaa' }}>Quick fill from preset:</Text>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
              <Button
                key={key} size="small"
                type={selectedPreset === key ? 'primary' : 'default'}
                danger={p.gpu}
                onClick={() => applyPreset(key)}
                title={p.gpu ? 'Requires NVIDIA GPU + Container Toolkit' : 'CPU-only'}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Text style={{ fontSize: 11, color: '#888', marginTop: 4, display: 'block' }}>
            Red = GPU variant (NVIDIA CUDA) · Default = CPU-only
          </Text>
        </div>

        <Divider style={{ margin: '8px 0 16px' }} />

        <Form form={form} layout="vertical" onFinish={(v) => saveMut.mutate(v)}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="name" label="Config Name" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input placeholder="e.g. Local Llama3.2" />
            </Form.Item>
            <Form.Item name="provider" label="Provider" style={{ width: 220 }} rules={[{ required: true }]}>
              <Select options={[
                { value: 'ollama',        label: 'Ollama' },
                { value: 'openai_compat', label: 'OpenAI-Compatible (LocalAI / LlamaCpp / LM Studio / AnythingLLM)' },
                { value: 'huggingface',   label: 'HuggingFace Inference API' },
              ]} />
            </Form.Item>
          </div>

          <Form.Item name="base_url" label="Base URL" rules={[{ required: true }]}>
            <Input placeholder="e.g. http://host.docker.internal:11434" style={{ fontFamily: 'monospace' }} />
          </Form.Item>

          <div style={{ display: 'flex', gap: 12 }}>
            <Form.Item name="model_name" label="Model Name" style={{ flex: 1 }} rules={[{ required: true }]}>
              <Input placeholder="e.g. llama3.2 or llama3.2:latest" style={{ fontFamily: 'monospace' }} />
            </Form.Item>
            <Form.Item name="timeout" label="Timeout (s)" style={{ width: 130 }}>
              <InputNumber min={10} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Form.Item name="api_key" label="API Key / Bearer Token">
            <Input.Password
              placeholder="Leave blank for local servers (Ollama, LocalAI, LlamaCpp)"
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} placeholder="Optional notes about this config" />
          </Form.Item>
        </Form>

        {/* Test connection */}
        {editRecord && (
          <div style={{ marginTop: 12 }}>
            <Button
              icon={<PlayCircleOutlined />}
              loading={testing}
              onClick={handleTest}
              size="small"
            >
              Test Connection
            </Button>
            {testResult && (
              <Alert
                type={testResult.ok ? 'success' : 'error'}
                icon={testResult.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                showIcon
                message={testResult.detail}
                style={{ marginTop: 8 }}
              />
            )}
          </div>
        )}

        {/* Docker setup guide */}
        {selectedPreset && selectedPreset !== 'huggingface' && selectedPreset !== 'lmstudio' && (() => {
          const p = PROVIDER_PRESETS[selectedPreset]
          if (!p?.profile) return null
          const cpuProfile = p.gpu ? null : p.profile
          const gpuProfile = p.gpu ? p.profile : p.gpuProfile
          return (
            <Alert
              type="info"
              showIcon
              icon={<ThunderboltOutlined />}
              style={{ marginTop: 12 }}
              message={p.gpu ? 'GPU Docker Setup (NVIDIA CUDA)' : 'Docker Setup'}
              description={
                <div style={{ fontSize: 12 }}>
                  {cpuProfile && (
                    <>
                      <Text style={{ fontSize: 11, color: '#aaa' }}>CPU-only:</Text>
                      <code style={{ background: '#1a1a1a', padding: '2px 8px', borderRadius: 3, display: 'block', margin: '4px 0 8px' }}>
                        docker compose --profile {cpuProfile} up -d
                      </code>
                    </>
                  )}
                  {gpuProfile && (
                    <>
                      <Text style={{ fontSize: 11, color: '#aaa' }}>NVIDIA GPU:</Text>
                      <code style={{ background: '#1a1a1a', padding: '2px 8px', borderRadius: 3, display: 'block', margin: '4px 0 8px' }}>
                        docker compose --profile {gpuProfile} up -d
                      </code>
                    </>
                  )}
                  <Text style={{ fontSize: 11, color: '#888' }}>{p.notes}</Text>
                  {p.gpu && (
                    <div style={{ marginTop: 6 }}>
                      <Text style={{ fontSize: 11, color: '#fa8c16' }}>
                        Requires: NVIDIA Container Toolkit installed on the host.
                        Verify with: <code style={{ background: '#1a1a1a', padding: '1px 4px', borderRadius: 2 }}>docker run --rm --gpus all nvidia/cuda:12.0-base-ubuntu22.04 nvidia-smi</code>
                      </Text>
                    </div>
                  )}
                </div>
              }
            />
          )
        })()}
      </Modal>
    </div>
  )
}
