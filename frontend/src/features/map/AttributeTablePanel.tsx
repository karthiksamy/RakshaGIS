import { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Select, Button, Space, Input, Modal, message, Tooltip, Tabs, Tag,
  Form, Popconfirm, Badge, Radio, Divider, Switch, InputNumber,
} from 'antd'
import {
  EditOutlined, SaveOutlined, CloseOutlined, DownloadOutlined,
  CalculatorOutlined, DeleteOutlined, PlusOutlined, SwapOutlined,
  TableOutlined, HistoryOutlined, SettingOutlined, ToolOutlined,
  FilterOutlined, ReloadOutlined, CheckOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import type { GISFeature } from '@/types'

interface Props {
  open: boolean
  onClose: () => void
  projectId: number | null
  onFeatureZoom: (featureId: number) => void
  isReadOnly?: boolean          // disables Edit / Delete for all rows
  areaFolderIds?: Set<number> | null  // when set, only show features from this area
}

const DOMAINS_KEY = (pid: number, ln: string, field: string) =>
  `raksha_domain_${pid}_${ln}_${field}`

function getDomain(pid: number, ln: string, field: string): string[] {
  try { return JSON.parse(localStorage.getItem(DOMAINS_KEY(pid, ln, field)) || '[]') } catch { return [] }
}
function setDomain(pid: number, ln: string, field: string, vals: string[]) {
  localStorage.setItem(DOMAINS_KEY(pid, ln, field), JSON.stringify(vals))
}

export default function AttributeTablePanel({ open, onClose, projectId, onFeatureZoom, isReadOnly = false, areaFolderIds }: Props) {
  const qc = useQueryClient()

  // Filter state
  const [layerFilter, setLayerFilter] = useState<string | undefined>(undefined)
  const [searchText, setSearchText] = useState('')

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editedAttrs, setEditedAttrs] = useState<Record<string, unknown>>({})
  const [editedFeatureId, setEditedFeatureId] = useState<string>('')

  // Row selection
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([])

  // Bulk edit
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkFields, setBulkFields] = useState<{ field: string; value: string }[]>([{ field: '', value: '' }])
  const [bulkLoading, setBulkLoading] = useState(false)

  // Bulk delete
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // Field calculator
  const [calcOpen, setCalcOpen] = useState(false)
  const [calcField, setCalcField] = useState('')
  const [calcExpr, setCalcExpr] = useState('')
  const [calcTarget, setCalcTarget] = useState<'selected' | 'all'>('all')

  // Schema tab
  const [addFieldOpen, setAddFieldOpen] = useState(false)
  const [newFieldName, setNewFieldName] = useState('')
  const [newFieldDefault, setNewFieldDefault] = useState('')
  const [renameFieldOpen, setRenameFieldOpen] = useState<{ old: string } | null>(null)
  const [renameFieldNew, setRenameFieldNew] = useState('')
  const [domainEditField, setDomainEditField] = useState<string | null>(null)
  const [domainValues, setDomainValues] = useState<string[]>([])
  const [domainInput, setDomainInput] = useState('')

  // Operations tab
  const [renameLayerOpen, setRenameLayerOpen] = useState(false)
  const [renameLayerNew, setRenameLayerNew] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeTarget, setMergeTarget] = useState('')
  const [mergeDeleteSource, setMergeDeleteSource] = useState(false)
  const [opLoading, setOpLoading] = useState(false)

  // Tab
  const [activeTab, setActiveTab] = useState('data')

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: features = [], isLoading } = useQuery<GISFeature[]>({
    queryKey: ['attr-table-features', projectId],
    queryFn: () =>
      projectId
        ? api.get(`/projects/features/?project=${projectId}&is_deleted=false`).then(r => r.data.results ?? r.data)
        : Promise.resolve([]),
    enabled: !!projectId && open,
  })

  const { data: schema = { fields: [], feature_count: 0 }, refetch: refetchSchema } = useQuery({
    queryKey: ['layer-schema', projectId, layerFilter],
    queryFn: () =>
      projectId
        ? api.get(`/projects/features/layer-schema/?project=${projectId}${layerFilter ? `&layer_name=${layerFilter}` : ''}`).then(r => r.data)
        : Promise.resolve({ fields: [], feature_count: 0 }),
    enabled: !!projectId && open && activeTab === 'schema',
  })

  // ── Mutations ──────────────────────────────────────────────────────────────

  const updateMut = useMutation({
    mutationFn: ({ id, attributes, feature_id }: { id: number; attributes: Record<string, unknown>; feature_id?: string }) =>
      api.patch(`/projects/features/${id}/`, { attributes, ...(feature_id !== undefined ? { feature_id } : {}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
      qc.invalidateQueries({ queryKey: ['map-features', projectId] })
      setEditingId(null)
      message.success('Saved')
    },
    onError: () => message.error('Save failed'),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/features/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
      qc.invalidateQueries({ queryKey: ['map-features', projectId] })
      message.success('Deleted')
    },
  })

  async function applyBulkEdit() {
    const validPairs = bulkFields.filter(p => p.field.trim())
    if (!validPairs.length) { message.warning('Add at least one field to update'); return }
    setBulkLoading(true)
    let ok = 0, fail = 0
    for (const id of selectedRowKeys) {
      const feat = features.find(f => f.id === id)
      const patch: Record<string, unknown> = {}
      validPairs.forEach(p => { patch[p.field.trim()] = p.value })
      try {
        await api.patch(`/projects/features/${id}/`, { attributes: { ...(feat?.attributes ?? {}), ...patch } })
        ok++
      } catch { fail++ }
    }
    setBulkLoading(false)
    setBulkEditOpen(false)
    setBulkFields([{ field: '', value: '' }])
    qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
    qc.invalidateQueries({ queryKey: ['map-features', projectId] })
    message.success(`Updated ${ok} feature(s)${fail ? `, ${fail} failed` : ''}`)
  }

  async function applyBulkDelete() {
    setBulkLoading(true)
    let ok = 0
    for (const id of selectedRowKeys) {
      try { await api.delete(`/projects/features/${id}/`); ok++ } catch { /* skip */ }
    }
    setBulkLoading(false)
    setBulkDeleteOpen(false)
    setSelectedRowKeys([])
    qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
    qc.invalidateQueries({ queryKey: ['map-features', projectId] })
    message.success(`Deleted ${ok} feature(s)`)
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const layerNames = useMemo(() => [...new Set(features.map(f => f.layer_name))].filter(Boolean), [features])
  const rows = useMemo(() => {
    let r = features
    // Filter to selected survey area's folders when provided
    if (areaFolderIds != null) {
      r = r.filter(f => f.folder != null && areaFolderIds.has(f.folder))
    }
    if (layerFilter) r = r.filter(f => f.layer_name === layerFilter)
    if (searchText) {
      const q = searchText.toLowerCase()
      r = r.filter(f =>
        String(f.id).includes(q) || f.layer_name?.toLowerCase().includes(q) ||
        f.feature_id?.toLowerCase().includes(q) ||
        Object.values(f.attributes ?? {}).some(v => String(v).toLowerCase().includes(q))
      )
    }
    return r
  }, [features, areaFolderIds, layerFilter, searchText])

  const attrKeys = useMemo(() =>
    [...new Set(rows.flatMap(f => Object.keys(f.attributes ?? {})))],
    [rows]
  )

  // ── Helpers ────────────────────────────────────────────────────────────────

  function downloadCSV() {
    const headers = ['id', 'layer_name', 'geometry_type', 'feature_id', 'created_at', ...attrKeys]
    const csv = [headers, ...rows.map(f => [
      f.id, f.layer_name, f.geometry_type, f.feature_id, f.created_at,
      ...attrKeys.map(k => String(f.attributes?.[k] ?? ''))
    ])].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
      download: `features_${projectId}_${layerFilter ?? 'all'}.csv`,
    })
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function downloadGeoJSON() {
    const feats = rows.map(f => ({
      type: 'Feature', geometry: f.geometry,
      properties: { id: f.id, layer_name: f.layer_name, feature_id: f.feature_id, ...f.attributes },
    }))
    const fc = JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 2)
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([fc], { type: 'application/json' })),
      download: `features_${projectId}_${layerFilter ?? 'all'}.geojson`,
    })
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function applyFieldCalc() {
    if (!calcField) { message.warning('Enter a field name'); return }
    const targets = calcTarget === 'selected' && selectedRowKeys.length
      ? rows.filter(f => selectedRowKeys.includes(f.id))
      : rows
    const promises = targets.map(f => {
      let value: unknown = calcExpr
      try {
        const resolved = calcExpr.replace(/\$\{(\w+)\}/g, (_, k) => String(f.attributes?.[k] ?? ''))
        if (/^[-\d+*/.() ]+$/.test(resolved.trim())) {
          // eslint-disable-next-line no-new-func
          value = Function(`"use strict";return(${resolved})`)()
        } else {
          value = resolved
        }
      } catch (_) {}
      return api.patch(`/projects/features/${f.id}/`, { attributes: { ...f.attributes, [calcField]: value } })
    })
    await Promise.allSettled(promises)
    qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
    qc.invalidateQueries({ queryKey: ['map-features', projectId] })
    message.success(`Updated "${calcField}" on ${targets.length} feature(s)`)
    setCalcOpen(false)
  }

  async function addField() {
    if (!newFieldName.trim()) { message.warning('Enter a field name'); return }
    const targets = layerFilter ? features.filter(f => f.layer_name === layerFilter) : features
    await Promise.allSettled(targets.map(f =>
      api.patch(`/projects/features/${f.id}/`, { attributes: { ...f.attributes, [newFieldName]: newFieldDefault || null } })
    ))
    qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
    qc.invalidateQueries({ queryKey: ['map-features', projectId] })
    message.success(`Added field "${newFieldName}" to ${targets.length} feature(s)`)
    setAddFieldOpen(false)
    setNewFieldName('')
    setNewFieldDefault('')
  }

  async function removeField(fieldName: string) {
    if (!projectId) return
    setOpLoading(true)
    try {
      const r = await api.post('/projects/features/remove-field/', {
        project: projectId, layer_name: layerFilter ?? '', field_name: fieldName,
      })
      message.success(r.data.detail)
      qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
      qc.invalidateQueries({ queryKey: ['map-features', projectId] })
      refetchSchema()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Failed')
    } finally { setOpLoading(false) }
  }

  async function renameFieldSubmit() {
    if (!renameFieldOpen || !renameFieldNew.trim()) return
    if (!projectId) return
    setOpLoading(true)
    try {
      const r = await api.post('/projects/features/rename-field/', {
        project: projectId, layer_name: layerFilter ?? '', old_field: renameFieldOpen.old, new_field: renameFieldNew,
      })
      message.success(r.data.detail)
      qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
      qc.invalidateQueries({ queryKey: ['map-features', projectId] })
      refetchSchema()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Failed')
    } finally { setOpLoading(false); setRenameFieldOpen(null) }
  }

  async function callOp(url: string, body: Record<string, unknown>, successMsg?: string) {
    if (!projectId) return
    setOpLoading(true)
    try {
      const r = await api.post(url, { project: projectId, ...body })
      message.success(successMsg ?? r.data.detail)
      qc.invalidateQueries({ queryKey: ['attr-table-features', projectId] })
      qc.invalidateQueries({ queryKey: ['map-features', projectId] })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || 'Operation failed')
    } finally { setOpLoading(false) }
  }

  // ── Table columns ──────────────────────────────────────────────────────────

  const attrColumns: ColumnsType<GISFeature> = attrKeys.map(k => ({
    title: (
      <span style={{ fontSize: 11 }} title={k}>{k}</span>
    ),
    key: k,
    width: 120,
    ellipsis: true,
    render: (_: unknown, record: GISFeature) => {
      const domain = projectId ? getDomain(projectId, record.layer_name, k) : []
      if (editingId === record.id) {
        const val = String(editedAttrs[k] ?? record.attributes?.[k] ?? '')
        return domain.length > 0 ? (
          <Select size="small" value={val} onChange={v => setEditedAttrs(p => ({ ...p, [k]: v }))}
            style={{ width: '100%', fontSize: 11 }}
            options={domain.map(d => ({ value: d, label: d }))} />
        ) : (
          <Input size="small" value={val}
            onChange={e => setEditedAttrs(p => ({ ...p, [k]: e.target.value }))}
            style={{ fontSize: 11 }} />
        )
      }
      const v = String(record.attributes?.[k] ?? '')
      return <span style={{ fontSize: 11, color: '#ccc' }} title={v}>{v}</span>
    },
  }))

  const columns: ColumnsType<GISFeature> = [
    {
      title: 'ID', dataIndex: 'id', width: 55, fixed: 'left',
      render: id => (
        <Button type="link" size="small" style={{ padding: 0, fontSize: 11 }} onClick={() => onFeatureZoom(id)}>{id}</Button>
      ),
    },
    {
      title: 'Feature ID', dataIndex: 'feature_id', width: 90, fixed: 'left',
      render: (v, record) =>
        editingId === record.id
          ? <Input size="small" value={editedFeatureId} onChange={e => setEditedFeatureId(e.target.value)} style={{ fontSize: 11 }} />
          : <span style={{ fontSize: 11, color: '#90caf9' }}>{v}</span>,
    },
    { title: 'Layer', dataIndex: 'layer_name', width: 110, ellipsis: true, fixed: 'left',
      render: v => <span style={{ fontSize: 11, color: '#4fc3f7' }}>{v}</span> },
    { title: 'Type', dataIndex: 'geometry_type', width: 75,
      render: v => <Tag style={{ fontSize: 9 }}>{v}</Tag> },
    ...attrColumns,
    { title: 'Created', dataIndex: 'created_at', width: 90, ellipsis: true,
      render: v => <span style={{ fontSize: 10, color: '#666' }}>{new Date(v).toLocaleDateString()}</span> },
    {
      title: '',
      key: '_act',
      width: 80,
      fixed: 'right',
      render: (_, record) =>
        editingId === record.id ? (
          <Space size={2}>
            <Button size="small" type="primary" icon={<SaveOutlined />} loading={updateMut.isPending}
              onClick={() => updateMut.mutate({ id: record.id, attributes: { ...record.attributes, ...editedAttrs }, feature_id: editedFeatureId })} />
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setEditingId(null)} style={{ color: '#888' }} />
          </Space>
        ) : (
          <Space size={2}>
            <Tooltip title={isReadOnly ? 'Read-only — area is approved or in review' : 'Edit row'}>
              <Button size="small" type="text" icon={<EditOutlined />}
                style={{ color: isReadOnly ? '#444' : '#4fc3f7' }}
                disabled={isReadOnly}
                onClick={() => { if (!isReadOnly) { setEditingId(record.id); setEditedAttrs(record.attributes ?? {}); setEditedFeatureId(record.feature_id ?? '') } }} />
            </Tooltip>
            <Tooltip title={isReadOnly ? 'Read-only — area is approved or in review' : 'Delete feature'}>
              <Popconfirm
                title={`Delete feature #${record.id}?`}
                onConfirm={() => deleteMut.mutate(record.id)}
                disabled={isReadOnly}
              >
                <Button size="small" type="text" icon={<DeleteOutlined />} danger disabled={isReadOnly} />
              </Popconfirm>
            </Tooltip>
          </Space>
        ),
    },
  ]

  if (!open) return null

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, height: 300,
        background: '#08090f', borderTop: '2px solid #1a3a5a', zIndex: 30,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', padding: '4px 10px',
          borderBottom: '1px solid #1a1a2e', gap: 8, flexShrink: 0, background: '#0a0e1a',
        }}>
          <span style={{ color: '#4fc3f7', fontWeight: 700, fontSize: 11, letterSpacing: 1 }}>FEATURE EDITOR</span>
          <Badge count={rows.length} size="small" style={{ background: '#1a3a4a' }} overflowCount={9999} />
          <Select size="small" placeholder="All layers" allowClear style={{ width: 150, fontSize: 11 }}
            value={layerFilter} onChange={v => { setLayerFilter(v); setSelectedRowKeys([]) }}
            options={layerNames.map(n => ({ value: n, label: n }))} />
          <Input.Search size="small" placeholder="Search…" style={{ width: 160, fontSize: 11 }}
            value={searchText} onChange={e => setSearchText(e.target.value)} allowClear />
          <div style={{ flex: 1 }} />
          {selectedRowKeys.length > 0 && (
            <>
              <span style={{ color: '#faad14', fontSize: 11 }}>{selectedRowKeys.length} selected</span>
              <Button size="small" icon={<EditOutlined />} type="primary" disabled={isReadOnly}
                onClick={() => { if (!isReadOnly) { setBulkFields([{ field: '', value: '' }]); setBulkEditOpen(true) } }}
                style={{ fontSize: 11, background: isReadOnly ? undefined : '#1565c0' }}>Bulk Edit</Button>
              <Popconfirm
                title={`Delete ${selectedRowKeys.length} selected feature(s)?`}
                description="This action cannot be undone."
                onConfirm={applyBulkDelete}
                okText="Delete" okButtonProps={{ danger: true }}
                disabled={isReadOnly}
              >
                <Button size="small" danger icon={<DeleteOutlined />} disabled={isReadOnly} style={{ fontSize: 11 }}>Delete</Button>
              </Popconfirm>
              <Button size="small" type="text" icon={<CloseOutlined />}
                onClick={() => setSelectedRowKeys([])} style={{ fontSize: 11, color: '#666' }}>Clear</Button>
            </>
          )}
          <Button size="small" icon={<CalculatorOutlined />} onClick={() => setCalcOpen(true)} style={{ fontSize: 11 }}>Field Calc</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={downloadCSV} style={{ fontSize: 11 }}>CSV</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={downloadGeoJSON} style={{ fontSize: 11 }}>GeoJSON</Button>
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} style={{ color: '#666' }} />
        </div>

        {/* Tabs */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Tabs
            size="small"
            activeKey={activeTab}
            onChange={setActiveTab}
            tabBarStyle={{ margin: '0 10px', marginBottom: 0, fontSize: 11 }}
            style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            items={[
              {
                key: 'data',
                label: <span><TableOutlined /> Data</span>,
                children: (
                  <div style={{ height: 210, overflow: 'auto' }}>
                    <Table<GISFeature>
                      dataSource={rows} columns={columns} rowKey="id" size="small"
                      loading={isLoading} pagination={{ pageSize: 100, size: 'small' }}
                      scroll={{ x: 'max-content', y: 160 }}
                      rowSelection={{
                        selectedRowKeys, type: 'checkbox',
                        onChange: keys => setSelectedRowKeys(keys as number[]),
                        selections: [Table.SELECTION_ALL, Table.SELECTION_NONE, Table.SELECTION_INVERT],
                      }}
                      onRow={record => ({
                        onDoubleClick: () => onFeatureZoom(record.id),
                        style: { cursor: 'pointer', fontSize: 11, background: editingId === record.id ? '#0d2035' : undefined },
                      })}
                      locale={{ emptyText: projectId ? 'No features.' : 'Select a project first.' }}
                    />
                  </div>
                ),
              },
              {
                key: 'schema',
                label: <span><SettingOutlined /> Schema</span>,
                children: (
                  <div style={{ padding: '8px 10px', height: 210, overflow: 'auto' }}>
                    <Space style={{ marginBottom: 8 }}>
                      <Button size="small" icon={<PlusOutlined />} onClick={() => setAddFieldOpen(true)}>Add Field</Button>
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => refetchSchema()}>Refresh</Button>
                    </Space>
                    <Table
                      size="small"
                      pagination={false}
                      scroll={{ y: 150 }}
                      dataSource={schema.fields}
                      rowKey="name"
                      columns={[
                        { title: 'Field', dataIndex: 'name', width: 140, render: v => <code style={{ color: '#4fc3f7', fontSize: 11 }}>{v}</code> },
                        { title: 'Type', dataIndex: 'type', width: 80, render: v => <Tag style={{ fontSize: 10 }}>{v}</Tag> },
                        { title: 'Sample', dataIndex: 'sample', ellipsis: true, render: v => <span style={{ fontSize: 10, color: '#888' }}>{v}</span> },
                        {
                          title: 'Domain', width: 70,
                          render: (_, row: any) => {
                            const d = projectId ? getDomain(projectId, layerFilter ?? '', row.name) : []
                            return (
                              <Button size="small" type={d.length ? 'primary' : 'text'} style={{ fontSize: 10, padding: '0 4px' }}
                                onClick={() => {
                                  setDomainEditField(row.name)
                                  setDomainValues(d)
                                  setDomainInput(d.join(', '))
                                }}>
                                {d.length ? `${d.length} vals` : 'Set'}
                              </Button>
                            )
                          },
                        },
                        {
                          title: '', width: 80,
                          render: (_, row: any) => (
                            <Space size={2}>
                              <Tooltip title="Rename field">
                                <Button size="small" type="text" icon={<EditOutlined />} style={{ color: '#4fc3f7', fontSize: 10 }}
                                  onClick={() => { setRenameFieldOpen({ old: row.name }); setRenameFieldNew('') }} />
                              </Tooltip>
                              <Popconfirm title={`Remove field "${row.name}" from all features?`} onConfirm={() => removeField(row.name)}>
                                <Button size="small" type="text" icon={<DeleteOutlined />} danger style={{ fontSize: 10 }} />
                              </Popconfirm>
                            </Space>
                          ),
                        },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'history',
                label: <span><HistoryOutlined /> History</span>,
                children: (
                  <div style={{ height: 210, overflow: 'auto', padding: '4px 10px' }}>
                    <div style={{ color: '#666', fontSize: 11, marginBottom: 6 }}>
                      Showing creation records — most recent first
                    </div>
                    <Table
                      size="small"
                      pagination={{ pageSize: 50, size: 'small' }}
                      scroll={{ y: 160 }}
                      dataSource={[...features].sort((a, b) => b.id - a.id)}
                      rowKey="id"
                      columns={[
                        { title: 'ID', dataIndex: 'id', width: 55,
                          render: id => <Button type="link" size="small" style={{ padding: 0, fontSize: 11 }} onClick={() => onFeatureZoom(id)}>{id}</Button> },
                        { title: 'Layer', dataIndex: 'layer_name', width: 120, ellipsis: true,
                          render: v => <span style={{ fontSize: 11, color: '#4fc3f7' }}>{v}</span> },
                        { title: 'Type', dataIndex: 'geometry_type', width: 70,
                          render: v => <Tag style={{ fontSize: 9 }}>{v}</Tag> },
                        { title: 'Feature ID', dataIndex: 'feature_id', width: 100, ellipsis: true,
                          render: v => <span style={{ fontSize: 11, color: '#ccc' }}>{v}</span> },
                        { title: 'Created By', dataIndex: 'created_by_name', width: 110, ellipsis: true,
                          render: v => <span style={{ fontSize: 11, color: '#90caf9' }}>{v ?? '—'}</span> },
                        { title: 'Created At', dataIndex: 'created_at', width: 110,
                          render: v => <span style={{ fontSize: 10, color: '#666' }}>{new Date(v).toLocaleString()}</span> },
                      ]}
                    />
                  </div>
                ),
              },
              {
                key: 'ops',
                label: <span><ToolOutlined /> Operations</span>,
                children: (
                  <div style={{ padding: '10px 14px', height: 210, overflow: 'auto' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>

                      {/* Rename Layer */}
                      <div style={{ background: '#0d1a2a', borderRadius: 4, padding: 10, border: '1px solid #1a2a3a' }}>
                        <div style={{ color: '#4fc3f7', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>RENAME LAYER</div>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                          Renames all features in <strong style={{ color: '#ccc' }}>{layerFilter ?? '(select layer)'}</strong>
                        </div>
                        <Input size="small" placeholder="New layer name" value={renameLayerNew}
                          onChange={e => setRenameLayerNew(e.target.value)} style={{ marginBottom: 6 }} />
                        <Popconfirm
                          title={`Rename "${layerFilter}" → "${renameLayerNew}"?`}
                          disabled={!layerFilter || !renameLayerNew}
                          onConfirm={async () => {
                            await callOp('/projects/features/rename-layer/', { old_name: layerFilter, new_name: renameLayerNew })
                            setLayerFilter(renameLayerNew)
                            setRenameLayerNew('')
                          }}>
                          <Button size="small" disabled={!layerFilter || !renameLayerNew} loading={opLoading} block>Rename</Button>
                        </Popconfirm>
                      </div>

                      {/* Merge Layers */}
                      <div style={{ background: '#0d1a2a', borderRadius: 4, padding: 10, border: '1px solid #1a2a3a' }}>
                        <div style={{ color: '#4fc3f7', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>MERGE INTO LAYER</div>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                          Copy features from <strong style={{ color: '#ccc' }}>{layerFilter ?? '(select layer)'}</strong> into:
                        </div>
                        <Select size="small" style={{ width: '100%', marginBottom: 4 }} placeholder="Target layer"
                          value={mergeTarget || undefined} onChange={setMergeTarget}
                          options={layerNames.filter(n => n !== layerFilter).map(n => ({ value: n, label: n }))} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11 }}>
                          <Switch size="small" checked={mergeDeleteSource} onChange={setMergeDeleteSource} />
                          <span style={{ color: '#888' }}>Delete source after merge</span>
                        </div>
                        <Popconfirm title={`Merge "${layerFilter}" into "${mergeTarget}"?`}
                          disabled={!layerFilter || !mergeTarget}
                          onConfirm={() => callOp('/projects/features/merge-layers/', { source_layer: layerFilter, target_layer: mergeTarget, delete_source: mergeDeleteSource })}>
                          <Button size="small" disabled={!layerFilter || !mergeTarget} loading={opLoading} block>Merge</Button>
                        </Popconfirm>
                      </div>

                      {/* Repair Geometry */}
                      <div style={{ background: '#0d1a2a', borderRadius: 4, padding: 10, border: '1px solid #1a2a3a' }}>
                        <div style={{ color: '#4fc3f7', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>REPAIR GEOMETRY</div>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                          Run ST_MakeValid on invalid geometries in {layerFilter ? `"${layerFilter}"` : 'all layers'}.
                        </div>
                        <Popconfirm title="Repair invalid geometries?" onConfirm={() =>
                          callOp('/projects/features/repair-geometry/', { layer_name: layerFilter ?? '' })}>
                          <Button size="small" loading={opLoading} block>Repair Geometry</Button>
                        </Popconfirm>
                      </div>

                      {/* Deduplicate */}
                      <div style={{ background: '#0d1a2a', borderRadius: 4, padding: 10, border: '1px solid #1a2a3a' }}>
                        <div style={{ color: '#4fc3f7', fontSize: 11, fontWeight: 600, marginBottom: 6 }}>REMOVE DUPLICATES</div>
                        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                          Find and remove features with identical geometry in {layerFilter ? `"${layerFilter}"` : 'all layers'}.
                        </div>
                        <Popconfirm title="Remove exact geometry duplicates?" onConfirm={() =>
                          callOp('/projects/features/deduplicate/', { layer_name: layerFilter ?? '' })}>
                          <Button size="small" loading={opLoading} block danger>Deduplicate</Button>
                        </Popconfirm>
                      </div>

                    </div>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>

      {/* ── Field Calculator modal ──────────────────────────────────────── */}
      <Modal title={<><CalculatorOutlined style={{ marginRight: 8 }} />Field Calculator</>}
        open={calcOpen} onCancel={() => setCalcOpen(false)} onOk={applyFieldCalc} okText="Apply" width={460}
        styles={{ body: { background: '#0e0e1e' } }}>
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={10}>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Field to update (existing or new)</div>
            <Select showSearch allowClear style={{ width: '100%' }} value={calcField || undefined}
              onChange={v => setCalcField(v ?? '')} placeholder="Select or type field name"
              options={attrKeys.map(k => ({ value: k, label: k }))} />
            <Input style={{ marginTop: 6 }} placeholder="Or type a new field name"
              value={calcField} onChange={e => setCalcField(e.target.value)} />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Expression</div>
            <Input.TextArea rows={2} placeholder={'e.g.  2025  or  ${survey_no}_v2  or  10 * 2 + 5'}
              value={calcExpr} onChange={e => setCalcExpr(e.target.value)} />
            <div style={{ color: '#555', fontSize: 11, marginTop: 4 }}>
              Use <code style={{ color: '#4fc3f7' }}>{'${field}'}</code> to reference other attributes. Simple arithmetic is auto-evaluated.
            </div>
          </div>
          <div>
            <span style={{ color: '#aaa', fontSize: 12, marginRight: 8 }}>Apply to:</span>
            <Radio.Group value={calcTarget} onChange={e => setCalcTarget(e.target.value)} size="small">
              <Radio value="selected">Selected ({selectedRowKeys.length})</Radio>
              <Radio value="all">All rows ({rows.length})</Radio>
            </Radio.Group>
          </div>
        </Space>
      </Modal>

      {/* ── Add Field modal ─────────────────────────────────────────────── */}
      <Modal title={<><PlusOutlined style={{ marginRight: 8 }} />Add Field</>}
        open={addFieldOpen} onCancel={() => setAddFieldOpen(false)} onOk={addField} okText="Add" width={380}>
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={10}>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Field name</div>
            <Input placeholder="e.g. survey_number" value={newFieldName} onChange={e => setNewFieldName(e.target.value)} />
          </div>
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Default value (optional)</div>
            <Input placeholder="Leave blank for null" value={newFieldDefault} onChange={e => setNewFieldDefault(e.target.value)} />
          </div>
          <div style={{ color: '#666', fontSize: 11 }}>
            Applies to <strong style={{ color: '#4fc3f7' }}>{(layerFilter ? features.filter(f => f.layer_name === layerFilter) : features).length}</strong> feature(s).
          </div>
        </Space>
      </Modal>

      {/* ── Rename Field modal ──────────────────────────────────────────── */}
      <Modal title={<><SwapOutlined style={{ marginRight: 8 }} />Rename Field "{renameFieldOpen?.old}"</>}
        open={!!renameFieldOpen} onCancel={() => setRenameFieldOpen(null)} onOk={renameFieldSubmit} okText="Rename" width={380}>
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={10}>
          <Input placeholder="New field name" value={renameFieldNew} onChange={e => setRenameFieldNew(e.target.value)} />
          <div style={{ color: '#666', fontSize: 11 }}>
            Renames across all features in {layerFilter ? `"${layerFilter}"` : 'all layers'} of this project.
          </div>
        </Space>
      </Modal>

      {/* ── Domain editor modal ─────────────────────────────────────────── */}
      <Modal title={`Domain values for "${domainEditField}"`}
        open={!!domainEditField} onCancel={() => setDomainEditField(null)}
        onOk={() => {
          if (!projectId || !domainEditField) return
          const vals = domainInput.split(',').map(s => s.trim()).filter(Boolean)
          setDomain(projectId, layerFilter ?? '', domainEditField, vals)
          message.success(`Domain set: ${vals.length} allowed value(s)`)
          setDomainEditField(null)
        }}
        okText="Save Domain" width={420}>
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={10}>
          <div style={{ color: '#aaa', fontSize: 12 }}>
            Comma-separated list of allowed values. When editing this field, a dropdown will appear.
          </div>
          <Input.TextArea rows={3} placeholder="e.g. Highway, Local, Service Road"
            value={domainInput} onChange={e => setDomainInput(e.target.value)} />
          {domainInput && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {domainInput.split(',').map(s => s.trim()).filter(Boolean).map(v => (
                <Tag key={v} color="blue" style={{ fontSize: 11 }}>{v}</Tag>
              ))}
            </div>
          )}
          {projectId && domainEditField && getDomain(projectId, layerFilter ?? '', domainEditField).length > 0 && (
            <Button size="small" danger onClick={() => {
              if (projectId && domainEditField) {
                setDomain(projectId, layerFilter ?? '', domainEditField, [])
                setDomainInput('')
                message.success('Domain cleared')
                setDomainEditField(null)
              }
            }}>Clear Domain</Button>
          )}
        </Space>
      </Modal>

      {/* ── Bulk Edit Modal ── */}
      <Modal
        title={`Bulk Edit — ${selectedRowKeys.length} feature(s) selected`}
        open={bulkEditOpen}
        onCancel={() => setBulkEditOpen(false)}
        onOk={applyBulkEdit}
        confirmLoading={bulkLoading}
        okText={`Update ${selectedRowKeys.length} feature(s)`}
        width={500}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={10}>
          <div style={{ color: '#aaa', fontSize: 12 }}>
            Set attribute values for all selected features. Leave value empty to set as blank.
          </div>
          {bulkFields.map((pair, idx) => (
            <Space key={idx} style={{ width: '100%' }} align="baseline">
              <Select
                placeholder="Field name"
                showSearch
                allowClear
                style={{ width: 160 }}
                value={pair.field || undefined}
                options={
                  layerFilter
                    ? [...new Set(features.filter(f => f.layer_name === layerFilter)
                        .flatMap(f => Object.keys(f.attributes || {})))].map(k => ({ value: k, label: k }))
                    : [...new Set(features.flatMap(f => Object.keys(f.attributes || {})))].map(k => ({ value: k, label: k }))
                }
                onChange={v => setBulkFields(prev => prev.map((p, i) => i === idx ? { ...p, field: v ?? '' } : p))}
              />
              <Input
                placeholder="New value"
                style={{ width: 200 }}
                value={pair.value}
                onChange={e => setBulkFields(prev => prev.map((p, i) => i === idx ? { ...p, value: e.target.value } : p))}
              />
              <Button size="small" danger type="text" icon={<DeleteOutlined />}
                onClick={() => setBulkFields(prev => prev.filter((_, i) => i !== idx))}
                disabled={bulkFields.length === 1} />
            </Space>
          ))}
          <Button size="small" icon={<PlusOutlined />}
            onClick={() => setBulkFields(prev => [...prev, { field: '', value: '' }])}>
            Add Field
          </Button>
          <Divider style={{ margin: '4px 0' }} />
          <div style={{ fontSize: 11, color: '#555' }}>
            Conditional update: use "Field Calc" tab for expression-based updates.
          </div>
        </Space>
      </Modal>
    </>
  )
}
