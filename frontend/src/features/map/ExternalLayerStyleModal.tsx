import React, { useEffect, useMemo, useState } from 'react'
import {
  Modal, ColorPicker, Slider, InputNumber, Select as AntSelect,
  Segmented, Button, Divider, Space, Alert, message,
} from 'antd'
import { useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { FILL_PATTERN_OPTIONS } from './fillPatterns'
import {
  EXT_STYLE_DEFAULTS, resolveExtStyle,
  STROKE_STYLE_OPTIONS, POINT_SHAPE_OPTIONS,
  type ExtStyleResolved,
} from './extStyle'

interface ExternalLayer {
  id: number
  display_name: string
  geometry_type?: string
  classification_field?: string
  classification_colors?: Record<string, unknown>
  style?: Record<string, unknown>
}

interface Props {
  open: boolean
  layer: ExternalLayer | null
  /** Superadmins can persist style as the layer default; others apply for the session. */
  canPersist: boolean
  /** Live preview / apply on the map — receives the layer with its updated style. */
  onApply: (layer: ExternalLayer) => void
  onClose: () => void
}

/** Strip a resolved style back to a plain JSON object for storage. */
function cfgToStyle(cfg: ExtStyleResolved): Record<string, unknown> {
  return { ...cfg }
}

export default function ExternalLayerStyleModal({
  open, layer, canPersist, onApply, onClose,
}: Props) {
  const qc = useQueryClient()
  const [cfg, setCfg] = useState<ExtStyleResolved>(EXT_STYLE_DEFAULTS)
  const [saving, setSaving] = useState(false)

  // Re-seed the form whenever a different layer is opened.
  useEffect(() => {
    if (layer) setCfg(resolveExtStyle(layer.style))
  }, [layer?.id, open])

  const geom = (layer?.geometry_type || '').toUpperCase()
  const isPoint = geom.includes('POINT')
  const isLine = geom.includes('LINESTRING')
  const isPolygon = geom.includes('POLYGON') || (!isPoint && !isLine)
  const isThematic = !!(layer?.classification_field || '').trim() &&
    Object.keys(layer?.classification_colors || {}).length > 0

  // Apply a partial update + push a live preview to the map.
  function upd(patch: Partial<ExtStyleResolved>) {
    setCfg(prev => {
      const next = { ...prev, ...patch }
      if (layer) onApply({ ...layer, style: cfgToStyle(next) })
      return next
    })
  }

  const swatch = useMemo(() => {
    const fill = cfg.fillPattern === 'none'
      ? 'transparent'
      : `${cfg.fillColor}${Math.round(cfg.fillOpacity * 255).toString(16).padStart(2, '0')}`
    return (
      <div style={{
        width: 64, height: 40, borderRadius: 4,
        background: fill,
        border: `${Math.max(1, cfg.strokeWidth)}px ${cfg.strokeStyle === 'solid' ? 'solid' : 'dashed'} ${cfg.strokeColor}`,
      }} />
    )
  }, [cfg])

  async function handleSave() {
    if (!layer) return
    const style = cfgToStyle(cfg)
    if (canPersist) {
      setSaving(true)
      try {
        await api.patch(`/external/layers/${layer.id}/`, { style })
        qc.invalidateQueries({ queryKey: ['ext-layers-active'] })
        message.success(`Saved style for "${layer.display_name}"`)
      } catch (e: any) {
        message.error(e?.response?.data?.detail || 'Failed to save style')
        setSaving(false)
        return
      }
      setSaving(false)
    } else {
      message.success('Style applied for this session')
    }
    onApply({ ...layer, style })
    onClose()
  }

  function handleReset() {
    setCfg(EXT_STYLE_DEFAULTS)
    if (layer) onApply({ ...layer, style: cfgToStyle(EXT_STYLE_DEFAULTS) })
  }

  const label = (t: string) => (
    <span style={{ color: '#888', width: 70, display: 'inline-block', fontSize: 12 }}>{t}</span>
  )
  const heading = (t: string) => (
    <div style={{ color: '#4fc3f7', fontSize: 11, fontWeight: 600, margin: '4px 0 8px' }}>{t}</div>
  )

  return (
    <Modal
      title={`Layer Style — ${layer?.display_name ?? ''}`}
      open={open}
      onCancel={onClose}
      width={460}
      okText={canPersist ? 'Save as default' : 'Apply'}
      confirmLoading={saving}
      onOk={handleSave}
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          <Button onClick={handleReset}>Reset</Button>
          <CancelBtn />
          <OkBtn />
        </Space>
      )}
    >
      {isThematic && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Thematic layer"
          description="Fill colours come from classification rules. Stroke, fill pattern and point settings below still apply to every class."
        />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ color: '#888', fontSize: 12 }}>Preview</span>
        {swatch}
      </div>

      {/* ── FILL ──────────────────────────────────────────────── */}
      {(isPolygon || isPoint) && (
        <>
          {heading('FILL')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            {label('Color')}
            <ColorPicker
              value={cfg.fillColor}
              disabled={isThematic}
              onChange={(c) => upd({ fillColor: c.toHexString() })}
            />
            {label('Pattern')}
            <AntSelect
              size="small"
              value={cfg.fillPattern}
              onChange={(v) => upd({ fillPattern: v })}
              style={{ flex: 1 }}
              options={FILL_PATTERN_OPTIONS}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            {label('Opacity')}
            <Slider
              min={0} max={1} step={0.05}
              value={cfg.fillOpacity}
              disabled={isThematic}
              onChange={(v) => upd({ fillOpacity: v })}
              style={{ flex: 1, margin: 0 }}
              tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
            />
          </div>
          <Divider style={{ margin: '8px 0' }} />
        </>
      )}

      {/* ── STROKE / BORDER ───────────────────────────────────── */}
      {heading('STROKE / BORDER')}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {label('Color')}
        <ColorPicker value={cfg.strokeColor} onChange={(c) => upd({ strokeColor: c.toHexString() })} />
        {label('Style')}
        <AntSelect
          size="small"
          value={cfg.strokeStyle}
          onChange={(v) => upd({ strokeStyle: v })}
          style={{ flex: 1 }}
          options={STROKE_STYLE_OPTIONS}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {label('Width')}
        <Slider
          min={0} max={12} step={0.5}
          value={cfg.strokeWidth}
          onChange={(v) => upd({ strokeWidth: v })}
          style={{ flex: 1, margin: 0 }}
          tooltip={{ formatter: (v) => `${v}px` }}
        />
        <InputNumber
          size="small" min={0} max={12} step={0.5}
          value={cfg.strokeWidth}
          onChange={(v) => v != null && upd({ strokeWidth: v })}
          style={{ width: 56 }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {label('Opacity')}
        <Slider
          min={0} max={1} step={0.05}
          value={cfg.strokeOpacity}
          onChange={(v) => upd({ strokeOpacity: v })}
          style={{ flex: 1, margin: 0 }}
          tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {label('Cap')}
        <Segmented
          size="small"
          value={cfg.strokeCap}
          onChange={(v) => upd({ strokeCap: v as CanvasLineCap })}
          options={['butt', 'round', 'square']}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {label('Join')}
        <Segmented
          size="small"
          value={cfg.strokeJoin}
          onChange={(v) => upd({ strokeJoin: v as CanvasLineJoin })}
          options={['miter', 'round', 'bevel']}
        />
      </div>

      {/* ── POINT SYMBOL ──────────────────────────────────────── */}
      {isPoint && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          {heading('POINT SYMBOL')}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {POINT_SHAPE_OPTIONS.map((shape) => (
              <Button
                key={shape}
                size="small"
                type={cfg.pointShape === shape ? 'primary' : 'default'}
                onClick={() => upd({ pointShape: shape })}
              >
                {shape}
              </Button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {label('Size')}
            <Slider
              min={2} max={20} step={1}
              value={cfg.pointSize}
              onChange={(v) => upd({ pointSize: v })}
              style={{ flex: 1, margin: 0 }}
              tooltip={{ formatter: (v) => `${v}px` }}
            />
            <InputNumber
              size="small" min={2} max={20}
              value={cfg.pointSize}
              onChange={(v) => v != null && upd({ pointSize: v })}
              style={{ width: 56 }}
            />
          </div>
        </>
      )}

      {!canPersist && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="Changes apply to your current session only. A super admin can save them as the layer default."
        />
      )}
    </Modal>
  )
}
