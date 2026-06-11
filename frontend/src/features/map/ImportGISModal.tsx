/**
 * ImportGISModal — import a Shapefile ZIP, GeoJSON, KML or GeoPackage
 * into the selected survey area's "Shape Files" folder.
 *
 * Backend endpoint:
 *   POST /api/projects/folders/{id}/import-gis-file/
 *   multipart: file, layer_name, name_field
 */
import { useRef, useState } from 'react'
import {
  Modal, Form, Input, Upload, Button, Space, Typography,
  Tag, Alert, Collapse, message, Select,
} from 'antd'
import {
  InboxOutlined, FileZipOutlined, GlobalOutlined,
  CheckCircleOutlined, WarningOutlined, CloseCircleOutlined,
  PlusOutlined, MinusCircleOutlined,
} from '@ant-design/icons'
import api from '@/services/api'
import type { SurveyArea } from '@/types'

const { Dragger } = Upload
const { Text } = Typography

interface FlatFolder {
  id: number
  parent: number | null
  folder_type: string
  name: string
}

interface Props {
  open: boolean
  onClose: () => void
  projectId: number
  surveyArea: SurveyArea | null
  flatFolders: FlatFolder[]
  onImported: () => void
}

interface ImportResult {
  created: number
  errors: string[]
  detail: string
}

const EXT_META: Record<string, { label: string; color: string }> = {
  '.zip':     { label: 'Shapefile ZIP', color: 'blue'   },
  '.geojson': { label: 'GeoJSON',       color: 'green'  },
  '.json':    { label: 'GeoJSON',       color: 'green'  },
  '.kml':     { label: 'KML',           color: 'orange' },
  '.gpkg':    { label: 'GeoPackage',    color: 'purple' },
  '.gpx':     { label: 'GPX GPS track', color: 'cyan'   },
  '.csv':     { label: 'CSV coords',    color: 'magenta' },
}
const ACCEPTED = Object.keys(EXT_META).join(',')

function getExt(name: string) {
  const m = name.match(/(\.[^.]+)$/)
  return m ? m[1].toLowerCase() : ''
}
function stemName(name: string) {
  return name.replace(/(\.[^.]+)+$/, '')
}

