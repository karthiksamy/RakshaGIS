import { useState } from 'react'
import {
  Drawer, Tabs, Table, Tag, Spin, Button, Modal, Input, message,
  Empty, Tooltip, Typography, Row, Col, Statistic, Space, Badge,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  HistoryOutlined, CameraOutlined, BranchesOutlined, SplitCellsOutlined,
  DownloadOutlined, PlusOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { SurveyArea, FeatureHistoryEntry, AreaSnapshot, AreaTimeline, AreaLineage } from '@/types'

const { Text } = Typography

const CHANGE_COLORS: Record<string, string> = {
  CREATE: 'green', MODIFY: 'blue', DELETE: 'red',
  TRANSFER_OUT: 'orange', TRANSFER_IN: 'cyan',
}

// ── Mini bar chart (pure DOM — no extra lib) ──────────────────────────────────
function MiniBarChart({ timeline }: { timeline: AreaTimeline }) {
  const maxVal = Math.max(1, ...timeline.created, ...timeline.modified, ...timeline.deleted, ...timeline.transferred)
  const n = timeline.dates.length
  // Show at most last 60 days
  const start = Math.max(0, n - 60)
  const dates  = timeline.dates.slice(start)
  const cr     = timeline.created.slice(start)
  const mo     = timeline.modified.slice(start)
  const de     = timeline.deleted.slice(start)
  const tr     = timeline.transferred.slice(start)

  const BAR_W = 8
  const GAP   = 2
  const H     = 60
  const total = dates.length * (BAR_W + GAP)

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={total} height={H + 20} style={{ display: 'block' }}>
        {dates.map((d, i) => {
          const x = i * (BAR_W + GAP)
          const segments = [
            { val: cr[i],  color: '#52c41a' },
            { val: mo[i],  color: '#1890ff' },
            { val: de[i],  color: '#ff4d4f' },
            { val: tr[i],  color: '#faad14' },
          ]
          let yOff = H
          return (
            <g key={d}>
              <title>{d}: +{cr[i]} ~{mo[i]} -{de[i]} ↔{tr[i]}</title>
              {segments.map((s, j) => {
                const h = Math.round((s.val / maxVal) * H)
                yOff -= h
                return h > 0 ? (
                  <rect key={j} x={x} y={yOff} width={BAR_W} height={h} fill={s.color} opacity={0.85} />
                ) : null
              })}
            </g>
          )
        })}
        {/* x-axis */}
        <line x1={0} y1={H} x2={total} y2={H} stroke="#333" strokeWidth={1} />
      </svg>
      <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 11 }}>
        {[['#52c41a', 'Created'], ['#1890ff', 'Modified'], ['#ff4d4f', 'Deleted'], ['#faad14', 'Transferred']].map(([c, l]) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#888' }}>
            <span style={{ width: 10, height: 10, background: c as string, borderRadius: 2, display: 'inline-block' }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Activity Tab ──────────────────────────────────────────────────────────────
function ActivityTab({ areaId }: { areaId: number }) {
  const { data: timeline, isLoading: tLoading } = useQuery<AreaTimeline>({
    queryKey: ['area-timeline', areaId],
    queryFn: () => api.get(`/projects/survey-areas/${areaId}/timeline/`).then(r => r.data),
  })
  const { data: histPage, isLoading: hLoading } = useQuery<{ results: FeatureHistoryEntry[] }>({
    queryKey: ['area-history', areaId],
    queryFn: () => api.get(`/projects/survey-areas/${areaId}/history/?page_size=100`).then(r => r.data),
  })

  const cols: ColumnsType<FeatureHistoryEntry> = [
    {
      title: 'Date', dataIndex: 'changed_at', key: 'date', width: 140,
      render: (v: string) => new Date(v).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }),
    },
    {
      title: 'Action', dataIndex: 'change_type', key: 'ct', width: 110,
      render: (v: string, row) => (
        <Tag color={CHANGE_COLORS[v] || 'default'}>{row.change_type_display}</Tag>
      ),
    },
    { title: 'Layer', dataIndex: 'layer_name', key: 'ln', width: 130 },
    {
      title: 'Feature ID', dataIndex: 'feature_pk', key: 'fid', width: 90,
      render: (v: number) => <Text code>#{v}</Text>,
    },
    {
      title: 'By', dataIndex: 'changed_by_name', key: 'by', width: 130,
      render: (v: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Area status', dataIndex: 'area_status_at_change', key: 'as', width: 120,
      render: (v: string) => v ? <Tag>{v}</Tag> : '—',
    },
    {
      title: 'Note', dataIndex: 'note', key: 'note',
      render: (v: string) => v || '—',
    },
  ]

  const history = histPage?.results ?? (Array.isArray(histPage) ? histPage as FeatureHistoryEntry[] : [])

  // Aggregate totals
  const totals = history.reduce(
    (acc, h) => {
      if (h.change_type === 'CREATE') acc.created++
      else if (h.change_type === 'MODIFY') acc.modified++
      else if (h.change_type === 'DELETE') acc.deleted++
      else acc.transferred++
      return acc
    },
    { created: 0, modified: 0, deleted: 0, transferred: 0 },
  )

  return (
    <div>
      {tLoading ? <Spin size="small" /> : timeline && (
        <div style={{ marginBottom: 16 }}>
          <Text style={{ color: '#888', fontSize: 11 }}>Feature changes (last 90 days)</Text>
          <MiniBarChart timeline={timeline} />
        </div>
      )}
      <Row gutter={8} style={{ marginBottom: 16 }}>
        {[
          { label: 'Created',     value: totals.created,     color: '#52c41a' },
          { label: 'Modified',    value: totals.modified,    color: '#1890ff' },
          { label: 'Deleted',     value: totals.deleted,     color: '#ff4d4f' },
          { label: 'Transferred', value: totals.transferred, color: '#faad14' },
        ].map(s => (
          <Col span={6} key={s.label}>
            <Statistic
              title={<span style={{ fontSize: 11, color: '#888' }}>{s.label}</span>}
              value={s.value}
              valueStyle={{ color: s.color, fontSize: 18 }}
            />
          </Col>
        ))}
      </Row>
      <Table<FeatureHistoryEntry>
        dataSource={history}
        columns={cols}
        rowKey="id"
        size="small"
        loading={hLoading}
        pagination={{ pageSize: 20, size: 'small' }}
        locale={{ emptyText: <Empty description="No changes recorded yet" /> }}
        scroll={{ x: 800 }}
      />
    </div>
  )
}

// ── Snapshots Tab ─────────────────────────────────────────────────────────────
function SnapshotsTab({ area }: { area: SurveyArea }) {
  const qc = useQueryClient()
  const [noteModal, setNoteModal] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [labelText, setLabelText] = useState('')

  const { data: snaps = [], isLoading } = useQuery<AreaSnapshot[]>({
    queryKey: ['area-snapshots', area.id],
    queryFn: () => api.get(`/projects/survey-areas/${area.id}/snapshots/`).then(r => r.data),
  })

  const takeMutation = useMutation({
    mutationFn: () => api.post(`/projects/survey-areas/${area.id}/snapshots/`, {
      label: labelText || `Manual — ${new Date().toLocaleDateString()}`,
      notes: noteText,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['area-snapshots', area.id] })
      message.success('Snapshot saved')
      setNoteModal(false); setNoteText(''); setLabelText('')
    },
    onError: () => message.error('Failed to take snapshot'),
  })

  const downloadSnapshot = async (snap: AreaSnapshot) => {
    const r = await api.get(`/projects/survey-areas/${area.id}/snapshots/${snap.id}/geojson/`)
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `snapshot-${area.name.replace(/\s+/g, '_')}-${snap.taken_at.slice(0, 10)}.geojson`
    a.click(); URL.revokeObjectURL(url)
  }

  const SNAP_COLORS: Record<string, string> = {
    WORKFLOW: 'blue', SPLIT_BEFORE: 'orange', SPLIT_AFTER: 'green',
    TRANSFER: 'purple', MANUAL: 'default',
  }

  return (
    <div>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: '#888', fontSize: 12 }}>
          Snapshots capture the full GeoJSON state of this area at key moments.
          Download to compare in QGIS or replay history.
        </Text>
        <Button
          size="small" type="primary" icon={<CameraOutlined />}
          onClick={() => setNoteModal(true)}
        >
          Take Snapshot
        </Button>
      </div>

      {isLoading ? <Spin /> : snaps.length === 0 ? (
        <Empty description="No snapshots yet — snapshots are taken automatically at each workflow transition and split." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {snaps.map(snap => (
            <div key={snap.id} style={{
              background: '#0d0d1f', border: '1px solid #1a1a3e', borderRadius: 6,
              padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <Tag color={SNAP_COLORS[snap.snapshot_type] || 'default'} style={{ flexShrink: 0 }}>
                {snap.snapshot_type_display}
              </Tag>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#e8e8e8' }}>
                  {snap.label || snap.snapshot_type_display}
                </div>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  {new Date(snap.taken_at).toLocaleString('en-IN')} ·&nbsp;
                  {snap.taken_by_name || 'System'} ·&nbsp;
                  <strong style={{ color: '#4fc3f7' }}>{snap.feature_count}</strong> features ·&nbsp;
                  Status: <Tag style={{ fontSize: 10 }}>{snap.status_at_snapshot}</Tag>
                </div>
                {snap.notes && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{snap.notes}</div>}
              </div>
              <Tooltip title="Download GeoJSON">
                <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadSnapshot(snap)} />
              </Tooltip>
            </div>
          ))}
        </div>
      )}

      <Modal
        title="Take Manual Snapshot" open={noteModal}
        onCancel={() => setNoteModal(false)}
        onOk={() => takeMutation.mutate()}
        confirmLoading={takeMutation.isPending}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="Label (e.g. Before field verification)" value={labelText}
            onChange={e => setLabelText(e.target.value)} />
          <Input.TextArea placeholder="Notes (optional)" rows={3} value={noteText}
            onChange={e => setNoteText(e.target.value)} />
        </Space>
      </Modal>
    </div>
  )
}

