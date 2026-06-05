import React, { useState, useRef } from 'react'
import { Drawer, Button, Select as AntSelect, Input, Space, Divider, message, Spin, Tooltip, Tag, Collapse } from 'antd'
import { PlayCircleOutlined, PlusOutlined, DeleteOutlined, LinkOutlined } from '@ant-design/icons'
import api from '@/services/api'

interface ProcessingToolboxPanelProps {
  open: boolean
  onClose: () => void
  layerNames: string[]
  isReadOnly: boolean
  canDraw: boolean
}

interface Algorithm {
  key: string
  label: string
  description: string
  endpoint: string
  params: { key: string; label: string; type: 'layer' | 'text' | 'number'; default?: string | number }[]
  category: 'Analysis' | 'Geometry' | 'Data'
}

const ALGORITHMS: Algorithm[] = [
  // Analysis
  { key: 'buffer', label: 'Buffer', description: 'Create buffer zones around features', endpoint: '/projects/features/buffer/', category: 'Analysis', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'distance', label: 'Distance (m)', type: 'number', default: 100 }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'buffer_output' }] },
  { key: 'buffer-analysis', label: 'Buffer Analysis', description: 'Buffer with ring analysis', endpoint: '/projects/features/buffer/', category: 'Analysis', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'distance', label: 'Distance (m)', type: 'number', default: 500 }] },
  { key: 'spatial-join', label: 'Spatial Join', description: 'Join attributes from overlapping layer', endpoint: '/projects/features/spatial-join/', category: 'Analysis', params: [{ key: 'layer_name', label: 'Base Layer', type: 'layer' }, { key: 'join_layer', label: 'Join Layer', type: 'layer' }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'joined_output' }] },
  { key: 'near', label: 'Near Analysis', description: 'Find nearest features', endpoint: '/projects/features/near-analysis/', category: 'Analysis', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'near_layer', label: 'Near Layer', type: 'layer' }, { key: 'distance', label: 'Max Distance (m)', type: 'number', default: 1000 }] },
  // Geometry
  { key: 'dissolve', label: 'Dissolve', description: 'Merge features by field value', endpoint: '/projects/features/dissolve/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'field', label: 'Dissolve Field', type: 'text' }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'dissolved' }] },
  { key: 'clip', label: 'Clip', description: 'Clip layer to boundary', endpoint: '/projects/features/clip-to-boundary/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer to Clip', type: 'layer' }, { key: 'clip_layer', label: 'Clip Boundary', type: 'layer' }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'clipped' }] },
  { key: 'repair-geometry', label: 'Repair Geometry', description: 'Fix invalid geometries', endpoint: '/projects/features/repair-geometry/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }] },
  { key: 'auto-geometry-stats', label: 'Geometry Stats', description: 'Calculate area/length statistics', endpoint: '/projects/features/auto-geometry-stats/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }] },
  { key: 'convex-hull', label: 'Convex Hull', description: 'Compute convex hull of layer', endpoint: '/projects/features/convex-hull/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'convex_hull' }] },
  { key: 'centroids', label: 'Centroids', description: 'Extract polygon centroids', endpoint: '/projects/features/centroid-extract/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'centroids' }] },
  { key: 'simplify', label: 'Simplify', description: 'Simplify geometry by tolerance', endpoint: '/projects/features/simplify/', category: 'Geometry', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'tolerance', label: 'Tolerance (m)', type: 'number', default: 1 }, { key: 'output_layer', label: 'Output Layer', type: 'text', default: 'simplified' }] },
  // Data
  { key: 'find-replace', label: 'Find & Replace', description: 'Find and replace attribute values', endpoint: '/projects/features/find-replace/', category: 'Data', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'field_name', label: 'Field', type: 'text' }, { key: 'find_value', label: 'Find', type: 'text' }, { key: 'replace_value', label: 'Replace', type: 'text' }] },
  { key: 'remove-field', label: 'Remove Field', description: 'Remove an attribute field', endpoint: '/projects/features/remove-field/', category: 'Data', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'field_name', label: 'Field Name', type: 'text' }] },
  { key: 'rename-field', label: 'Rename Field', description: 'Rename an attribute field', endpoint: '/projects/features/rename-field/', category: 'Data', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }, { key: 'old_name', label: 'Old Name', type: 'text' }, { key: 'new_name', label: 'New Name', type: 'text' }] },
  { key: 'deduplicate', label: 'Deduplicate', description: 'Remove duplicate features', endpoint: '/projects/features/deduplicate/', category: 'Data', params: [{ key: 'layer_name', label: 'Layer', type: 'layer' }] },
]

interface WorkflowStep {
  id: string
  algorithmKey: string
  params: Record<string, string>
}

const dark = { background: '#0e0e1e', color: '#ccc', border: '1px solid #1a3050' }