export default function ImportGISModal({
  open, onClose, projectId, surveyArea, flatFolders, onImported,
}: Props) {
  const [form] = Form.useForm()
  const fileRef = useRef<File | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileExt, setFileExt] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  // Find the Shape Files subfolder under the survey area's root folder
  const shapeFilesFolder = surveyArea?.folder != null
    ? flatFolders.find(
        (f) => f.folder_type === 'SHAPEFILE' && f.parent === surveyArea.folder,
      )
    : null

  function handleClose() {
    if (loading) return
    fileRef.current = null
    setFileName('')
    setFileExt('')
    setResult(null)
    form.resetFields()
    onClose()
  }

  async function handleOk() {
    if (!fileRef.current) { message.warning('Please select a file first'); return }
    if (!shapeFilesFolder) {
      message.error('No Shape Files folder found for this area. Select the area on the map first.')
      return
    }
    let values: { layer_name: string; name_field?: string; geom_type?: string }
    try {
      values = await form.validateFields()
    } catch {
      return
    }

    const fd = new FormData()
    fd.append('file', fileRef.current)
    fd.append('layer_name', values.layer_name.trim())
    if (values.name_field?.trim()) fd.append('name_field', values.name_field.trim())
    if (values.geom_type) fd.append('geom_type', values.geom_type)

    if (fileExt === '.gpx' && Array.isArray(values.extra_attrs) && values.extra_attrs.length > 0) {
      const extraObj: Record<string, string> = {}
      for (const row of values.extra_attrs) {
        const k = row?.key?.trim()
        if (k) extraObj[k] = row.value ?? ''
      }
      if (Object.keys(extraObj).length > 0) {
        fd.append('extra_attributes', JSON.stringify(extraObj))
      }
    }

    setLoading(true)
    setResult(null)
    try {
      const r = await api.post(
        `/projects/folders/${shapeFilesFolder.id}/import-gis-file/`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      setResult(r.data)
      onImported()
    } catch (err: any) {
      const detail = err?.response?.data?.detail || 'Import failed'
      message.error(detail)
    } finally {
      setLoading(false)
    }
  }

  const extMeta = EXT_META[fileExt] ?? null

  return (
    <Modal
      title={
        <Space>
          <InboxOutlined style={{ color: '#4fc3f7' }} />
          <span>Import GIS File</span>
          {surveyArea && (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              — {surveyArea.name}
            </Text>
          )}
        </Space>
      }
      open={open}
      onCancel={handleClose}
      footer={
        result
          ? [
              <Button key="close" onClick={handleClose}>Close</Button>,
              <Button
                key="another"
                onClick={() => {
                  setResult(null)
                  fileRef.current = null
                  setFileName('')
                  setFileExt('')
                  form.resetFields()
                }}
              >
                Import Another
              </Button>,
            ]
          : [
              <Button key="cancel" onClick={handleClose} disabled={loading}>Cancel</Button>,
              <Button
                key="ok"
                type="primary"
                loading={loading}
                disabled={!fileRef.current || !shapeFilesFolder}
                onClick={handleOk}
                icon={<InboxOutlined />}
              >
                Import Features
              </Button>,
            ]
      }
      width={500}
    >
      {/* No area / no folder warning */}
      {!surveyArea && (
        <Alert
          type="warning"
          showIcon
          message="No survey area selected"
          description="Select a survey area on the map before importing."
          style={{ marginBottom: 16 }}
        />
      )}
      {surveyArea && !shapeFilesFolder && (
        <Alert
          type="info"
          showIcon
          message="Folder tree not ready"
          description="The area's folder structure is being created. Please wait a moment and try again."
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Success result */}
      {result && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert
            type={result.errors.length === 0 ? 'success' : 'warning'}
            showIcon
            icon={result.errors.length === 0 ? <CheckCircleOutlined /> : <WarningOutlined />}
            message={
              result.errors.length === 0
                ? `Imported ${result.created} feature(s) successfully`
                : `Imported ${result.created} feature(s) with ${result.errors.length} error(s)`
            }
            description={`Saved to "${shapeFilesFolder?.name ?? 'Shape Files'}" in ${surveyArea?.name}`}
          />
          {result.errors.length > 0 && (
            <Collapse
              ghost
              size="small"
              items={[{
                key: 'errs',
                label: (
                  <Text style={{ fontSize: 12, color: '#faad14' }}>
                    <CloseCircleOutlined style={{ marginRight: 4 }} />
                    {result.errors.length} row(s) skipped — click to view
                  </Text>
                ),
                children: (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#ff7875' }}>
                    {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                ),
              }]}
            />
          )}
        </Space>
      )}

      {/* Upload form */}
      {!result && (
        <Form form={form} layout="vertical" size="middle" style={{ marginTop: 4 }}>

          {/* Drop zone */}
          <Form.Item style={{ marginBottom: 12 }}>
            <Dragger
              accept={ACCEPTED}
              multiple={false}
              showUploadList={false}
              beforeUpload={(file) => {
                const ext = getExt(file.name)
                if (!EXT_META[ext]) {
                  message.error(`Unsupported format "${ext}". Accepted: .zip .geojson .json .kml .gpkg .gpx .csv`)
                  return Upload.LIST_IGNORE
                }
                fileRef.current = file
                setFileName(file.name)
                setFileExt(ext)
                form.setFieldValue('layer_name', stemName(file.name))
                return false
              }}
              style={{ background: 'rgba(79,195,247,0.04)', borderColor: '#4fc3f744' }}
            >
              {fileName ? (
                <Space direction="vertical" size={4} style={{ padding: '8px 0' }}>
                  <FileZipOutlined style={{ fontSize: 28, color: '#4fc3f7' }} />
                  <Text style={{ color: '#e0e0e0', fontWeight: 600 }}>{fileName}</Text>
                  {extMeta && (
                    <Tag color={extMeta.color} style={{ fontSize: 11 }}>{extMeta.label}</Tag>
                  )}
                  <Text
                    type="secondary"
                    style={{ fontSize: 11, cursor: 'pointer', color: '#888' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      fileRef.current = null
                      setFileName('')
                      setFileExt('')
                      form.setFieldValue('layer_name', '')
                    }}
                  >
                    × Remove
                  </Text>
                </Space>
              ) : (
                <Space direction="vertical" size={4} style={{ padding: '8px 0' }}>
                  <InboxOutlined style={{ fontSize: 28, color: '#4fc3f7' }} />
                  <Text style={{ color: '#aaa' }}>Click or drag file here</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    .zip (Shapefile) · .geojson · .kml · .gpkg · .gpx · .csv
                  </Text>
                </Space>
              )}
            </Dragger>
          </Form.Item>

          {/* Layer name */}
          <Form.Item
            label="Layer Name"
            name="layer_name"
            rules={[{ required: true, message: 'Layer name is required' }]}
            tooltip="Features will be imported under this layer name"
          >
            <Input placeholder="e.g. Survey Boundary, Phase 1 Roads" />
          </Form.Item>

          {/* Target Geometry Type (only for GPX or CSV) */}
          {(fileExt === '.gpx' || fileExt === '.csv') && (
            <Form.Item
              label="Target Geometry Type"
              name="geom_type"
              initialValue="auto"
              tooltip="Choose how coordinate datasets should be imported and rendered on the map"
            >
              <Select
                options={[
                  { value: 'auto', label: 'Auto (Waypoints/Rows -> Points, Tracks -> Lines)' },
                  { value: 'point', label: 'Points (Individual locations)' },
                  { value: 'line', label: 'Line (Single path)' },
                  { value: 'polygon', label: 'Polygon (Closed boundary)' },
                ]}
              />
            </Form.Item>
          )}

          {/* Surveyor-defined attributes (GPX only) */}
          {fileExt === '.gpx' && (
            <Form.Item
              label="Feature Attributes (optional)"
              tooltip="Key–value pairs added to every imported feature. Useful for tagging survey type, officer name, date, etc."
              style={{ marginBottom: 8 }}
            >
              <Form.List name="extra_attrs">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name, ...restField }) => (
                      <Space key={key} style={{ display: 'flex', marginBottom: 4 }} align="baseline">
                        <Form.Item
                          {...restField}
                          name={[name, 'key']}
                          rules={[{ required: true, message: 'Key required' }]}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder="key (e.g. survey_type)" style={{ width: 160 }} />
                        </Form.Item>
                        <Form.Item
                          {...restField}
                          name={[name, 'value']}
                          style={{ marginBottom: 0 }}
                        >
                          <Input placeholder="value (e.g. boundary)" style={{ width: 180 }} />
                        </Form.Item>
                        <MinusCircleOutlined
                          onClick={() => remove(name)}
                          style={{ color: '#ff4d4f', cursor: 'pointer' }}
                        />
                      </Space>
                    ))}
                    <Button
                      type="dashed"
                      onClick={() => add()}
                      icon={<PlusOutlined />}
                      size="small"
                      block
                      style={{ marginTop: 4 }}
                    >
                      Add attribute
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          )}

          {/* Name field */}
          <Form.Item
            label="Feature ID Attribute (optional)"
            name="name_field"
            tooltip="Attribute field whose value becomes the feature label (e.g. 'name', 'id', 'plot_no')"
            style={{ marginBottom: 0 }}
          >
            <Input placeholder="e.g. name, plot_no (leave blank to skip)" />
          </Form.Item>

          {/* Target info */}
          {shapeFilesFolder && surveyArea && (
            <div style={{
              marginTop: 12, padding: '6px 10px', borderRadius: 4,
              background: 'rgba(82,196,26,0.08)', border: '1px solid rgba(82,196,26,0.3)',
              fontSize: 11, color: '#95de64', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <GlobalOutlined />
              <span>Target: <strong>{surveyArea.name}</strong> › Shape Files</span>
            </div>
          )}
        </Form>
      )}
    </Modal>
  )
}