// ── Lineage Tab ───────────────────────────────────────────────────────────────
function LineageTab({ area, onSplit }: { area: SurveyArea; onSplit: () => void }) {
  const { data: lineage, isLoading } = useQuery<AreaLineage>({
    queryKey: ['area-lineage', area.id],
    queryFn: () => api.get(`/projects/survey-areas/${area.id}/lineage/`).then(r => r.data),
  })

  if (isLoading) return <Spin />

  const OP_COLORS: Record<string, string> = { SPLIT: 'orange', POCKET: 'cyan', TRANSFER: 'purple' }

  return (
    <div>
      {/* Parent */}
      {lineage?.parent && (
        <div style={{ marginBottom: 16 }}>
          <Text style={{ color: '#888', fontSize: 11 }}>Derived from (parent area)</Text>
          <div style={{ background: '#0d0d1f', border: '1px solid #2a2a3e', borderRadius: 6, padding: '10px 14px', marginTop: 6 }}>
            <BranchesOutlined style={{ color: '#faad14', marginRight: 8 }} />
            <strong>{lineage.parent.name}</strong>
            <Tag style={{ marginLeft: 8 }}>{lineage.parent.status_display}</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}> — {lineage.parent.area_type_display}</Text>
          </div>
        </div>
      )}

      {/* Current */}
      <div style={{ marginBottom: 16 }}>
        <Text style={{ color: '#888', fontSize: 11 }}>Current area</Text>
        <div style={{ background: '#111127', border: '2px solid #4fc3f7', borderRadius: 6, padding: '10px 14px', marginTop: 6 }}>
          <strong style={{ color: '#4fc3f7' }}>{area.name}</strong>
          <Tag style={{ marginLeft: 8 }}>{area.status_display}</Tag>
          <Tag color="blue" style={{ marginLeft: 4 }}>{area.area_type_display}</Tag>
        </div>
      </div>

      {/* Children */}
      {(lineage?.children?.length ?? 0) > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Text style={{ color: '#888', fontSize: 11 }}>Derived areas (pockets / splits)</Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {lineage!.children.map(child => (
              <div key={child.id} style={{ background: '#0d0d1f', border: '1px solid #1a1a3e', borderRadius: 6, padding: '8px 14px', marginLeft: 24 }}>
                <BranchesOutlined style={{ color: '#52c41a', marginRight: 8 }} />
                <strong>{child.name}</strong>
                <Tag style={{ marginLeft: 8 }}>{child.status_display}</Tag>
                <Tag color="cyan" style={{ marginLeft: 4 }}>{child.area_type_display}</Tag>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Split events */}
      {(lineage?.split_events?.length ?? 0) > 0 && (
        <div>
          <Text style={{ color: '#888', fontSize: 11 }}>Split / Transfer history</Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {lineage!.split_events.map(ev => (
              <div key={ev.id} style={{ background: '#0d0d1f', border: '1px solid #1a1a3e', borderRadius: 6, padding: '8px 14px' }}>
                <Tag color={OP_COLORS[ev.operation]}>{ev.operation_display}</Tag>
                <span style={{ color: '#e8e8e8', fontSize: 12, marginLeft: 6 }}>
                  → <strong>{ev.new_area_name}</strong>
                </span>
                <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>
                  {ev.transferred_feature_count} feature(s) ·&nbsp;
                  {new Date(ev.performed_at).toLocaleDateString('en-IN')} ·&nbsp;
                  {ev.performed_by_name}
                </span>
                {ev.reason && (
                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>Reason: {ev.reason}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <Button icon={<SplitCellsOutlined />} onClick={onSplit} type="dashed">
          Split / Pocket / Transfer this area…
        </Button>
      </div>
    </div>
  )
}

// ── Main drawer ───────────────────────────────────────────────────────────────
interface Props {
  area: SurveyArea
  open: boolean
  onClose: () => void
  onSplitRequest: () => void
}

export default function SurveyAreaHistoryDrawer({ area, open, onClose, onSplitRequest }: Props) {
  return (
    <Drawer
      title={
        <span>
          <HistoryOutlined style={{ marginRight: 8, color: '#4fc3f7' }} />
          History — <strong>{area.name}</strong>
        </span>
      }
      open={open}
      onClose={onClose}
      width={760}
      styles={{ body: { padding: '12px 16px', background: '#0a0a1a' } }}
      style={{ background: '#0a0a1a' }}
    >
      <Tabs
        defaultActiveKey="activity"
        size="small"
        items={[
          {
            key: 'activity',
            label: <><HistoryOutlined /> Activity</>,
            children: <ActivityTab areaId={area.id} />,
          },
          {
            key: 'snapshots',
            label: <><CameraOutlined /> Snapshots</>,
            children: <SnapshotsTab area={area} />,
          },
          {
            key: 'lineage',
            label: (
              <>
                <BranchesOutlined />
                Lineage
                {area.child_count > 0 && (
                  <Badge count={area.child_count} size="small" style={{ marginLeft: 4 }} />
                )}
              </>
            ),
            children: <LineageTab area={area} onSplit={onSplitRequest} />,
          },
        ]}
      />
    </Drawer>
  )
}
