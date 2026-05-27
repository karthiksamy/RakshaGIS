import { useRef, useEffect, useState } from 'react'
import {
  Tabs, Table, Button, Space, Tag, Typography, Tooltip,
} from 'antd'
import DraggableModal from '@/components/DraggableModal'
import {
  FileExcelOutlined, FilePdfOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import OLMap from 'ol/Map'
import View from 'ol/View'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Feature from 'ol/Feature'
import OLPoint from 'ol/geom/Point'
import OSM from 'ol/source/OSM'
import GeoJSON from 'ol/format/GeoJSON'
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style'
import { fromLonLat } from 'ol/proj'
import { defaults as defaultControls } from 'ol/control'
import type { BufferRingResult, BufferParcel, BufferSurveyArea } from '@/types'
import 'ol/ol.css'

const { Text } = Typography

export const BUFFER_COLORS = [
  '#4CAF50', // green
  '#FF9800', // orange
  '#2196F3', // blue
  '#E91E63', // pink
  '#9C27B0', // purple
  '#FF5722', // deep orange
  '#00BCD4', // cyan
  '#8BC34A', // light green
]

function ringLabel(r: BufferRingResult) {
  return `${r.distance}${r.unit === 'meters' ? 'm' : 'km'}`
}

interface Props {
  open: boolean
  onClose: () => void
  results: BufferRingResult[]
  centerLonLat: [number, number] | null
}

const STATUS_COLOR: Record<string, string> = {
  DRAFT: '#faad14', RETURNED: '#ff7875', SUBMITTED: '#69b1ff',
  UNDER_REVIEW: '#b37feb', APPROVED: '#52c41a', PUBLISHED: '#13c2c2',
}

const parcelColumns: ColumnsType<BufferParcel> = [
  { title: 'Parcel ID', dataIndex: 'parcel_id', width: 110, ellipsis: true },
  { title: 'Name', dataIndex: 'name', ellipsis: true },
  {
    title: 'Category',
    dataIndex: 'category_display',
    width: 130,
    render: (v) => <Tag style={{ fontSize: 11 }}>{v}</Tag>,
  },
  {
    title: 'Class',
    dataIndex: 'classification_display',
    width: 110,
    render: (v, row) => (
      <Tag color={row.classification === 'SECRET' ? 'red' : row.classification === 'CONFIDENTIAL' ? 'orange' : 'default'} style={{ fontSize: 11 }}>
        {v}
      </Tag>
    ),
  },
  { title: 'Area (ha)', dataIndex: 'area_hectares', width: 90, render: (v) => Number(v).toFixed(2) },
  { title: 'State', dataIndex: 'state_name', width: 100, ellipsis: true },
  { title: 'District', dataIndex: 'district_name', width: 100, ellipsis: true },
  { title: 'Organisation', dataIndex: 'organisation_name', width: 130, ellipsis: true },
]

const surveyAreaColumns: ColumnsType<BufferSurveyArea> = [
  {
    title: 'Survey Area',
    dataIndex: 'area_name',
    ellipsis: true,
    render: (v, row) => (
      <span>
        {v ?? <Text type="secondary" style={{ fontSize: 11 }}>No linked area</Text>}
        {row.area_code ? <Text type="secondary" style={{ fontSize: 10, marginLeft: 4 }}>({row.area_code})</Text> : null}
      </span>
    ),
  },
  {
    title: 'Status',
    dataIndex: 'status',
    width: 120,
    render: (v, row) => v
      ? <Tag color={STATUS_COLOR[v] || 'default'} style={{ fontSize: 11 }}>{row.status_display}</Tag>
      : null,
  },
  { title: 'Project', dataIndex: 'project_name', ellipsis: true, width: 180 },
  { title: 'Organisation', dataIndex: 'organisation', ellipsis: true, width: 150 },
  {
    title: 'Layers',
    dataIndex: 'layers',
    width: 160,
    render: (layers: string[]) => (
      <span style={{ fontSize: 11, color: '#90caf9' }}>{layers.join(', ')}</span>
    ),
  },
  { title: 'Features', dataIndex: 'feature_count', width: 80, align: 'right' },
]

export default function BufferAnalysisModal({ open, onClose, results, centerLonLat }: Props) {
  const miniMapRef = useRef<HTMLDivElement>(null)
  const miniMapInstance = useRef<OLMap | null>(null)
  const [activeTab, setActiveTab] = useState<string>('')

  useEffect(() => {
    if (!open) return
    if (results.length > 0) setActiveTab(String(results[0].distance))
  }, [open, results])

  useEffect(() => {
    if (!open || !miniMapRef.current || miniMapInstance.current) return

    const basemap = new TileLayer({ source: new OSM(), zIndex: 0 })

    // Buffer ring polygons
    const ringSource = new VectorSource()
    const ringLayer = new VectorLayer({
      source: ringSource,
      zIndex: 1,
    })

    // Parcel polygons
    const parcelSource = new VectorSource()
    const parcelLayer = new VectorLayer({
      source: parcelSource,
      style: new Style({
        fill: new Fill({ color: 'rgba(244,67,54,0.25)' }),
        stroke: new Stroke({ color: '#f44336', width: 1.5 }),
      }),
      zIndex: 3,
    })

    // Center point marker
    const pointSource = new VectorSource()
    const pointLayer = new VectorLayer({
      source: pointSource,
      style: new Style({
        image: new CircleStyle({
          radius: 6,
          fill: new Fill({ color: '#ff1744' }),
          stroke: new Stroke({ color: '#fff', width: 2 }),
        }),
      }),
      zIndex: 4,
    })

    const fmt = new GeoJSON()

    if (centerLonLat) {
      pointSource.addFeature(
        new Feature({ geometry: new OLPoint(fromLonLat(centerLonLat)) })
      )
    }

    results.forEach((ring, idx) => {
      const color = BUFFER_COLORS[idx % BUFFER_COLORS.length]
      const feature = fmt.readFeature(ring.buffer_geojson, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      }) as Feature
      feature.setStyle(
        new Style({
          fill: new Fill({ color: color + '22' }),
          stroke: new Stroke({ color, width: 2, lineDash: [6, 3] }),
        })
      )
      ringSource.addFeature(feature)

      ring.parcels.forEach((p) => {
        const pFeature = fmt.readFeature(p.geometry, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        }) as Feature
        parcelSource.addFeature(pFeature)
      })
    })

    const map = new OLMap({
      target: miniMapRef.current,
      layers: [basemap, ringLayer, parcelLayer, pointLayer],
      view: new View({ center: fromLonLat(centerLonLat ?? [78.9629, 22.5937]), zoom: 14 }),
      controls: defaultControls({ zoom: true, rotate: false, attribution: false }),
    })

    const extent = ringSource.getExtent()
    if (ringSource.getFeatures().length > 0 && extent) {
      map.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 16 })
    }

    miniMapInstance.current = map

    return () => {
      map.setTarget(undefined)
      miniMapInstance.current = null
    }
  }, [open])

  function downloadExcel() {
    import('xlsx').then((XLSX) => {
      const wb = XLSX.utils.book_new()
      results.forEach((ring) => {
        // Sheet 1: Survey Areas
        const saData = (ring.survey_areas ?? []).map((a) => ({
          'Survey Area': a.area_name ?? '—',
          'Area Code': a.area_code ?? '',
          'Status': a.status_display ?? '',
          'Project': a.project_name,
          'Organisation': a.organisation,
          'Feature Count': a.feature_count,
          'Layers': a.layers.join(', '),
        }))
        const saWs = XLSX.utils.json_to_sheet(saData)
        saWs['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 18 }, { wch: 30 }, { wch: 24 }, { wch: 12 }, { wch: 30 }]
        XLSX.utils.book_append_sheet(wb, saWs, `${ringLabel(ring)} — Areas`)

        // Sheet 2: Registered Parcels
        const data = ring.parcels.map((p) => ({
          'Parcel ID': p.parcel_id,
          'Name': p.name,
          'Category': p.category_display,
          'Classification': p.classification_display,
          'Area (ha)': Number(p.area_hectares).toFixed(4),
          'State': p.state_name,
          'District': p.district_name,
          'Organisation': p.organisation_name,
        }))
        const ws = XLSX.utils.json_to_sheet(data)
        ws['!cols'] = [{ wch: 14 }, { wch: 30 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 24 }]
        XLSX.utils.book_append_sheet(wb, ws, `${ringLabel(ring)} — Parcels`)
      })
      XLSX.writeFile(wb, 'buffer_analysis.xlsx')
    })
  }

  async function downloadPDF() {
    const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ])

    const doc = new jsPDF('landscape', 'mm', 'a4')
    const pageW = doc.internal.pageSize.getWidth()

    doc.setFontSize(14)
    doc.text('Buffer Analysis Report', 14, 14)
    doc.setFontSize(9)
    doc.text(`Centre: ${centerLonLat ? `${centerLonLat[1].toFixed(6)}°N, ${centerLonLat[0].toFixed(6)}°E` : ''}`, 14, 20)

    // Capture mini map canvas
    const canvas = miniMapRef.current?.querySelector('canvas') as HTMLCanvasElement | null
    if (canvas) {
      const imgData = canvas.toDataURL('image/png')
      const mapH = 80
      const mapW = pageW - 28
      doc.addImage(imgData, 'PNG', 14, 26, mapW, mapH)
    }

    let yPos = 115

    results.forEach((ring, idx) => {
      const color = BUFFER_COLORS[idx % BUFFER_COLORS.length]
      const hexColor = color.replace('#', '')
      const r = parseInt(hexColor.substring(0, 2), 16)
      const g = parseInt(hexColor.substring(2, 4), 16)
      const b = parseInt(hexColor.substring(4, 6), 16)

      const totalCount = (ring.survey_area_count ?? 0) + ring.parcels.length
      doc.setFontSize(10)
      doc.setTextColor(r, g, b)
      doc.text(`Buffer ${ringLabel(ring)}: ${ring.survey_area_count ?? 0} survey area(s), ${ring.parcels.length} registered parcel(s)`, 14, yPos)
      doc.setTextColor(0, 0, 0)
      yPos += 4

      if (totalCount === 0) {
        doc.setFontSize(8)
        doc.text('  No defence land found within this buffer.', 14, yPos + 2)
        yPos += 10
        return
      }

      // Survey areas table
      if ((ring.survey_areas ?? []).length > 0) {
        doc.setFontSize(8)
        doc.setTextColor(100, 180, 255)
        doc.text('Survey Areas:', 14, yPos + 2)
        doc.setTextColor(0, 0, 0)
        yPos += 4
        autoTable(doc, {
          startY: yPos,
          head: [['Survey Area', 'Area Code', 'Status', 'Project', 'Organisation', 'Features']],
          body: (ring.survey_areas ?? []).map((a) => [
            a.area_name ?? '—', a.area_code ?? '', a.status_display ?? '', a.project_name, a.organisation, a.feature_count,
          ]),
          styles: { fontSize: 7, cellPadding: 1.5 },
          headStyles: { fillColor: [60, 130, 220], fontSize: 7 },
          margin: { left: 14, right: 14 },
          theme: 'striped',
        })
        yPos = (doc as any).lastAutoTable.finalY + 6
        if (yPos > 185) { doc.addPage(); yPos = 14 }
      }

      // Registered parcels table
      if (ring.parcels.length > 0) {
        doc.setFontSize(8)
        doc.setTextColor(r, g, b)
        doc.text('Registered Parcels:', 14, yPos + 2)
        doc.setTextColor(0, 0, 0)
        yPos += 4
        autoTable(doc, {
          startY: yPos,
          head: [['Parcel ID', 'Name', 'Category', 'Classification', 'Area (ha)', 'State', 'District']],
          body: ring.parcels.map((p) => [
            p.parcel_id, p.name, p.category_display, p.classification_display,
            Number(p.area_hectares).toFixed(2), p.state_name, p.district_name,
          ]),
          styles: { fontSize: 7, cellPadding: 1.5 },
          headStyles: { fillColor: [r, g, b], fontSize: 7 },
          margin: { left: 14, right: 14 },
          theme: 'striped',
        })
        yPos = (doc as any).lastAutoTable.finalY + 8
      }
      if (yPos > 185) { doc.addPage(); yPos = 14 }
    })

    doc.save('buffer_analysis.pdf')
  }

  const tabItems = results.map((ring, idx) => {
    const totalCount = (ring.survey_area_count ?? 0) + ring.parcels.length
    return {
      key: String(ring.distance),
      label: (
        <span>
          <span
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: BUFFER_COLORS[idx % BUFFER_COLORS.length],
              marginRight: 6,
            }}
          />
          {ringLabel(ring)}
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
            ({totalCount})
          </Text>
        </span>
      ),
      children: (
        <Tabs
          size="small"
          defaultActiveKey="survey"
          style={{ padding: '0 4px' }}
          items={[
            {
              key: 'survey',
              label: (
                <span>
                  Survey Areas
                  {(ring.survey_area_count ?? 0) > 0 && (
                    <Tag color="blue" style={{ fontSize: 10, marginLeft: 4 }}>{ring.survey_area_count}</Tag>
                  )}
                </span>
              ),
              children: (
                <Table<BufferSurveyArea>
                  dataSource={ring.survey_areas ?? []}
                  columns={surveyAreaColumns}
                  rowKey={(r) => `${r.project_id}-${r.area_id ?? 'none'}`}
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `${t} area(s)` }}
                  scroll={{ x: 800 }}
                  locale={{ emptyText: 'No survey areas found within this buffer distance.' }}
                  rowClassName={(r) => r.status === 'APPROVED' || r.status === 'PUBLISHED' ? 'approved-row' : ''}
                />
              ),
            },
            {
              key: 'parcels',
              label: (
                <span>
                  Registered Parcels
                  {ring.parcels.length > 0 && (
                    <Tag color="orange" style={{ fontSize: 10, marginLeft: 4 }}>{ring.parcels.length}</Tag>
                  )}
                </span>
              ),
              children: (
                <Table<BufferParcel>
                  dataSource={ring.parcels}
                  columns={parcelColumns}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `${t} parcel(s)` }}
                  scroll={{ x: 900 }}
                  locale={{ emptyText: 'No registered defence parcels within this buffer distance.' }}
                />
              ),
            },
          ]}
        />
      ),
    }
  })

  return (
    <DraggableModal
      title="Buffer Analysis — Survey Areas & Defence Land"
      open={open}
      onCancel={onClose}
      footer={
        <Space>
          <Tooltip title="Download all rings as Excel workbook">
            <Button icon={<FileExcelOutlined />} onClick={downloadExcel}>
              Download Excel
            </Button>
          </Tooltip>
          <Tooltip title="Download report with map as PDF">
            <Button icon={<FilePdfOutlined />} type="primary" onClick={downloadPDF}>
              Download PDF
            </Button>
          </Tooltip>
          <Button onClick={onClose}>Close</Button>
        </Space>
      }
      width="90vw"
      styles={{ body: { padding: 0 } }}
      destroyOnClose
    >
      <div style={{ display: 'flex', height: '70vh', overflow: 'hidden' }}>
        {/* Mini map */}
        <div
          ref={miniMapRef}
          style={{ width: 420, flexShrink: 0, borderRight: '1px solid #222', background: '#111' }}
        />

        {/* Parcel tables per ring */}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', background: '#0e0e1e' }}>
          {results.length === 0 ? (
            <div style={{ textAlign: 'center', marginTop: 80, color: '#666' }}>
              No results yet.
            </div>
          ) : (
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
              items={tabItems}
              size="small"
              tabBarStyle={{ marginBottom: 8 }}
            />
          )}
        </div>
      </div>
    </DraggableModal>
  )
}
