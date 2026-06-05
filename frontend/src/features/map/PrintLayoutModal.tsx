import { useState, useMemo, useRef } from 'react'
import {
  Form, Input, Select, Checkbox, Button, Space,
  message, Radio, Divider, Tooltip, Alert, Tag,
} from 'antd'
import DraggableModal from '@/components/DraggableModal'
import { useBranding } from '@/context/BrandingContext'
import { PrinterOutlined, DownloadOutlined, GlobalOutlined, SelectOutlined } from '@ant-design/icons'
import { toLonLat } from 'ol/proj'
import type OLMap from 'ol/Map'
import type VectorLayer from 'ol/layer/Vector'
import type VectorSource from 'ol/source/Vector'
import type jsPDFType from 'jspdf'
import api from '@/services/api'

export interface LayerLegendItem {
  name: string
  color: string
  type?: 'vector' | 'raster'
}

interface Props {
  open: boolean
  onClose: () => void
  mapInstance: OLMap | null
  projectName?: string
  orgName?: string
  legend?: LayerLegendItem[]
  /** Direct ref to the selection layer — avoids fragile zIndex lookup */
  selectLayer?: React.RefObject<VectorLayer<VectorSource> | null>
  /** selectedCount from MapPage state — keeps the badge reactive */
  selectedCount?: number
}

// Portrait dims [w, h] in mm — landscape swaps them at render time
const PAPER_SIZES: Record<string, { label: string; w: number; h: number; fmt: string }> = {
  A0:      { label: 'A0  (841 × 1189 mm)', w: 841,  h: 1189, fmt: 'a0'      },
  A1:      { label: 'A1  (594 × 841 mm)',  w: 594,  h: 841,  fmt: 'a1'      },
  A2:      { label: 'A2  (420 × 594 mm)',  w: 420,  h: 594,  fmt: 'a2'      },
  A3:      { label: 'A3  (297 × 420 mm)',  w: 297,  h: 420,  fmt: 'a3'      },
  A4:      { label: 'A4  (210 × 297 mm)',  w: 210,  h: 297,  fmt: 'a4'      },
  A5:      { label: 'A5  (148 × 210 mm)',  w: 148,  h: 210,  fmt: 'a5'      },
  Letter:  { label: 'Letter  (216 × 279 mm)', w: 216, h: 279, fmt: 'letter'  },
  Legal:   { label: 'Legal   (216 × 356 mm)', w: 216, h: 356, fmt: 'legal'   },
  Tabloid: { label: 'Tabloid (279 × 432 mm)', w: 279, h: 432, fmt: 'tabloid' },
  B0:      { label: 'B0  (1000 × 1414 mm)', w: 1000, h: 1414, fmt: [1000,1414] as any },
  B1:      { label: 'B1  (707 × 1000 mm)',  w: 707,  h: 1000, fmt: [707,1000] as any  },
  B2:      { label: 'B2  (500 × 707 mm)',   w: 500,  h: 707,  fmt: [500,707] as any   },
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').padEnd(6, '0')
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ]
}

// Typography scale relative to A4 portrait height (297 mm)
function ts(base: number, scale: number) { return Math.max(base * 0.7, base * scale) }

function drawNorthArrow(doc: jsPDFType, x: number, y: number, size: number) {
  const cx = x + size / 2
  const tip = y
  const base = y + size
  const half = size / 2.8

  // dark half
  doc.setFillColor(20, 20, 20)
  doc.setDrawColor(20, 20, 20)
  doc.setLineWidth(0.2)
  doc.triangle(cx, tip, cx - half, base, cx, base - size * 0.3, 'FD')
  // white half
  doc.setFillColor(255, 255, 255)
  doc.triangle(cx, tip, cx + half, base, cx, base - size * 0.3, 'FD')
  // outline
  doc.setFillColor(0, 0, 0, 0)
  doc.setDrawColor(20, 20, 20)
  doc.triangle(cx, tip, cx - half, base, cx + half, base, 'S')

  doc.setFontSize(ts(6, size / 14))
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(20, 20, 20)
  doc.text('N', cx, tip - size * 0.1, { align: 'center' })
}

