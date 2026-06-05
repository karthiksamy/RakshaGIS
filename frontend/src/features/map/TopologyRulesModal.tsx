import React, { useState } from 'react'
import { Modal, Button, Select as AntSelect, Input, Space, Table, Tag, message, InputNumber, Switch, Divider, Spin, Collapse } from 'antd'
import { PlusOutlined, DeleteOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import DraggableModal from '@/components/DraggableModal'

interface TopologyRulesModalProps {
  open: boolean
  onClose: () => void
  projectId: number
  layerNames: string[]
  onViolationsFound: (geojson: any) => void
}

const RULE_TYPES = [
  { value: 'MUST_NOT_OVERLAP', label: 'Polygons must not overlap' },
  { value: 'MUST_BE_INSIDE', label: 'Features must be inside another layer' },
  { value: 'MUST_NOT_HAVE_GAPS', label: 'Polygons must not have gaps' },
  { value: 'MUST_NOT_DANGLE', label: 'Lines must not have dangling ends' },
  { value: 'MUST_COVER_EACH_OTHER', label: 'Layers must cover each other' },
]

const NEEDS_LAYER_B = ['MUST_BE_INSIDE', 'MUST_COVER_EACH_OTHER']

export default function TopologyRulesModal({ open, onClose, projectId, layerNames, onViolationsFound }: TopologyRulesModalProps) {
  const qc = useQueryClient()
  const [newRule, setNewRule] = useState({ rule_type: 'MUST_NOT_OVERLAP', layer_a: '', layer_b: '', tolerance: 0.00001, description: '' })
  const [checking, setChecking] = useState(false)
  const [violations, setViolations] = useState<any[] | null>(null)
  const [violationStats, setViolationStats] = useState<{ count: number; rules_checked: number } | null>(null)

  // Legacy DefenceParcel quick-check (old topology API)
  const [legacyChecking, setLegacyChecking] = useState(false)
  const [legacyIssues, setLegacyIssues] = useState<any[] | null>(null)

  async function runLegacyCheck() {
    setLegacyChecking(true)
    setLegacyIssues(null)
    try {
      const r = await api.get(`/projects/topology/?project=${projectId}`)
      const issues = r.data.issues ?? []
      setLegacyIssues(issues)
      if (issues.length === 0) message.success('No DefenceParcel topology issues found')
      else message.warning(`${issues.length} DefenceParcel issue(s) found`)
    } catch {
      message.error('DefenceParcel check failed')
    } finally {
      setLegacyChecking(false)
    }
  }

  const { data: rules = [], isLoading } = useQuery<any[]>({
    queryKey: ['topology-rules', projectId],
    queryFn: () => api.get(`/projects/topology-rules/?project=${projectId}`).then(r => r.data.results ?? r.data),
    enabled: open && !!projectId,
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/projects/topology-rules/', { ...data, project: projectId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topology-rules', projectId] })
      setNewRule({ rule_type: 'MUST_NOT_OVERLAP', layer_a: '', layer_b: '', tolerance: 0.00001, description: '' })
      message.success('Rule added')
    },
    onError: (err: any) => message.error(err?.response?.data?.detail || 'Failed to add rule'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/topology-rules/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topology-rules', projectId] })
      message.success('Rule deleted')
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/projects/topology-rules/${id}/`, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['topology-rules', projectId] }),
  })

  async function runCheck() {
    setChecking(true)
    setViolations(null)
    try {
      const r = await api.post('/projects/topology-rules/check/', { project: projectId })
      const data = r.data
      setViolations(data.features ?? [])
      setViolationStats({ count: data.violation_count ?? 0, rules_checked: data.rules_checked ?? 0 })
      if (data.violation_count > 0) {
        message.warning(`${data.violation_count} topology violation(s) found`)
      } else {
        message.success('No topology violations found')
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Check failed')
    } finally {
      setChecking(false)
    }
  }

  const needsLayerB = NEEDS_LAYER_B.includes(newRule.rule_type)

  const inputStyle = { background: '#0d1a2a', borderColor: '#1a3050', color: '#ccc' }

  return (
    <DraggableModal
      title="Topology Rule Engine"
      open={open}
      onCancel={onClose}
      footer={null}
      width={700}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {/* Add Rule */}
        <div style={{ background: '#0d1a2a', border: '1px solid #1a3050', borderRadius: 6, padding: '12px 14px' }}>
          <div style={{ fontSize: 11, color: '#4fc3f7', fontWeight: 600, marginBottom: 8 }}>Add New Rule</div>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: '#aaa', marginBottom: 3 }}>Rule Type</div>
                <AntSelect
                  size="small"
                  style={{ width: '100%' }}
                  value={newRule.rule_type}
                  onChange={v => setNewRule(prev => ({ ...prev, rule_type: v }))}
                  options={RULE_TYPES}
                />
              </div>
              <div style={{ width: 120 }}>
                <div style={{ fontSize: 10, color: '#aaa', marginBottom: 3 }}>Tolerance</div>
                <InputNumber
                  size="small"
                  style={{ width: '100%' }}
                  value={newRule.tolerance}
                  step={0.00001}
                  onChange={v => setNewRule(prev => ({ ...prev, tolerance: v ?? 0.00001 }))}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: '#aaa', marginBottom: 3 }}>Primary Layer (A)</div>
                <AntSelect
                  size="small"
                  style={{ width: '100%' }}
                  value={newRule.layer_a || undefined}
                  onChange={v => setNewRule(prev => ({ ...prev, layer_a: v }))}
                  options={layerNames.map(ln => ({ value: ln, label: ln }))}
                  placeholder="Select layer A"
                />
              </div>
              {needsLayerB && (
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: '#aaa', marginBottom: 3 }}>Secondary Layer (B)</div>
                  <AntSelect
                    size="small"
                    style={{ width: '100%' }}
                    value={newRule.layer_b || undefined}
                    onChange={v => setNewRule(prev => ({ ...prev, layer_b: v }))}
                    options={layerNames.map(ln => ({ value: ln, label: ln }))}
                    placeholder="Select layer B"
                  />
                </div>
              )}
            </div>
            <Input
              size="small"
              placeholder="Description (optional)"
              value={newRule.description}
              onChange={e => setNewRule(prev => ({ ...prev, description: e.target.value }))}
              style={inputStyle}
            />
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              loading={createMutation.isPending}
              disabled={!newRule.layer_a || (needsLayerB && !newRule.layer_b)}
              onClick={() => createMutation.mutate(newRule)}
            >Add Rule</Button>
          </Space>
        </div>

        {/* Rules List */}
        {isLoading ? <Spin /> : (
          <div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>
              Active Rules ({rules.filter((r: any) => r.is_active).length} / {rules.length})
            </div>
            {rules.length === 0 ? (
              <div style={{ color: '#555', fontSize: 11, textAlign: 'center', padding: '12px 0' }}>No rules defined yet</div>
            ) : (
              rules.map((rule: any) => (
                <div key={rule.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  marginBottom: 4, borderRadius: 4,
                  background: rule.is_active ? '#0d1a2a' : 'transparent',
                  border: '1px solid #1a3050',
                }}>
                  <Switch
                    size="small"
                    checked={rule.is_active}
                    onChange={v => toggleMutation.mutate({ id: rule.id, is_active: v })}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: rule.is_active ? '#4fc3f7' : '#555' }}>
                      {rule.rule_type_display}
                    </div>
                    <div style={{ fontSize: 10, color: '#666' }}>
                      {rule.layer_a}{rule.layer_b ? ` → ${rule.layer_b}` : ''}
                      {rule.description && ` — ${rule.description}`}
                    </div>
                  </div>
                  <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#666' }}
                    onClick={() => deleteMutation.mutate(rule.id)} />
                </div>
              ))
            )}
          </div>
        )}

        <Divider style={{ borderColor: '#1a3050', margin: '4px 0' }} />

        {/* Run Check */}
        <div>
          <Button
            type="primary"
            icon={checking ? undefined : <CheckCircleOutlined />}
            loading={checking}
            disabled={rules.filter((r: any) => r.is_active).length === 0}
            onClick={runCheck}
          >
            Run Topology Check
          </Button>
          {violationStats && (
            <span style={{ marginLeft: 12, fontSize: 12, color: violationStats.count > 0 ? '#faad14' : '#52c41a' }}>
              {violationStats.count > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
              {' '}{violationStats.count} violation(s) in {violationStats.rules_checked} rule(s)
            </span>
          )}
        </div>

        {violations && violations.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: '#faad14', fontWeight: 600 }}>Violations:</div>
              <Button
                size="small"
                type="primary"
                danger
                onClick={() => onViolationsFound({ type: 'FeatureCollection', features: violations, violation_count: violations.length })}
              >
                Show on Map
              </Button>
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {violations.map((v: any, i: number) => (
                <div key={i} style={{ fontSize: 11, color: '#ff7875', padding: '3px 6px', borderBottom: '1px solid #1a3050' }}>
                  {v.properties?.description || `Violation ${i + 1}`}
                </div>
              ))}
            </div>
          </div>
        )}

        <Divider style={{ borderColor: '#1a3050', margin: '8px 0' }} />

        {/* DefenceParcel Quick Check (legacy) */}
        <Collapse
          ghost
          items={[{
            key: 'legacy',
            label: <span style={{ fontSize: 11, color: '#aaa' }}>DefenceParcel Quick Check (INVALID_GEOMETRY + OVERLAP)</span>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                <div style={{ fontSize: 10, color: '#555' }}>
                  Checks the DefenceParcel geometry table for invalid geometries and overlapping parcels — separate from the GISFeature rule engine above.
                </div>
                <Button
                  size="small"
                  icon={<CheckCircleOutlined />}
                  loading={legacyChecking}
                  onClick={runLegacyCheck}
                >
                  Run DefenceParcel Check
                </Button>
                {legacyIssues !== null && (
                  legacyIssues.length === 0 ? (
                    <div style={{ color: '#52c41a', fontSize: 11 }}>✓ No issues found</div>
                  ) : (
                    <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                      {legacyIssues.map((issue: any, i: number) => (
                        <div key={i} style={{ fontSize: 11, color: '#ff7875', padding: '3px 6px', borderBottom: '1px solid #1a3050' }}>
                          <Tag color={issue.type === 'OVERLAP' ? 'orange' : 'red'} style={{ fontSize: 10 }}>{issue.type}</Tag>
                          Parcel {issue.parcel_a?.parcel_id} — {issue.parcel_a?.name}
                          {issue.parcel_b && <> & {issue.parcel_b?.parcel_id}</>}
                        </div>
                      ))}
                    </div>
                  )
                )}
              </Space>
            ),
          }]}
        />
      </Space>
    </DraggableModal>
  )
}
