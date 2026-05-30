/**
 * NewLayerModal — QGIS-style "Create New Layer" dialog.
 *
 * User picks:
 *   1. Layer name
 *   2. Geometry type (Point / Line / Polygon)
 *   3. Target survey area (existing DRAFT/RETURNED  OR  create new)
 *   4. Attribute schema (optional, collapsible)
 *
 * On confirm → POST /api/projects/{pid}/new-layer/ → navigate to Map
 * with URL params that auto-activate the draw tool for that layer.
 */
import { useState } from 'react'
import {
  Modal, Form, Input, Radio, Select, Button, Space, Typography,
  Divider, message, Collapse, Table, Popconfirm,
} from 'antd'
import {
  EnvironmentFilled, NodeIndexOutlined, AreaChartOutlined,
  AimOutlined, PlusOutlined, DeleteOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { useAppStore } from '@/app/store'
import type { SurveyArea } from '@/types'

const { Text } = Typography
const { Option } = Select

interface Props {
  open: boolean
  onClose: () => void
  projectId: number
  surveyAreas: SurveyArea[]
}

interface FieldDef {
  key: string
  name: string
  type: 'string' | 'integer' | 'decimal' | 'date' | 'boolean' | 'choice'
  label: string
  required: boolean
}

const GEOM_OPTIONS = [
  {
    value: 'POINT',
    label: 'Point',
    icon: <AimOutlined style={{ fontSize: 18 }} />,
    desc: 'Single coordinate locations (wells, towers, markers)',
  },
  {
    value: 'LINE',
    label: 'Line',
    icon: <NodeIndexOutlined style={{ fontSize: 18 }} />,
    desc: 'Linear features (roads, fences, pipelines)',
  },
  {
    value: 'POLYGON',
    label: 'Polygon',
    icon: <AreaChartOutlined style={{ fontSize: 18 }} />,
    desc: 'Closed areas (parcels, buildings, zones)',
  },
]

const FIELD_TYPES = ['string', 'integer', 'decimal', 'date', 'boolean', 'choice']

export default function NewLayerModal({ open, onClose, projectId, surveyAreas }: Props) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { setSelectedProjectId } = useAppStore()
  const [form] = Form.useForm()

  const [areaMode, setAreaMode] = useState<'existing' | 'new'>('existing')
  const [geomType, setGeomType] = useState<'POINT' | 'LINE' | 'POLYGON'>('POLYGON')
  const [fields, setFields] = useState<FieldDef[]>([])
  const [newField, setNewField] = useState<Partial<FieldDef>>({ type: 'string', required: false })

  const editableAreas = surveyAreas.filter(
    (a) => a.status === 'DRAFT' || a.status === 'RETURNED',
  )

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post(`/projects/${projectId}/new-layer/`, body).then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['surveyAreas', projectId] })
      qc.invalidateQueries({ queryKey: ['folders', projectId] })
      message.success(`Layer "${data.layer_name}" created — opening map in draw mode`)
      onClose()
      form.resetFields()
      setFields([])
      setAreaMode('existing')
      setGeomType('POLYGON')
      // Navigate to map with deep-link params
      setSelectedProjectId(projectId)
      const tool =
        data.geometry_type === 'POINT' ? 'draw_point'
        : data.geometry_type === 'LINE' ? 'draw_line'
        : 'draw_polygon'
      navigate(
        `/map?area=${data.survey_area_id}&layer=${encodeURIComponent(data.layer_name)}&geomtype=${data.geometry_type}&folder=${data.folder_id}&tool=${tool}`,
      )
    },
    onError: (e: any) =>
      message.error(e?.response?.data?.detail || 'Failed to create layer'),
  })

  const handleOk = () => {
    form
      .validateFields()
      .then((values) => {
        const body: Record<string, unknown> = {
          layer_name: values.layer_name,
          geometry_type: geomType,
          fields: fields.length ? fields : undefined,
        }
        if (areaMode === 'existing') {
          body.survey_area_id = values.survey_area_id
        } else {
          body.new_area_name = values.new_area_name
          body.new_area_code = values.new_area_code || ''
        }
        createMutation.mutate(body)
      })
      .catch(() => {})
  }

  const addField = () => {
    if (!newField.name?.trim()) { message.warning('Enter a field name'); return }
    const key = Date.now().toString()
    setFields((prev) => [
      ...prev,
      {
        key,
        name: newField.name!.trim(),
        type: newField.type as FieldDef['type'] || 'string',
        label: newField.label?.trim() || newField.name!.trim(),
        required: newField.required ?? false,
      },
    ])
    setNewField({ type: 'string', required: false })
  }

  const removeField = (key: string) =>
    setFields((prev) => prev.filter((f) => f.key !== key))

  return (
    <Modal
      title={
        <Space>
          <EnvironmentFilled style={{ color: '#4fc3f7' }} />
          <span>Create New Shapefile Layer</span>
        </Space>
      }
      open={open}
      onCancel={() => { onClose(); form.resetFields(); setFields([]); setAreaMode('existing') }}
      onOk={handleOk}
      okText="Create Layer & Open Map"
      confirmLoading={createMutation.isPending}
      width={540}
      okButtonProps={{ size: 'middle', type: 'primary' }}
    >
      <Form form={form} layout="vertical" size="middle" style={{ marginTop: 12 }}>

        {/* ── Layer Name ── */}
        <Form.Item
          label="Layer Name"
          name="layer_name"
          rules={[
            { required: true, message: 'Layer name is required' },
            { max: 200, message: 'Max 200 characters' },
          ]}
          tooltip="A descriptive name for this layer, e.g. 'Survey Boundary' or 'Roads Phase 1'"
        >
          <Input placeholder="e.g. Survey Boundary, Phase 1 Roads" autoFocus />
        </Form.Item>

        {/* ── Geometry Type ── */}
        <Form.Item label="Geometry Type" required>
          <Space size={8} wrap>
            {GEOM_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                onClick={() => setGeomType(opt.value as typeof geomType)}
                style={{
                  border: `2px solid ${geomType === opt.value ? '#4fc3f7' : 'var(--border-color)'}`,
                  borderRadius: 8,
                  padding: '10px 16px',
                  cursor: 'pointer',
                  textAlign: 'center',
                  minWidth: 120,
                  background: geomType === opt.value ? 'rgba(79,195,247,0.1)' : 'transparent',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ color: geomType === opt.value ? '#4fc3f7' : 'var(--text-secondary)' }}>
                  {opt.icon}
                </div>
                <div style={{ fontWeight: 600, marginTop: 4, fontSize: 13 }}>{opt.label}</div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{opt.desc}</div>
              </div>
            ))}
          </Space>
        </Form.Item>

        {/* ── Survey Area ── */}
        <Divider style={{ margin: '8px 0' }} />
        <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 13 }}>
          Survey Area
          <Text type="secondary" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
            — features will be saved inside this area's folder
          </Text>
        </div>

        <Radio.Group
          value={areaMode}
          onChange={(e) => setAreaMode(e.target.value)}
          style={{ marginBottom: 12 }}
        >
          <Radio value="existing">Use Existing Area</Radio>
          <Radio value="new">Create New Area</Radio>
        </Radio.Group>

        {areaMode === 'existing' && (
          <Form.Item
            name="survey_area_id"
            rules={[{ required: true, message: 'Select a survey area' }]}
          >
            <Select
              placeholder={
                editableAreas.length === 0
                  ? 'No editable areas — switch to "Create New"'
                  : 'Select survey area…'
              }
              disabled={editableAreas.length === 0}
              showSearch
              optionFilterProp="label"
              options={editableAreas.map((a) => ({
                value: a.id,
                label: `${a.name}${a.area_code ? ` (${a.area_code})` : ''} — ${a.status}`,
              }))}
            />
            {editableAreas.length === 0 && surveyAreas.length > 0 && (
              <Text type="warning" style={{ fontSize: 11 }}>
                All areas are submitted/approved (locked). Create a new area instead.
              </Text>
            )}
          </Form.Item>
        )}

        {areaMode === 'new' && (
          <Space direction="vertical" style={{ width: '100%' }} size={0}>
            <Form.Item
              name="new_area_name"
              rules={[{ required: true, message: 'Area name is required' }]}
              style={{ marginBottom: 8 }}
            >
              <Input placeholder="Survey Area Name (e.g. Block A, Sector 3)" />
            </Form.Item>
            <Form.Item name="new_area_code" style={{ marginBottom: 0 }}>
              <Input placeholder="Short code (optional, e.g. BLK-A)" maxLength={50} />
            </Form.Item>
          </Space>
        )}

        {/* ── Attribute Fields (optional) ── */}
        <Divider style={{ margin: '12px 0 8px' }} />
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'attrs',
              label: (
                <Text style={{ fontSize: 12, fontWeight: 600 }}>
                  Attribute Fields (optional) — define columns for this layer
                </Text>
              ),
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  {fields.length > 0 && (
                    <Table
                      size="small"
                      pagination={false}
                      dataSource={fields}
                      rowKey="key"
                      columns={[
                        { title: 'Name', dataIndex: 'name', key: 'name' },
                        { title: 'Type', dataIndex: 'type', key: 'type' },
                        { title: 'Label', dataIndex: 'label', key: 'label' },
                        {
                          title: 'Req.',
                          dataIndex: 'required',
                          key: 'required',
                          render: (v: boolean) => v ? '✓' : '–',
                        },
                        {
                          title: '',
                          key: 'del',
                          render: (_: unknown, row: FieldDef) => (
                            <Popconfirm title="Remove field?" onConfirm={() => removeField(row.key)}>
                              <Button type="text" danger size="small" icon={<DeleteOutlined />} />
                            </Popconfirm>
                          ),
                        },
                      ]}
                    />
                  )}

                  {/* Add-field row */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Input
                      size="small"
                      placeholder="Field name"
                      style={{ width: 130 }}
                      value={newField.name || ''}
                      onChange={(e) => setNewField((p) => ({ ...p, name: e.target.value }))}
                    />
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={newField.type || 'string'}
                      onChange={(v) => setNewField((p) => ({ ...p, type: v }))}
                    >
                      {FIELD_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
                    </Select>
                    <Input
                      size="small"
                      placeholder="Label"
                      style={{ width: 120 }}
                      value={newField.label || ''}
                      onChange={(e) => setNewField((p) => ({ ...p, label: e.target.value }))}
                    />
                    <Select
                      size="small"
                      style={{ width: 80 }}
                      value={newField.required ? 'yes' : 'no'}
                      onChange={(v) => setNewField((p) => ({ ...p, required: v === 'yes' }))}
                    >
                      <Option value="no">Optional</Option>
                      <Option value="yes">Required</Option>
                    </Select>
                    <Button size="small" icon={<PlusOutlined />} onClick={addField}>
                      Add
                    </Button>
                  </div>
                </Space>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  )
}