function drawScaleBar(doc: jsPDFType, x: number, y: number, resolution: number, mapWpx: number, mapWmm: number, scale: number) {
  // resolution = m/screen-pixel; mapWpx = canvas pixel width; mapWmm = map width in PDF mm
  const mPerMm = resolution * (mapWpx / mapWmm)          // metres per PDF-mm
  const targetMm = 40 * scale                             // target bar ~40mm scaled
  const targetM = targetMm * mPerMm
  const niceValues = [1,2,5,10,25,50,100,200,500,1000,2000,5000,10000,25000,50000,100000]
  const niceM = niceValues.reduce((best, v) => Math.abs(v - targetM) < Math.abs(best - targetM) ? v : best, 1)
  const barMm = niceM / mPerMm
  const barH = 3 * scale
  const segW = barMm / 2

  // alternating black/white segments ×2
  for (let i = 0; i < 4; i++) {
    doc.setFillColor(i % 2 === 0 ? 20 : 255, i % 2 === 0 ? 20 : 255, i % 2 === 0 ? 20 : 255)
    doc.rect(x + i * segW / 2, y, segW / 2, barH, 'F')
  }
  doc.setDrawColor(20, 20, 20)
  doc.setLineWidth(0.3 * scale)
  doc.rect(x, y, barMm, barH, 'S')

  doc.setFontSize(ts(5.5, scale * 0.85))
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(20, 20, 20)
  doc.text('0', x, y + barH + 3 * scale, { align: 'center' })
  const half = niceM >= 2000 ? `${niceM / 2000} km` : niceM >= 2 ? `${niceM / 2} m` : `${niceM / 2} m`
  const full = niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`
  doc.text(half, x + barMm / 2, y + barH + 3 * scale, { align: 'center' })
  doc.text(full, x + barMm, y + barH + 3 * scale, { align: 'center' })

  // Scale ratio text
  const scaleDenom = Math.round(mPerMm * 1000)
  doc.setFontSize(ts(5, scale * 0.8))
  doc.setFont('helvetica', 'italic')
  doc.setTextColor(80, 80, 80)
  doc.text(`Scale  1 : ${scaleDenom.toLocaleString()}`, x, y + barH + 7 * scale)
}

interface CapturedLayer {
  name: string
  dataUrl: string
}

async function captureMapLayers(
  mapInstance: OLMap,
  dpi: string,
  legend: LayerLegendItem[],
  selectLayerRef?: React.RefObject<VectorLayer<VectorSource> | null>
): Promise<CapturedLayer[]> {
  const originalSize = mapInstance.getSize()
  const view = mapInstance.getView()
  const originalResolution = view.getResolution()
  const captureScale = dpi === '300' ? 3 : dpi === '150' ? 2 : 1

  const layers = mapInstance.getLayers().getArray()
  const basemapLyr = layers.find(l => typeof (l as any).getSource === 'function' && l.getZIndex() === 0)
  
  const vectorLyr = layers.find(l => {
    if (typeof (l as any).getSource === 'function') {
      const source = (l as any).getSource()
      return source && typeof source.getFeatures === 'function'
    }
    return false
  }) as any

  // Read selection: prefer direct ref (reliable), fall back to zIndex lookup
  const selectLyr = selectLayerRef?.current
    ?? (layers.find(l => l.getZIndex() === 11) as any)
  const selectedFeatures: any[] = selectLyr?.getSource?.()?.getFeatures?.() ?? []

  const hasSelection = selectedFeatures.length > 0
  const selectedIds = new Set(selectedFeatures.map((f: any) => f.get('feature_id') || String(f.getId() || '')))
  const selectedLayers = Array.from(new Set(selectedFeatures.map((f: any) => f.get('layer_name')).filter(Boolean))) as string[]

  const geoTiffLyrs = layers.filter(l => l.get('isGeoTIFF') === true)
  
  const otherLyrs = layers.filter(l => 
    l !== basemapLyr && 
    l !== vectorLyr && 
    l !== selectLyr &&
    !geoTiffLyrs.includes(l)
  )

  // Save original states
  const originalStates = new Map<any, { visible: boolean; style?: any }>()
  layers.forEach(l => {
    originalStates.set(l, {
      visible: l.getVisible(),
      style: (typeof (l as any).getStyle === 'function') ? (l as any).getStyle() : undefined
    })
  })

  const captured: CapturedLayer[] = []

  // Temporarily resize map container for high resolution rendering
  if (captureScale > 1 && originalSize && originalResolution) {
    const targetSize = [originalSize[0] * captureScale, originalSize[1] * captureScale]
    mapInstance.setSize(targetSize)
    view.setResolution(originalResolution / captureScale)
    
    // Wait for the high-res render to complete (tiles loaded)
    await Promise.race([
      new Promise<void>((resolve) => {
        mapInstance.once('rendercomplete', () => resolve())
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 1500))
    ])
    mapInstance.renderSync()
  }

  const getCanvasData = (): string => {
    const mapEl = mapInstance.getTargetElement()
    const canvases = Array.from(mapEl?.querySelectorAll('canvas') ?? []) as HTMLCanvasElement[]
    const valid = canvases.filter((c) => c.width > 0 && c.height > 0)
    if (valid.length === 0) return ''
    
    const composite = document.createElement('canvas')
    composite.width = valid[0].width
    composite.height = valid[0].height
    const ctx = composite.getContext('2d')!
    valid.forEach((c) => {
      try { ctx.drawImage(c, 0, 0) } catch { /* skip cross-origin */ }
    })
    return composite.toDataURL('image/png')
  }

  const hideAll = () => {
    layers.forEach(l => l.setVisible(false))
    if (vectorLyr) {
      vectorLyr.setStyle(() => null)
    }
  }

  // 1. Capture Base Map
  const originalBasemapState = originalStates.get(basemapLyr)
  if (basemapLyr && originalBasemapState?.visible) {
    hideAll()
    basemapLyr.setVisible(true)
    mapInstance.renderSync()
    const dataUrl = getCanvasData()
    if (dataUrl) {
      captured.push({ name: 'Base Map', dataUrl })
    }
  }

  // 2. Capture GeoTIFF layers
  for (const lyr of geoTiffLyrs) {
    const name = lyr.get('name')
    if (name && originalStates.get(lyr)?.visible) {
      hideAll()
      lyr.setVisible(true)
      mapInstance.renderSync()
      const dataUrl = getCanvasData()
      if (dataUrl) {
        captured.push({ name, dataUrl })
      }
    }
  }

  // 3. Capture Vector layers
  //    • When features are selected: render each selected layer separately (one OCG layer per layer name)
  //    • When nothing is selected: render ALL visible vector features in one pass
  const originalVectorState = originalStates.get(vectorLyr)
  if (vectorLyr && originalVectorState?.visible) {
    const originalStyle = originalVectorState.style

    if (hasSelection) {
      // Selective: one canvas capture per selected layer name
      for (const name of selectedLayers) {
        hideAll()
        vectorLyr.setVisible(true)
        vectorLyr.setStyle((feature: any, resolution: any) => {
          const ln = feature.get('layer_name')
          const fid = feature.get('feature_id') || String(feature.getId() || '')
          if (ln !== name || !selectedIds.has(fid)) return null
          if (typeof originalStyle === 'function') return originalStyle(feature, resolution)
          return originalStyle ?? null
        })
        mapInstance.renderSync()
        const dataUrl = getCanvasData()
        if (dataUrl) captured.push({ name, dataUrl })
      }
    } else {
      // No selection: capture all visible features grouped by layer name
      const allLayers = Array.from(new Set(
        (vectorLyr.getSource?.()?.getFeatures?.() ?? [])
          .map((f: any) => f.get('layer_name'))
          .filter(Boolean)
      )) as string[]

      if (allLayers.length === 0) {
        // Fallback: capture all features in a single pass
        hideAll()
        vectorLyr.setVisible(true)
        if (typeof originalStyle !== 'undefined') vectorLyr.setStyle(originalStyle)
        mapInstance.renderSync()
        const dataUrl = getCanvasData()
        if (dataUrl) captured.push({ name: 'Survey Features', dataUrl })
      } else {
        for (const name of allLayers) {
          hideAll()
          vectorLyr.setVisible(true)
          vectorLyr.setStyle((feature: any, resolution: any) => {
            if (feature.get('layer_name') !== name) return null
            if (typeof originalStyle === 'function') return originalStyle(feature, resolution)
            return originalStyle ?? null
          })
          mapInstance.renderSync()
          const dataUrl = getCanvasData()
          if (dataUrl) captured.push({ name, dataUrl })
        }
      }
    }
  }

  // 4. Capture Annotations & Drawings
  const visibleOtherLyrs = otherLyrs.filter(l => originalStates.get(l)?.visible)
  if (visibleOtherLyrs.length > 0) {
    hideAll()
    visibleOtherLyrs.forEach(l => l.setVisible(true))
    mapInstance.renderSync()
    const dataUrl = getCanvasData()
    if (dataUrl) {
      captured.push({ name: 'Drawings & Annotations', dataUrl })
    }
  }

  // Restore original states
  layers.forEach(l => {
    const state = originalStates.get(l)
    if (state) {
      l.setVisible(state.visible)
      if (state.style !== undefined && typeof (l as any).setStyle === 'function') {
        (l as any).setStyle(state.style)
      }
    }
  })

  if (captureScale > 1 && originalSize && originalResolution) {
    mapInstance.setSize(originalSize)
    view.setResolution(originalResolution)
  }
  mapInstance.renderSync()

  return captured
}

export default function PrintLayoutModal({
  open, onClose, mapInstance, projectName = 'Project', orgName = '', legend = [],
  selectLayer, selectedCount: selectedCountProp = 0,
}: Props) {
  const branding = useBranding()
  const [form] = Form.useForm()
  const [generating, setGenerating] = useState(false)
  const [exportingPng, setExportingPng] = useState(false)

  // Use the count passed from MapPage (reactive) — fall back to reading the layer directly
  const selectedCount = selectedCountProp

  // Derive selected layer names from the selection layer ref (evaluated at print time)
  function getSelectedFeatures() {
    if (selectLayer?.current) {
      return selectLayer.current.getSource()?.getFeatures() ?? []
    }
    // Fallback: find by zIndex in map layers
    if (mapInstance) {
      const layers = mapInstance.getLayers().getArray()
      const selLyr = layers.find(l => l.getZIndex() === 11) as any
      return selLyr?.getSource()?.getFeatures() ?? []
    }
    return []
  }

  const selectedLayers = useMemo(() => {
    if (!open) return []
    const feats = getSelectedFeatures()
    return Array.from(new Set(feats.map((f: any) => f.get('layer_name')).filter(Boolean))) as string[]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedCountProp])   // re-run when selection changes

  // Legend: when features are selected, only show layers that have selections;
  // when nothing is selected, show all legend items (print will use all features).
  const activeLegend = useMemo(() => {
    if (selectedCount === 0) return legend  // all layers visible
    return legend.filter((item) => {
      if (item.type === 'raster') return true
      return selectedLayers.includes(item.name)
    })
  }, [legend, selectedLayers, selectedCount])

  async function handlePrint() {
    if (!mapInstance) { message.error('Map not ready'); return }
    const { default: jsPDF } = await import('jspdf')
    const vals = form.getFieldsValue()
    const { title, subtitle, orientation, pageSize, dpi, showLegend, showNorth, showScale, showGrid, showCoords, showAttrib, exportAttributes } = vals
    setGenerating(true)

    try {
      const paper = PAPER_SIZES[pageSize as string] ?? PAPER_SIZES.A4
      const isLand = orientation === 'landscape'

      // docW / docH in mm
      const docW = isLand ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h)
      const docH = isLand ? Math.min(paper.w, paper.h) : Math.max(paper.w, paper.h)

      // Typography scale: 1.0 at A4 portrait height 297mm
      const tScale = docH / 297

      // Layout constants scaled to paper
      const margin   = Math.round(8  * tScale)
      const headerH  = Math.round(20 * tScale)
      const footerH  = Math.round(12 * tScale)
      const legendW  = showLegend && activeLegend.length > 0 ? Math.round(52 * tScale) : 0
      const mapTop   = margin + headerH + 2
      const mapH     = docH - margin * 2 - headerH - footerH - 4
      const mapW     = docW - margin * 2 - legendW

      // Font sizes (all scaled)
      const FS = {
        title:    ts(12, tScale),
        subtitle: ts(7,  tScale),
        label:    ts(6,  tScale),
        small:    ts(5,  tScale),
        legend:   ts(6.5, tScale),
        grid:     ts(5,  tScale),
      }

      // Capture map layers at high DPI with interactive filtering
      const capturedLayers = await captureMapLayers(mapInstance, dpi, legend, selectLayer)

      // Create PDF
      const fmtParam = typeof paper.fmt === 'string'
        ? paper.fmt
        : [docW, docH] as [number, number]

      const doc = new jsPDF({
        orientation: orientation as 'portrait' | 'landscape',
        unit: 'mm',
        format: fmtParam,
        compress: true,
      })

      // Extract active vector features attributes for the attribute table page
      const printFeatures: any[] = []
      if (exportAttributes) {
        getSelectedFeatures().forEach((f: any) => {
          const ln = f.get('layer_name')
          if (ln) {
            printFeatures.push({
              layer_name: ln,
              feature_id: f.get('feature_id') || String(f.getId() || ''),
              attributes: f.get('attributes') || {}
            })
          }
        })
      }

      // Calculate total pages including attributes
      let attributePages = 0
      const col1X = margin
      const col2X = margin + 40 * tScale
      const col3X = margin + 75 * tScale
      const tableW = docW - margin * 2
      
      if (exportAttributes && printFeatures.length > 0) {
        let currentY = margin + 15 * tScale
        attributePages = 1
        for (const feat of printFeatures) {
          const attrLines: string[] = []
          Object.entries(feat.attributes).forEach(([k, v]) => {
            attrLines.push(`${k}: ${v}`)
          })
          if (attrLines.length === 0) attrLines.push('(no attributes)')
          const wrappedAttrs = doc.splitTextToSize(attrLines.join('\n'), (docW - margin - col3X) - 4) as string[]
          const wrappedLayer = doc.splitTextToSize(feat.layer_name, (col2X - col1X) - 4) as string[]
          const wrappedId = doc.splitTextToSize(feat.feature_id, (col3X - col2X) - 4) as string[]
          const rowH = Math.max(wrappedLayer.length, wrappedId.length, wrappedAttrs.length) * 4.5 * tScale + 2 * tScale
          if (currentY + rowH > docH - margin - 10 * tScale) {
            attributePages++
            currentY = margin + 21 * tScale
          }
          currentY += rowH
        }
      }
      const totalPages = 1 + attributePages

      // ── Header ────────────────────────────────────────────────────────
      const hGrad1: [number,number,number] = [10, 35, 75]
      const hGrad2: [number,number,number] = [22, 60, 120]
      doc.setFillColor(...hGrad1)
      doc.rect(margin, margin, docW - margin * 2, headerH, 'F')
      // thin accent stripe
      doc.setFillColor(...hGrad2)
      doc.rect(margin, margin + headerH - 1.5 * tScale, docW - margin * 2, 1.5 * tScale, 'F')

      doc.setTextColor(255, 255, 255)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(FS.title)
      doc.text(title || projectName, margin + 4 * tScale, margin + 8 * tScale)

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(FS.subtitle)
      doc.setTextColor(180, 210, 240)
      if (subtitle) doc.text(subtitle, margin + 4 * tScale, margin + 13 * tScale)
      if (orgName)  doc.text(orgName, margin + 4 * tScale, margin + (subtitle ? 17 : 14) * tScale)

      // Date + coordinate system in top-right
      const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      doc.setFontSize(FS.small)
      doc.setTextColor(200, 220, 240)
      doc.text(dateStr, docW - margin - 2 * tScale, margin + 8 * tScale, { align: 'right' })
      doc.text('CRS: WGS 84 / EPSG:4326', docW - margin - 2 * tScale, margin + 13 * tScale, { align: 'right' })

      // ── Map image stack ─────────────────────────────────────────────────────
      if (capturedLayers.length > 0) {
        capturedLayers.forEach(lyr => {
          doc.addImage(lyr.dataUrl, 'PNG', margin, mapTop, mapW, mapH)
        })
      } else {
        doc.setFillColor(220, 225, 230)
        doc.rect(margin, mapTop, mapW, mapH, 'F')
        doc.setFontSize(FS.label)
        doc.setTextColor(120, 120, 120)
        doc.text('Map image unavailable', margin + mapW / 2, mapTop + mapH / 2, { align: 'center', baseline: 'middle' })
      }
      
      // Map border
      doc.setDrawColor(60, 100, 150)
      doc.setLineWidth(0.5 * tScale)
      doc.rect(margin, mapTop, mapW, mapH)

      // ── Coordinate grid labels ────────────────────────────────────────
      if (showGrid && mapInstance) {
        const view  = mapInstance.getView()
        const size  = mapInstance.getSize() ?? [800, 600]
        const ext   = view.calculateExtent(size)
        const [minX, minY, maxX, maxY] = ext
        const steps = 4

        doc.setFontSize(FS.grid)
        doc.setFont('helvetica', 'normal')

        for (let i = 0; i <= steps; i++) {
          const px3857 = minX + ((maxX - minX) * i) / steps
          const py3857 = minY + ((maxY - minY) * i) / steps
          const [lon, lat] = toLonLat([px3857, py3857])

          const pdfX = margin + (mapW * i) / steps
          const pdfY = mapTop + mapH - (mapH * i) / steps

          // bottom axis (longitude)
          doc.setTextColor(40, 40, 40)
          doc.text(`${lon.toFixed(3)}°E`, pdfX, mapTop + mapH + 4 * tScale, { align: 'center' })
          // left axis (latitude)
          if (i > 0) {
            doc.text(`${lat.toFixed(3)}°N`, margin - 1, pdfY, { align: 'right' })
          }

          // subtle grid line inside map
          if (i > 0 && i < steps) {
            doc.setDrawColor(255, 255, 255)
            doc.setLineWidth(0.15)
            doc.setGState(new (doc as any).GState({ opacity: 0.25 }))
            doc.line(pdfX, mapTop, pdfX, mapTop + mapH)
            doc.line(margin, pdfY, margin + mapW, pdfY)
            doc.setGState(new (doc as any).GState({ opacity: 1 }))
          }
        }
      }

      // ── North arrow ───────────────────────────────────────────────────
      const northSize = 12 * tScale
      if (showNorth) {
        const nx = margin + mapW - northSize - 4 * tScale
        const ny = mapTop + 4 * tScale
        // White circle background
        doc.setFillColor(255, 255, 255)
        doc.setDrawColor(100, 140, 180)
        doc.setLineWidth(0.4)
        doc.circle(nx + northSize / 2, ny + northSize / 2, northSize * 0.72, 'FD')
        drawNorthArrow(doc, nx, ny, northSize)
      }

      // ── Scale bar ─────────────────────────────────────────────────────
      if (showScale) {
        const res = mapInstance.getView().getResolution() ?? 1
        const sbX = margin + 4 * tScale
        const sbY = mapTop + mapH - 10 * tScale
        const captureScale = dpi === '300' ? 3 : dpi === '150' ? 2 : 1
        const mapCanvasW = (mapInstance.getSize()?.[0] ?? 800) * captureScale
        drawScaleBar(doc, sbX, sbY, res, mapCanvasW, mapW, tScale)
      }

      // ── Legend panel ──────────────────────────────────────────────────
      if (showLegend && activeLegend.length > 0) {
        const lx = margin + mapW + 2
        doc.setFillColor(248, 250, 252)
        doc.setDrawColor(160, 185, 210)
        doc.setLineWidth(0.4)
        doc.roundedRect(lx, mapTop, legendW, mapH, 1.5, 1.5, 'FD')

        // Legend title bar
        doc.setFillColor(10, 35, 75)
        doc.roundedRect(lx, mapTop, legendW, 8 * tScale, 1.5, 1.5, 'F')
        doc.rect(lx, mapTop + 4 * tScale, legendW, 4 * tScale, 'F')  // bottom corners square

        doc.setFontSize(FS.label)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(255, 255, 255)
        doc.text('LEGEND', lx + legendW / 2, mapTop + 5.5 * tScale, { align: 'center' })

        let ly = mapTop + 12 * tScale
        const swatchW = 5 * tScale
        const swatchH = 3.5 * tScale
        const textX = lx + 4 * tScale + swatchW + 2 * tScale
        const maxW = legendW - swatchW - 8 * tScale

        for (const item of activeLegend) {
          if (ly + swatchH + 2 * tScale > mapTop + mapH - 2) break

          if (item.type === 'raster') {
            doc.setFillColor(160, 190, 220)
            doc.rect(lx + 4 * tScale, ly, swatchW, swatchH, 'F')
            doc.setDrawColor(100, 140, 180)
            doc.setLineWidth(0.3)
            doc.line(lx + 4 * tScale, ly, lx + 4 * tScale + swatchW, ly + swatchH)
            doc.line(lx + 4 * tScale, ly + swatchH / 2, lx + 4 * tScale + swatchW, ly + swatchH / 2 + swatchH * 0.4)
          } else {
            const [r, g, b] = hexToRgb(item.color)
            doc.setFillColor(r, g, b)
            doc.setDrawColor(Math.max(0, r - 40), Math.max(0, g - 40), Math.max(0, b - 40))
            doc.setLineWidth(0.25)
            doc.roundedRect(lx + 4 * tScale, ly, swatchW, swatchH, 0.5, 0.5, 'FD')
          }

          doc.setFontSize(FS.legend)
          doc.setFont('helvetica', 'normal')
          doc.setTextColor(30, 30, 30)
          const lines = doc.splitTextToSize(item.name, maxW)
          doc.text(lines.slice(0, 2) as string[], textX, ly + 2.8 * tScale)
          ly += (lines.length > 1 ? 7 : 5.5) * tScale
        }
      }

      // ── Footer ────────────────────────────────────────────────────────
      const fy = mapTop + mapH + (showGrid ? 8 * tScale : 3 * tScale)

      doc.setDrawColor(100, 130, 160)
      doc.setLineWidth(0.3)
      doc.line(margin, fy, docW - margin, fy)

      doc.setFontSize(FS.small)
      doc.setFont('helvetica', 'italic')
      doc.setTextColor(80, 80, 80)

      if (showAttrib) {
        doc.text(`© ${branding.app_title} — ${branding.app_subtitle}`, margin, fy + 4 * tScale)
      } else {
        doc.text(`Generated by ${branding.app_title} — ${branding.app_subtitle}`, margin, fy + 4 * tScale)
      }

      // Coordinate bounding box in footer
      if (showCoords && mapInstance) {
        const ext = mapInstance.getView().calculateExtent(mapInstance.getSize() ?? [800, 600])
        const [swLon, swLat] = toLonLat([ext[0], ext[1]])
        const [neLon, neLat] = toLonLat([ext[2], ext[3]])
        const bboxStr = `Extent: ${swLat.toFixed(4)}°N ${swLon.toFixed(4)}°E — ${neLat.toFixed(4)}°N ${neLon.toFixed(4)}°E`
        doc.text(bboxStr, margin, fy + 8 * tScale)
      }

      doc.setFont('helvetica', 'normal')
      doc.text(`Page 1 of ${totalPages}`, docW - margin, fy + 4 * tScale, { align: 'right' })

      // Calculate GFW (World File for PDF) coefficients at standard 150 DPI
      const view = mapInstance.getView()
      const ext = view.calculateExtent(mapInstance.getSize() ?? [800, 600])
      const extW = ext[2] - ext[0]
      const extH = ext[3] - ext[1]

      const pageWMeters = extW * (docW / mapW)
      const pageHMeters = extH * (docH / mapH)

      const originX = ext[0] - (margin * (extW / mapW))
      const originY = ext[3] + (mapTop * (extH / mapH))

      const pixelsPerMm = 150 / 25.4
      const wPixels = docW * pixelsPerMm
      const hPixels = docH * pixelsPerMm

      const resX = pageWMeters / wPixels
      const resY = pageHMeters / hPixels

      const ulX = originX + (resX / 2)
      const ulY = originY - (resY / 2)

      const gfwLines = [
        resX.toFixed(10),
        '0.0',
        '0.0',
        (-resY).toFixed(10),
        ulX.toFixed(5),
        ulY.toFixed(5)
      ]
      const gfwContent = gfwLines.join('\n') + '\n'

      // ── Append Attribute Table Pages ───────────────────────────────────
      if (exportAttributes && printFeatures.length > 0) {
        let currentY = margin + 15 * tScale
        let pageNum = 2
        
        const drawPageHeader = (pNum: number) => {
          doc.setFillColor(...hGrad1)
          doc.rect(margin, margin, docW - margin * 2, 12 * tScale, 'F')
          doc.setTextColor(255, 255, 255)
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(FS.title * 0.8)
          doc.text('FEATURE ATTRIBUTES TABLE', margin + 4 * tScale, margin + 8 * tScale)
          
          doc.setFont('helvetica', 'italic')
          doc.setFontSize(FS.small)
          doc.setTextColor(180, 210, 240)
          doc.text(`Page ${pNum} of ${totalPages}`, docW - margin - 4 * tScale, margin + 8 * tScale, { align: 'right' })
          
          doc.setTextColor(30, 30, 30)
          doc.setFont('helvetica', 'normal')
        }
        
        const drawTableHeader = (y: number) => {
          doc.setFillColor(230, 235, 245)
          doc.rect(margin, y, tableW, 6 * tScale, 'F')
          doc.setDrawColor(180, 190, 210)
          doc.setLineWidth(0.2 * tScale)
          doc.rect(margin, y, tableW, 6 * tScale, 'S')
          
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(FS.label)
          doc.setTextColor(40, 60, 100)
          doc.text('Layer Name', col1X + 2, y + 4.5 * tScale)
          doc.text('Feature ID', col2X + 2, y + 4.5 * tScale)
          doc.text('Attributes', col3X + 2, y + 4.5 * tScale)
          doc.setFont('helvetica', 'normal')
          doc.setTextColor(30, 30, 30)
        }
        
        doc.addPage(fmtParam, orientation as 'portrait' | 'landscape')
        drawPageHeader(pageNum)
        drawTableHeader(currentY)
        currentY += 6 * tScale
        
        for (const feat of printFeatures) {
          const attrLines: string[] = []
          Object.entries(feat.attributes).forEach(([k, v]) => {
            attrLines.push(`${k}: ${v}`)
          })
          if (attrLines.length === 0) {
            attrLines.push('(no attributes)')
          }
          
          const wrappedLayer = doc.splitTextToSize(feat.layer_name, (col2X - col1X) - 4) as string[]
          const wrappedId = doc.splitTextToSize(feat.feature_id, (col3X - col2X) - 4) as string[]
          const wrappedAttrs = doc.splitTextToSize(attrLines.join('\n'), (docW - margin - col3X) - 4) as string[]
          
          const rowH = Math.max(
            wrappedLayer.length * 4.5 * tScale,
            wrappedId.length * 4.5 * tScale,
            wrappedAttrs.length * 4.5 * tScale
          ) + 2 * tScale
          
          if (currentY + rowH > docH - margin - 10 * tScale) {
            doc.setFontSize(FS.small)
            doc.setTextColor(120, 120, 120)
            doc.text(`Generated by ${branding.app_title}`, margin, docH - margin + 4 * tScale)
            doc.text(`Page ${pageNum} of ${totalPages}`, docW - margin, docH - margin + 4 * tScale, { align: 'right' })
            
            doc.addPage(fmtParam, orientation as 'portrait' | 'landscape')
            pageNum++
            currentY = margin + 15 * tScale
            drawPageHeader(pageNum)
            drawTableHeader(currentY)
            currentY += 6 * tScale
          }
          
          doc.setDrawColor(210, 220, 235)
          doc.setLineWidth(0.15 * tScale)
          doc.rect(margin, currentY, tableW, rowH, 'S')
          doc.line(col2X, currentY, col2X, currentY + rowH)
          doc.line(col3X, currentY, col3X, currentY + rowH)
          
          doc.setFontSize(FS.label)
          doc.text(wrappedLayer, col1X + 2, currentY + 4 * tScale)
          doc.text(wrappedId, col2X + 2, currentY + 4 * tScale)
          doc.text(wrappedAttrs, col3X + 2, currentY + 4 * tScale)
          
          currentY += rowH
        }
        
        doc.setFontSize(FS.small)
        doc.setTextColor(120, 120, 120)
        doc.text(`Generated by ${branding.app_title}`, margin, docH - margin + 4 * tScale)
        doc.text(`Page ${pageNum} of ${totalPages}`, docW - margin, docH - margin + 4 * tScale, { align: 'right' })
      }

      // ── Save & Watermark ──────────────────────────────────────────────
      const filename = `${(title || projectName).replace(/[^a-zA-Z0-9_-]/g, '_')}_${pageSize}_${orientation}.pdf`
      const pdfBlob = doc.output('blob')
      
      const formData = new FormData()
      formData.append('file', pdfBlob, filename)

      const layerNames = capturedLayers.map(lyr => lyr.name)
      formData.append('layers', JSON.stringify(layerNames))

      const response = await api.post('/core/watermark-file/', formData, {
        responseType: 'blob',
        headers: {
          'Content-Type': 'multipart/form-data',
        }
      })

      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      // Download GFW World File
      const gfwFilename = filename.replace(/\.pdf$/, '.gfw')
      const gfwBlob = new Blob([gfwContent], { type: 'text/plain' })
      const urlGfw = window.URL.createObjectURL(gfwBlob)
      const linkGfw = document.createElement('a')
      linkGfw.href = urlGfw
      linkGfw.download = gfwFilename
      document.body.appendChild(linkGfw)
      linkGfw.click()
      document.body.removeChild(linkGfw)
      window.URL.revokeObjectURL(urlGfw)

      message.success('PDF and World File downloaded successfully!')
      onClose()
    } catch (err: any) {
      console.error(err)
      message.error(`PDF generation failed: ${err?.message ?? err}`)
    } finally {
      setGenerating(false)
    }
  }

  async function handleExportServer() {
    if (!mapInstance) { message.error('Map not ready'); return }
    setExportingPng(true)
    try {
      const vals    = form.getFieldsValue()
      const view    = mapInstance.getView()
      const size    = mapInstance.getSize() ?? [800, 600]
      const ext     = view.calculateExtent(size)
      const [swLon, swLat] = toLonLat([ext[0], ext[1]])
      const [neLon, neLat] = toLonLat([ext[2], ext[3]])

      // Capture map layers at high DPI with interactive filtering
      const capturedLayers = await captureMapLayers(mapInstance, vals.dpi, legend, selectLayer)
      
      const layerImages = capturedLayers.map(lyr => ({
        name: lyr.name,
        image_b64: lyr.dataUrl.split(',')[1]
      }))

      // Scale denominator: (m/px) * (px/mm_on_paper) * 1000 mm/m
      const paper  = PAPER_SIZES[vals.pageSize as string] ?? PAPER_SIZES.A4
      const isLand = vals.orientation === 'landscape'
      const mapWmm = isLand ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h)
      const res    = view.getResolution() ?? 1
      const scaleDenom = Math.round(res * size[0] / mapWmm * 1000)

      // Extract active vector features attributes for the attribute table page
      const printFeatures: any[] = []
      if (vals.exportAttributes) {
        getSelectedFeatures().forEach((f: any) => {
          const ln = f.get('layer_name')
          if (ln) {
            printFeatures.push({
              layer_name: ln,
              feature_id: f.get('feature_id') || String(f.getId() || ''),
              attributes: f.get('attributes') || {}
            })
          }
        })
      }

      const payload = {
        layer_images:       layerImages,
        layers:             capturedLayers.map(lyr => lyr.name),
        title:              vals.title || projectName,
        subtitle:           vals.subtitle || '',
        org_name:           orgName,
        paper_size:         vals.pageSize,
        orientation:        vals.orientation,
        show_legend:        vals.showLegend,
        show_north:         vals.showNorth,
        dpi:                vals.dpi,
        show_scale:         vals.showScale,
        show_coords:        vals.showCoords,
        show_attrib:        vals.showAttrib,
        legend:             activeLegend,
        extent:             { sw_lat: swLat, sw_lon: swLon, ne_lat: neLat, ne_lon: neLon },
        scale_denominator:  scaleDenom,
        export_attributes:  vals.exportAttributes,
        features:           printFeatures,
      }

      // Calculate GFW (World File for PDF) coefficients at standard 150 DPI
      const docW = isLand ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h)
      const docH = isLand ? Math.min(paper.w, paper.h) : Math.max(paper.w, paper.h)
      const tScale = docH / 297
      const margin = Math.round(8 * tScale)
      const headerH = Math.round(20 * tScale)
      const footerH = Math.round(12 * tScale)
      const legendW = vals.showLegend && activeLegend.length > 0 ? Math.round(52 * tScale) : 0
      const mapTop = margin + headerH + 2
      const mapW = docW - margin * 2 - legendW
      const mapH = docH - margin * 2 - headerH - footerH - 4

      const extW = ext[2] - ext[0]
      const extH = ext[3] - ext[1]

      const pageWMeters = extW * (docW / mapW)
      const pageHMeters = extH * (docH / mapH)

      const originX = ext[0] - (margin * (extW / mapW))
      const originY = ext[3] + (mapTop * (extH / mapH))

      const pixelsPerMm = 150 / 25.4
      const wPixels = docW * pixelsPerMm
      const hPixels = docH * pixelsPerMm

      const resX = pageWMeters / wPixels
      const resY = pageHMeters / hPixels

      const ulX = originX + (resX / 2)
      const ulY = originY - (resY / 2)

      const gfwLines = [
        resX.toFixed(10),
        '0.0',
        '0.0',
        (-resY).toFixed(10),
        ulX.toFixed(5),
        ulY.toFixed(5)
      ]
      const gfwContent = gfwLines.join('\n') + '\n'

      const response = await api.post('/core/print-pdf/', payload, { responseType: 'blob' })
      const url  = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }))
      const filename = `${(vals.title || projectName).replace(/[^a-zA-Z0-9_-]/g, '_')}_${vals.pageSize}_arcgis.pdf`

      const link = document.createElement('a')
      link.href  = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      // Download GFW World File
      const gfwFilename = filename.replace(/\.pdf$/, '.gfw')
      const gfwBlob = new Blob([gfwContent], { type: 'text/plain' })
      const urlGfw = window.URL.createObjectURL(gfwBlob)
      const linkGfw = document.createElement('a')
      linkGfw.href = urlGfw
      linkGfw.download = gfwFilename
      document.body.appendChild(linkGfw)
      linkGfw.click()
      document.body.removeChild(linkGfw)
      window.URL.revokeObjectURL(urlGfw)

      message.success('PDF and World File exported successfully')
      onClose()
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? err?.message ?? 'Unknown error'
      if (err?.response?.status === 503) {
        message.error('Print service offline — start it with: docker compose up -d print-service')
      } else {
        message.error(`Server PDF export failed: ${detail}`)
      }
    } finally {
      setExportingPng(false)
    }
  }

  return (
    <DraggableModal
      title={<><PrinterOutlined style={{ marginRight: 8 }} />Print Map Layout</>}
      open={open}
      onCancel={onClose}
      width={520}
      styles={{ body: { background: '#0e0e1e', maxHeight: '75vh', overflowY: 'auto' } }}
      footer={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Tooltip title="Server-rendered ArcGIS-style PDF via Playwright (high quality)">
            <Button
              icon={<GlobalOutlined />}
              loading={exportingPng}
              disabled={generating || selectedCount === 0}
              onClick={handleExportServer}
            >
              Export PDF (ArcGIS)
            </Button>
          </Tooltip>
          <Tooltip title="Quick client-side PDF via jsPDF">
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={generating}
              disabled={exportingPng || selectedCount === 0}
              onClick={handlePrint}
            >
              Generate PDF
            </Button>
          </Tooltip>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          title: projectName,
          subtitle: '',
          orientation: 'landscape',
          pageSize: 'A4',
          dpi: '150',
          showLegend: true,
          showNorth: true,
          showScale: true,
          showGrid: false,
          showCoords: true,
          showAttrib: true,
          exportAttributes: false,
        }}
        style={{ marginTop: 12 }}
      >
        <Form.Item label={<span style={{ color: '#aaa', fontSize: 12 }}>Map Title</span>} name="title">
          <Input placeholder="e.g. AF Tambaram — Survey Map" />
        </Form.Item>

        <Form.Item label={<span style={{ color: '#aaa', fontSize: 12 }}>Sub-title / Remarks</span>} name="subtitle">
          <Input placeholder="e.g. Phase I — Ver II (optional)" />
        </Form.Item>

        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item
            label={<span style={{ color: '#aaa', fontSize: 12 }}>Paper Size</span>}
            name="pageSize"
            style={{ flex: 1 }}
          >
            <Select
              options={[
                { label: '── ISO A Series ──', value: '__a', disabled: true },
                { value: 'A0', label: 'A0  (841 × 1189 mm)' },
                { value: 'A1', label: 'A1  (594 × 841 mm)' },
                { value: 'A2', label: 'A2  (420 × 594 mm)' },
                { value: 'A3', label: 'A3  (297 × 420 mm)' },
                { value: 'A4', label: 'A4  (210 × 297 mm)' },
                { value: 'A5', label: 'A5  (148 × 210 mm)' },
                { label: '── ISO B Series ──', value: '__b', disabled: true },
                { value: 'B0', label: 'B0  (1000 × 1414 mm)' },
                { value: 'B1', label: 'B1  (707 × 1000 mm)' },
                { value: 'B2', label: 'B2  (500 × 707 mm)' },
                { label: '── US Sizes ──', value: '__us', disabled: true },
                { value: 'Letter',  label: 'Letter  (216 × 279 mm)' },
                { value: 'Legal',   label: 'Legal   (216 × 356 mm)' },
                { value: 'Tabloid', label: 'Tabloid (279 × 432 mm)' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label={<span style={{ color: '#aaa', fontSize: 12 }}>Orientation</span>}
            name="orientation"
            style={{ flex: 1 }}
          >
            <Select
              options={[
                { value: 'landscape', label: 'Landscape' },
                { value: 'portrait',  label: 'Portrait'  },
              ]}
            />
          </Form.Item>
        </div>

        <Form.Item label={<span style={{ color: '#aaa', fontSize: 12 }}>Output Quality</span>} name="dpi">
          <Radio.Group buttonStyle="solid" size="small">
            <Radio.Button value="72">Screen  (72 DPI)</Radio.Button>
            <Radio.Button value="150">Print  (150 DPI)</Radio.Button>
            <Radio.Button value="300">High  (300 DPI)</Radio.Button>
          </Radio.Group>
        </Form.Item>

        <Divider style={{ borderColor: '#1a2a4a', margin: '8px 0' }} />

        <Form.Item label={<span style={{ color: '#aaa', fontSize: 12 }}>Include elements</span>}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
            {[
              { name: 'showNorth',  label: 'North Arrow'       },
              { name: 'showScale',  label: 'Scale Bar'         },
              { name: 'showLegend', label: 'Legend'            },
              { name: 'showGrid',   label: 'Coordinate Grid'   },
              { name: 'showCoords', label: 'Extent Coordinates'},
              { name: 'showAttrib', label: 'Attribution'       },
              { name: 'exportAttributes', label: 'Feature Attributes Table' },
            ].map(({ name, label }) => (
              <Form.Item key={name} name={name} valuePropName="checked" noStyle>
                <Checkbox style={{ color: '#ccc', fontSize: 12 }}>{label}</Checkbox>
              </Form.Item>
            ))}
          </div>
        </Form.Item>

        {selectedCount === 0 ? (
          <Alert
            type="info"
            showIcon
            icon={<SelectOutlined />}
            message={
              <Space>
                <span>All Features Mode</span>
                <Tag color="blue" style={{ fontSize: 10 }}>No selection</Tag>
              </Space>
            }
            description={
              <span>
                No features are selected — the export will include <strong>all visible features</strong> from the current map view.{' '}
                To export specific features only, close this dialog, use the{' '}
                <strong>SELECTION</strong> tools (Box Select or Polygon Select) on the left toolbar, then reopen Print/Export.
              </span>
            }
            style={{ marginBottom: 12 }}
          />
        ) : (
          <Alert
            type="success"
            showIcon
            message={
              <Space>
                <span>Feature Selection Active</span>
                <Tag color="green" style={{ fontSize: 10 }}>{selectedCount} feature{selectedCount !== 1 ? 's' : ''}</Tag>
              </Space>
            }
            description={`${selectedCount} feature(s) across ${selectedLayers.length} layer(s) selected. The export will contain only these features with their attributes.`}
            style={{ marginBottom: 12 }}
          />
        )}
      </Form>
    </DraggableModal>
  )
}
