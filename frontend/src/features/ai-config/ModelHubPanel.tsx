import { useState, useEffect, useCallback } from 'react'
import {
  Select, Tabs, Input, Button, Tag, Space, Alert, Typography, Progress,
  Table, Popconfirm, Modal, Form, message, Spin, Tooltip, Badge, Divider,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudDownloadOutlined, DeleteOutlined, SearchOutlined, CheckCircleOutlined,
  LoadingOutlined, InfoCircleOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'

const { Text } = Typography

// ── Types ──────────────────────────────────────────────────────────────────────

export interface LLMConfigMini {
  id: number
  name: string
  provider: string
  base_url: string
  is_active: boolean
}

interface CatalogModel {
  name: string
  size: string
  description: string
  tags: string[]
  repo_id?: string
  filename?: string
}

interface HubData {
  hub: string
  catalog: CatalogModel[]
  installed: string[]
}

interface ActivePull {
  taskId: number
  model: string
  hub: HubKey
  configId: number
}

interface TaskStatus {
  id: number
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  result: { progress?: number; downloaded_mb?: number; total_mb?: number }
  error_message: string
}

type HubKey = 'ollama' | 'huggingface' | 'localai' | 'llamacpp'
type TabKey = HubKey | 'installed'

// ── Constants ──────────────────────────────────────────────────────────────────

const HUB_LABELS: Record<HubKey, string> = {
  ollama:      'Ollama Hub',
  huggingface: 'HuggingFace Hub',
  localai:     'LocalAI Gallery',
  llamacpp:    'LlamaCpp Hub',
}

const TAG_COLOR: Record<string, string> = {
  fast: 'green', balanced: 'blue', large: 'orange', gpu: 'red',
  code: 'purple', embedding: 'cyan', multilingual: 'geekblue',
  multimodal: 'magenta',
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Normalise model name for installed-check (strip :tag suffix, lowercase). */
function norm(name: string) {
  return name.split(':')[0].toLowerCase()
}

function isInstalled(modelName: string, installed: string[]): boolean {
  return installed.some(i => norm(i) === norm(modelName) || i === modelName)
}

/**
 * Infer the hub type from a config's provider + URL so the Installed tab
 * knows which backend to query for the installed model list.
 */
function inferHub(config: LLMConfigMini | null): HubKey {
  if (!config) return 'ollama'
  if (config.provider === 'ollama') return 'ollama'
  if (config.provider === 'huggingface') return 'huggingface'
  const url = config.base_url.toLowerCase()
  if (url.includes('localai') || url.includes(':8080')) return 'localai'
  if (url.includes('llamacpp') || url.includes(':8081')) return 'llamacpp'
  if (url.includes('anythingllm') || url.includes(':3001')) return 'localai'
  return 'localai'
}

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  configs: LLMConfigMini[]
}

export default function ModelHubPanel({ configs }: Props) {
  const qc = useQueryClient()

  const [targetId, setTargetId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('ollama')
  const [search, setSearch]       = useState('')
  const [activePulls, setActivePulls] = useState<ActivePull[]>([])

  const [hfModalOpen, setHfModalOpen] = useState(false)
  const [hfForm] = Form.useForm()

  // Auto-select the active config on first render
  useEffect(() => {
    if (!targetId && configs.length > 0) {
      setTargetId((configs.find(c => c.is_active) ?? configs[0]).id)
    }
  }, [configs, targetId])

  const targetConfig = configs.find(c => c.id === targetId) ?? null

  // The hub used for the hub-models API call:
  //   - browse tabs  → the selected hub tab
  //   - installed tab → infer from config type
  const queryHub: HubKey = activeTab === 'installed' ? inferHub(targetConfig) : activeTab

  // ── Fetch hub catalog + installed list ──────────────────────────────────────
  const {
    data: hubData,
    isLoading: hubLoading,
    refetch: refetchHub,
  } = useQuery<HubData>({
    queryKey: ['hub-models', targetId, queryHub],
    queryFn: () =>
      api.get(`/ai/llm-configs/${targetId}/hub-models/?hub=${queryHub}`)
         .then(r => r.data),
    enabled: !!targetId,
    staleTime: 30_000,
  })

  const catalog   = hubData?.catalog  ?? []
  const installed = hubData?.installed ?? []

  // ── Poll active pull tasks ──────────────────────────────────────────────────
  const { data: taskStatuses } = useQuery<TaskStatus[]>({
    queryKey: ['pull-statuses', activePulls.map(p => p.taskId).join(',')],
    queryFn: () =>
      Promise.all(activePulls.map(p => api.get(`/ai/tasks/${p.taskId}/`).then(r => r.data))),
    enabled: activePulls.length > 0,
    refetchInterval: activePulls.length > 0 ? 3000 : false,
  })

  useEffect(() => {
    if (!taskStatuses?.length) return
    const finished = taskStatuses.filter(t => t.status === 'DONE' || t.status === 'FAILED')
    if (!finished.length) return
    finished.forEach(t => {
      const pull = activePulls.find(p => p.taskId === t.id)
      if (!pull) return
      if (t.status === 'DONE') message.success(`✓ ${pull.model} installed`)
      else message.error(`✗ ${pull.model}: ${t.error_message || 'Failed'}`)
    })
    setActivePulls(prev => prev.filter(p => !finished.some(t => t.id === p.taskId)))
    qc.invalidateQueries({ queryKey: ['hub-models'] })
  }, [taskStatuses]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pull mutation ───────────────────────────────────────────────────────────
  const pullMut = useMutation({
    mutationFn: ({ configId, body }: { configId: number; body: object }) =>
      api.post(`/ai/llm-configs/${configId}/pull-model/`, body).then(r => r.data),
    onSuccess: (data: { task_id: number; model: string; hub: string }, vars) => {
      setActivePulls(prev => [
        ...prev,
        { taskId: data.task_id, model: data.model, hub: data.hub as HubKey, configId: vars.configId },
      ])
      message.info(`Pulling ${data.model}…`)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Pull failed'),
  })

  // ── Delete mutation ─────────────────────────────────────────────────────────
  const deleteMut = useMutation({
    mutationFn: ({ configId, modelName, hub }: { configId: number; modelName: string; hub: HubKey }) =>
      api.post(`/ai/llm-configs/${configId}/delete-model/`, { model_name: modelName, hub }).then(r => r.data),
    onSuccess: (_d, v) => {
      message.success(`${v.modelName} deleted`)
      qc.invalidateQueries({ queryKey: ['hub-models'] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  // ── Handlers ────────────────────────────────────────────────────────────────
  const doPull = useCallback((hub: HubKey, model: CatalogModel, extra?: object) => {
    if (!targetConfig) { message.warning('Select a target backend first'); return }
    pullMut.mutate({ configId: targetConfig.id, body: { hub, model_name: model.name, ...extra } })
  }, [targetConfig, pullMut])

  const doDelete = useCallback((modelName: string, hub: HubKey) => {
    if (!targetConfig) return
    deleteMut.mutate({ configId: targetConfig.id, modelName, hub })
  }, [targetConfig, deleteMut])

  const isPulling = (modelName: string) =>
    activePulls.some(p => norm(p.model) === norm(modelName))

  // ── Filtered catalog (hide already installed + search) ──────────────────────
  const available = catalog.filter(m => {
    if (isInstalled(m.name, installed)) return false
    if (!search) return true
    const q = search.toLowerCase()
    return m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) ||
           (m.tags ?? []).some(t => t.includes(q))
  })

  // ── Browse table columns ────────────────────────────────────────────────────
  const browseColumns = (hub: HubKey): ColumnsType<CatalogModel> => [
    {
      title: 'Model', dataIndex: 'name',
      render: v => <Text strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</Text>,
    },
    {
      title: 'Size', dataIndex: 'size', width: 80,
      render: v => <Text style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: 'Description', dataIndex: 'description', ellipsis: true,
      render: v => <Text style={{ fontSize: 12, color: '#aaa' }}>{v}</Text>,
    },
    {
      title: 'Tags', dataIndex: 'tags', width: 200,
      render: (tags: string[] = []) => (
        <Space size={3} wrap>
          {tags.map(t => <Tag key={t} color={TAG_COLOR[t] ?? 'default'} style={{ fontSize: 10 }}>{t}</Tag>)}
        </Space>
      ),
    },
    {
      title: '', width: 110, align: 'right',
      render: (_, m) => {
        const pulling = isPulling(m.name)
        return (
          <Button
            type="primary" size="small"
            icon={pulling ? <LoadingOutlined /> : <CloudDownloadOutlined />}
            loading={pulling}
            disabled={pulling || !targetConfig}
            onClick={() => {
              if (hub === 'huggingface' || hub === 'llamacpp') {
                doPull(hub, m, { repo_id: m.repo_id, filename: m.filename, save_as: m.filename })
              } else {
                doPull(hub, m)
              }
            }}
          >
            {pulling ? 'Pulling…' : 'Pull'}
          </Button>
        )
      },
    },
  ]

  // ── Installed table ─────────────────────────────────────────────────────────
  interface InstalledRow { name: string; hub: HubKey }
  const installedRows: InstalledRow[] = installed.map(name => ({ name, hub: queryHub }))

  const installedColumns: ColumnsType<InstalledRow> = [
    {
      title: 'Model / File', dataIndex: 'name',
      render: v => <Text strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</Text>,
    },
    {
      title: 'Backend', dataIndex: 'hub', width: 140,
      render: v => <Tag color="blue" style={{ fontSize: 11 }}>{HUB_LABELS[v as HubKey] ?? v}</Tag>,
    },
    {
      title: '', width: 100, align: 'right',
      render: (_, row) => (
        <Popconfirm
          title={`Delete "${row.name}"?`}
          description="Removes the model from the backend permanently."
          onConfirm={() => doDelete(row.name, row.hub)}
          okText="Delete" okButtonProps={{ danger: true }}
        >
          <Button size="small" danger icon={<DeleteOutlined />}
            loading={deleteMut.isPending && deleteMut.variables?.modelName === row.name}>
            Delete
          </Button>
        </Popconfirm>
      ),
    },
  ]

  // ── Active pull progress bar ────────────────────────────────────────────────
  const ActivePullsPanel = () => {
    if (!activePulls.length) return null
    return (
      <div style={{ marginTop: 16, padding: '12px 16px', background: '#111', borderRadius: 6, border: '1px solid #333' }}>
        <Text style={{ fontSize: 11, color: '#888', display: 'block', marginBottom: 8 }}>
          Active Downloads
        </Text>
        {activePulls.map(p => {
          const ts = taskStatuses?.find(t => t.id === p.taskId)
          const pct = ts?.result?.progress ?? null
          const mb = ts?.result?.downloaded_mb
          const total = ts?.result?.total_mb
          return (
            <div key={p.taskId} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                <Text style={{ fontSize: 11, fontFamily: 'monospace' }}>{p.model}</Text>
                <Text style={{ fontSize: 11, color: '#888' }}>
                  {mb != null && total ? `${mb} / ${total} MB` : ts?.status ?? 'Queued'}
                </Text>
              </div>
              <Progress
                percent={pct ?? 0}
                size="small"
                status={pct == null ? 'active' : undefined}
                showInfo={pct != null}
              />
            </div>
          )
        })}
      </div>
    )
  }

  // ── HF custom download modal ────────────────────────────────────────────────
  const HFModal = () => (
    <Modal
      title="Custom HuggingFace / GGUF Download"
      open={hfModalOpen}
      onCancel={() => { setHfModalOpen(false); hfForm.resetFields() }}
      onOk={() => hfForm.submit()}
      okText="Start Download"
      confirmLoading={pullMut.isPending}
    >
      <Form
        form={hfForm} layout="vertical"
        onFinish={vals => {
          if (!targetConfig) { message.warning('Select a backend first'); return }
          const hub: HubKey = activeTab === 'huggingface' || activeTab === 'llamacpp' ? activeTab : 'llamacpp'
          pullMut.mutate({
            configId: targetConfig.id,
            body: {
              hub,
              model_name: vals.save_as || vals.filename,
              repo_id:    vals.repo_id,
              filename:   vals.filename,
              save_as:    vals.save_as || vals.filename,
              hf_token:   vals.hf_token || '',
            },
          })
          setHfModalOpen(false)
          hfForm.resetFields()
        }}
      >
        <Form.Item name="repo_id" label="HuggingFace Repo ID" rules={[{ required: true }]}
          help="e.g. TheBloke/Mistral-7B-Instruct-v0.2-GGUF">
          <Input placeholder="user/repo-name-GGUF" style={{ fontFamily: 'monospace' }} />
        </Form.Item>
        <Form.Item name="filename" label="Filename in Repo" rules={[{ required: true }]}
          help="Exact .gguf filename inside the repo">
          <Input placeholder="model.Q4_K_M.gguf" style={{ fontFamily: 'monospace' }} />
        </Form.Item>
        <Form.Item name="save_as" label="Save As (optional)"
          help="Local filename to save as. Leave blank to use the original name.">
          <Input placeholder="model.gguf" style={{ fontFamily: 'monospace' }} />
        </Form.Item>
        <Form.Item name="hf_token" label="HuggingFace Token (optional)"
          help="Required only for gated / private repos">
          <Input.Password placeholder="hf_…" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  )

  // ── Hub browse tab content ──────────────────────────────────────────────────
  const HubTabContent = ({ hub }: { hub: HubKey }) => (
    <div>
      {hub === 'localai' && (
        <Alert type="info" showIcon icon={<InfoCircleOutlined />} style={{ marginBottom: 12 }}
          message="Catalog is fetched live from your LocalAI container. Ensure LocalAI is running." />
      )}
      {(hub === 'huggingface' || hub === 'llamacpp') && (
        <Alert type="info" showIcon icon={<InfoCircleOutlined />} style={{ marginBottom: 12 }}
          message={
            <span>
              GGUF files are saved to <code>DATA_DIR/models/llamacpp/</code>.
              Restart LlamaCpp to pick up new models.{' '}
              <Button type="link" size="small" style={{ padding: 0, height: 'auto' }}
                onClick={() => setHfModalOpen(true)}>
                Enter custom repo/file ↗
              </Button>
            </span>
          }
        />
      )}

      <Input
        prefix={<SearchOutlined />}
        placeholder={`Search ${HUB_LABELS[hub]}…`}
        value={search} onChange={e => setSearch(e.target.value)} allowClear
        style={{ marginBottom: 12 }}
      />

      <Spin spinning={hubLoading}>
        {!targetConfig ? (
          <Alert type="warning" message="Select a target backend above." showIcon />
        ) : available.length === 0 && !hubLoading ? (
          <Alert type="success" showIcon icon={<CheckCircleOutlined />}
            message={search ? 'No models match your search.' : 'All catalog models are already installed!'} />
        ) : (
          <Table
            columns={browseColumns(hub)}
            dataSource={available}
            rowKey="name"
            size="small"
            pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
          />
        )}
      </Spin>

      <ActivePullsPanel />
      <HFModal />
    </div>
  )

  // ── Tab items ────────────────────────────────────────────────────────────────
  const tabItems = [
    ...(['ollama', 'huggingface', 'localai', 'llamacpp'] as HubKey[]).map(hub => ({
      key: hub,
      label: HUB_LABELS[hub],
      children: <HubTabContent hub={hub} />,
    })),
    {
      key: 'installed',
      label: (
        <span>
          Installed{' '}
          {installed.length > 0 && (
            <Badge count={installed.length} size="small" color="#52c41a" />
          )}
        </span>
      ),
      children: (
        <div>
          {!targetConfig ? (
            <Alert type="warning" message="Select a target backend above." showIcon />
          ) : hubLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
          ) : installedRows.length === 0 ? (
            <Alert type="info" showIcon
              message={`No models installed on this backend (${HUB_LABELS[queryHub]}).`} />
          ) : (
            <Table
              columns={installedColumns}
              dataSource={installedRows}
              rowKey="name"
              size="small"
              pagination={false}
            />
          )}
          <ActivePullsPanel />
        </div>
      ),
    },
  ]

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Target backend selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Text style={{ whiteSpace: 'nowrap', color: '#aaa', fontSize: 12 }}>
          Target backend:
        </Text>
        <Select
          style={{ minWidth: 280 }}
          placeholder="Select which backend to pull into"
          value={targetId}
          onChange={v => { setTargetId(v); setSearch('') }}
          options={configs.map(c => ({
            value: c.id,
            label: (
              <span>
                {c.is_active && <Badge status="success" style={{ marginRight: 6 }} />}
                <strong>{c.name}</strong>
                <Text style={{ fontSize: 11, color: '#555', marginLeft: 8 }}>
                  {c.base_url}
                </Text>
              </span>
            ),
          }))}
        />
        <Tooltip title="Refresh installed / catalog">
          <Button size="small" icon={<ReloadOutlined />} onClick={() => refetchHub()} />
        </Tooltip>
      </div>

      <Divider style={{ margin: '0 0 0' }} />

      <Tabs
        activeKey={activeTab}
        onChange={key => { setActiveTab(key as TabKey); setSearch('') }}
        items={tabItems}
        type="card"
        style={{ marginTop: 16 }}
      />
    </div>
  )
}