export default function ProcessingToolboxPanel({ open, onClose, layerNames, isReadOnly, canDraw }: ProcessingToolboxPanelProps) {
  const [loading, setLoading] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { success: boolean; message: string }>>({})
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([])
  const [workflowName, setWorkflowName] = useState('')
  const [savedWorkflows, setSavedWorkflows] = useState<{ name: string; steps: WorkflowStep[] }[]>(() => {
    try { return JSON.parse(localStorage.getItem('raksha_workflows') || '[]') } catch { return [] }
  })
  const [stepParams, setStepParams] = useState<Record<string, Record<string, string>>>({})

  const readOnly = isReadOnly || !canDraw
  const canEdit = canDraw && !isReadOnly

  function getAlgorithm(key: string) {
    return ALGORITHMS.find(a => a.key === key)
  }

  async function runAlgorithm(alg: Algorithm, params: Record<string, string>, stepId?: string) {
    const id = stepId ?? alg.key
    setLoading(id)
    try {
      const r = await api.post(alg.endpoint, params)
      const msg = r.data?.detail || r.data?.message || JSON.stringify(r.data).slice(0, 80)
      setResults(prev => ({ ...prev, [id]: { success: true, message: msg } }))
      message.success(`${alg.label}: ${msg}`)
    } catch (err: any) {
      const msg = err?.response?.data?.detail || 'Error'
      setResults(prev => ({ ...prev, [id]: { success: false, message: msg } }))
      message.error(`${alg.label}: ${msg}`)
    } finally {
      setLoading(null)
    }
  }

  function AlgorithmCard({ alg }: { alg: Algorithm }) {
    const [localParams, setLocalParams] = useState<Record<string, string>>(() => {
      const p: Record<string, string> = {}
      alg.params.forEach(param => { p[param.key] = String(param.default ?? '') })
      return p
    })
    const res = results[alg.key]

    return (
      <div style={{ ...dark, borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#4fc3f7', marginBottom: 4 }}>{alg.label}</div>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 6 }}>{alg.description}</div>
        {alg.params.map(param => (
          <div key={param.key} style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 10, color: '#aaa', marginBottom: 2 }}>{param.label}</div>
            {param.type === 'layer' ? (
              <AntSelect
                size="small"
                style={{ width: '100%' }}
                disabled={readOnly}
                value={localParams[param.key] || undefined}
                onChange={v => setLocalParams(prev => ({ ...prev, [param.key]: v }))}
                options={layerNames.map(ln => ({ value: ln, label: ln }))}
                placeholder="Select layer"
              />
            ) : (
              <Input
                size="small"
                disabled={readOnly}
                type={param.type === 'number' ? 'number' : 'text'}
                value={localParams[param.key] ?? ''}
                onChange={e => setLocalParams(prev => ({ ...prev, [param.key]: e.target.value }))}
                placeholder={param.label}
              />
            )}
          </div>
        ))}
        {res && (
          <div style={{ fontSize: 10, color: res.success ? '#52c41a' : '#ff4d4f', margin: '4px 0' }}>
            {res.success ? '✓' : '✗'} {res.message}
          </div>
        )}
        <Button
          size="small"
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={loading === alg.key}
          disabled={readOnly}
          onClick={() => runAlgorithm(alg, localParams)}
          style={{ marginTop: 4, fontSize: 11 }}
        >
          Run
        </Button>
        {!canEdit && (
          <span style={{ fontSize: 10, color: '#faad14', marginLeft: 8 }}>
            {!canDraw ? 'No edit permission' : 'Switch to DRAFT area to edit'}
          </span>
        )}
      </div>
    )
  }

  const categories: Algorithm['category'][] = ['Analysis', 'Geometry', 'Data']
  const categoryColors: Record<string, string> = { Analysis: '#4fc3f7', Geometry: '#81c784', Data: '#ffb74d' }

  return (
    <Drawer
      title={
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#4fc3f7' }}>Processing Toolbox</div>
          <div style={{ fontSize: 10, color: canEdit ? '#52c41a' : '#faad14' }}>
            {canEdit ? 'Active — editing enabled' : 'Read-only — switch to a DRAFT area'}
          </div>
        </div>
      }
      open={open}
      onClose={onClose}
      placement="right"
      width={380}
      styles={{ body: { background: '#0e0e1e', padding: '8px 12px' }, header: { background: '#0e0e1e', borderBottom: '1px solid #1a3050' } }}
      maskClosable={false}
    >
      <div style={{ fontSize: 10, color: '#faad14', marginBottom: 8 }}>
        Only active for DRAFT/RETURNED areas. {isReadOnly ? 'Read-only' : canDraw ? '' : 'No permission.'}
      </div>

      {categories.map(cat => (
        <div key={cat} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: categoryColors[cat], marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
            {cat}
          </div>
          {ALGORITHMS.filter(a => a.category === cat).map(alg => (
            <AlgorithmCard key={alg.key} alg={alg} />
          ))}
        </div>
      ))}

      <Divider style={{ borderColor: '#1a3050', margin: '16px 0 8px' }} />
      <div style={{ fontSize: 11, fontWeight: 700, color: '#4fc3f7', marginBottom: 8 }}>Workflow</div>
      <div style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
        Chain multiple operations together. Each step's output layer becomes available for the next step.
      </div>
      <Button
        size="small"
        icon={<PlusOutlined />}
        style={{ marginBottom: 8, fontSize: 11 }}
        onClick={() => {
          const id = `step_${Date.now()}`
          setWorkflowSteps(prev => [...prev, { id, algorithmKey: ALGORITHMS[0].key, params: {} }])
        }}
      >Add Step</Button>
      {workflowSteps.map((step, idx) => {
        const alg = getAlgorithm(step.algorithmKey)
        return (
          <div key={step.id} style={{ ...dark, borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
              <Tag color="blue" style={{ fontSize: 10 }}>Step {idx + 1}</Tag>
              <AntSelect
                size="small"
                style={{ flex: 1 }}
                value={step.algorithmKey}
                onChange={v => setWorkflowSteps(prev => prev.map(s => s.id === step.id ? { ...s, algorithmKey: v, params: {} } : s))}
                options={ALGORITHMS.map(a => ({ value: a.key, label: a.label }))}
              />
              <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#666' }}
                onClick={() => setWorkflowSteps(prev => prev.filter(s => s.id !== step.id))} />
            </div>
            {alg?.params.map(param => (
              <div key={param.key} style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: '#aaa', marginBottom: 2 }}>{param.label}</div>
                {param.type === 'layer' ? (
                  <AntSelect
                    size="small"
                    style={{ width: '100%' }}
                    disabled={readOnly}
                    value={step.params[param.key] || undefined}
                    onChange={v => setWorkflowSteps(prev => prev.map(s => s.id === step.id ? { ...s, params: { ...s.params, [param.key]: v } } : s))}
                    options={[
                      ...layerNames.map(ln => ({ value: ln, label: ln })),
                      ...workflowSteps.filter((_, i) => i < idx).map((s, i) => {
                        const a = getAlgorithm(s.algorithmKey)
                        return { value: s.params['output_layer'] || `step_${i + 1}_output`, label: `↳ Step ${i + 1} output` }
                      }),
                    ]}
                    placeholder="Select layer"
                  />
                ) : (
                  <Input
                    size="small"
                    disabled={readOnly}
                    type={param.type === 'number' ? 'number' : 'text'}
                    value={step.params[param.key] ?? String(param.default ?? '')}
                    onChange={e => setWorkflowSteps(prev => prev.map(s => s.id === step.id ? { ...s, params: { ...s.params, [param.key]: e.target.value } } : s))}
                    placeholder={param.label}
                  />
                )}
              </div>
            ))}
          </div>
        )
      })}
      {workflowSteps.length > 0 && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={readOnly}
            loading={!!loading}
            style={{ width: '100%', fontSize: 11 }}
            onClick={async () => {
              for (const step of workflowSteps) {
                const alg = getAlgorithm(step.algorithmKey)
                if (!alg) continue
                await runAlgorithm(alg, step.params, step.id)
              }
            }}
          >Run Workflow ({workflowSteps.length} steps)</Button>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              size="small"
              value={workflowName}
              onChange={e => setWorkflowName(e.target.value)}
              placeholder="Workflow name"
            />
            <Button
              size="small"
              onClick={() => {
                if (!workflowName.trim()) { message.warning('Enter a workflow name'); return }
                const wf = [...savedWorkflows, { name: workflowName.trim(), steps: workflowSteps }]
                setSavedWorkflows(wf)
                localStorage.setItem('raksha_workflows', JSON.stringify(wf))
                setWorkflowName('')
                message.success('Workflow saved')
              }}
            >Save</Button>
          </Space.Compact>
        </Space>
      )}
      {savedWorkflows.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: '#aaa', marginBottom: 4 }}>Saved Workflows:</div>
          {savedWorkflows.map((wf, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <span style={{ flex: 1, fontSize: 11, color: '#4fc3f7' }}>{wf.name} ({wf.steps.length} steps)</span>
              <Button size="small" type="text" style={{ fontSize: 10, color: '#aaa' }} onClick={() => setWorkflowSteps(wf.steps)}>Load</Button>
              <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#666' }}
                onClick={() => {
                  const updated = savedWorkflows.filter((_, j) => j !== i)
                  setSavedWorkflows(updated)
                  localStorage.setItem('raksha_workflows', JSON.stringify(updated))
                }} />
            </div>
          ))}
        </div>
      )}
    </Drawer>
  )
}
