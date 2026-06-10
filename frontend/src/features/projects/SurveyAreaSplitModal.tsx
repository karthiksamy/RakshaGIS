import { useState } from 'react'
import {
  Modal, Form, Input, Select, Alert, Checkbox, Table, Tag, message,
  Typography, Space, Divider, InputNumber,
} from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { SurveyArea } from '@/types'

const { Text } = Typography

const OPERATIONS = [
  {
    value: 'SPLIT',
    label: 'Split',
    desc: 'Divide this area. Selected features move to a new peer survey area. Source area retains remaining features.',
  },
  {
    value: 'POCKET',
    label: 'Create Pocket (sub-area)',
    desc: 'Extract a sub-region as a child pocket. Useful when part of a large area is a non-contiguous parcel.',
  },
  {
    value: 'TRANSFER',
    label: 'Physical Transfer',
    desc: 'Transfer features to a new area representing land physically handed over to another service/unit. Works on APPROVED/PUBLISHED areas. Source area status is unchanged.',
    requiresReason: true,
  },
]

interface Feature {
  id: number
  layer_name: string
  geometry_type: string
  feature_id: string
  attributes: Record<string, unknown>
}

interface Props {
  area: SurveyArea
  open: boolean
  onClose: () => void
  onSuccess: (newAreaName: string) => void
}

export default function SurveyAreaSplitModal({ area, open, onClose, onSuccess }: Props) {
  const [form] = Form.useForm()
  const qc = useQueryClient()
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [operation, setOperation] = useState<string>('SPLIT')

  const opInfo = OPERATIONS.find(o => o.value === operation)

  // Fetch live features for selection
  const { data: featuresData, isLoading } = useQuery({
    queryKey: ['area-features-split', area.id],
    queryFn: () => api.get(`/projects/survey-areas/${area.id}/features/?limit=5000`).then(r => r.data),
    enabled: open,
  })

  const features: Feature[] = (featuresData?.features ?? []).map((f: any) => ({
    id: f.id ?? f.properties?.id,
    layer_name: f.properties?.layer_name ?? '',
    geometry_type: f.geometry?.type ?? '',
    feature_id: f.properties?.feature_id ?? '',
    attributes: f.properties ?? {},
  })).filter((f: Feature) => f.id != null)

  const mutation = useMutation({
    mutationFn: (values: any) =>
      api.post(`/projects/survey-areas/${area.id}/split/`, {
        new_area_name: values.new_area_name,
        new_area_code: values.new_area_code || '',
        feature_ids:   selectedIds,
        operation:     values.operation,
        reason:        values.reason || '',
        notes:         values.notes || '',
      }),
    onSuccess: (resp) => {
      const newName = resp.data.new_area?.name ?? ''
      qc.invalidateQueries({ queryKey: ['survey-areas-list'] })
      qc.invalidateQueries({ queryKey: ['area-lineage', area.id] })
      qc.invalidateQueries({ queryKey: ['area-snapshots', area.id] })
      message.success(`${selectedIds.length} feature(s) transferred to "${newName}"`)
      setSelectedIds([])
      form.resetFields()
      onSuccess(newName)
    },
    onError: (e: any) => {
      message.error(e?.response?.data?.detail || 'Split operation failed')
    },
  })

  const handleOk = async () => {
    if (selectedIds.length === 0) {
      message.warning('Select at least one feature to transfer')
      return
    }
    const values = await form.validateFields()
    mutation.mutate(values)
  }

  const cols = [
    { title: 'Layer', dataIndex: 'layer_name', key: 'ln', width: 140 },
    { title: 'Type', dataIndex: 'geometry_type', key: 'gt', width: 80,
      render: (v: string) => <Tag>{v}</Tag> },
    { title: 'Feature ID', dataIndex: 'feature_id', key: 'fid', width: 120,
      render: (v: string) => v || '—' },
  ]

  const isApprovedOrPublished = ['APPROVED', 'PUBLISHED'].includes(area.status)

  return (
    <Modal
      title={`Split / Pocket / Transfer — ${area.name}`}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={mutation.isPending}
      okText="Execute"
      width={720}
      styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
    >
      {isApprovedOrPublished && (
        <Alert
          type="warning"
          showIcon
          message={`This area is ${area.status_display}. A TRANSFER operation is recommended. The source area will NOT be de-published. The new area will start as DRAFT and go through the normal workflow.`}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form form={form} layout="vertical" initialValues={{ operation: 'SPLIT' }}>
        <Form.Item name="operation" label="Operation" rules={[{ required: true }]}>
          <Select
            options={OPERATIONS.map(o => ({ value: o.value, label: o.label }))}
            onChange={v => { setOperation(v); form.setFieldValue('operation', v) }}
          />
        </Form.Item>
        {opInfo && (
          <div style={{ fontSize: 12, color: '#888', marginTop: -12, marginBottom: 12 }}>
            {opInfo.desc}
          </div>
        )}

        <Form.Item
          name="new_area_name"
          label="New Area Name"
          rules={[{ required: true, message: 'Enter a name for the new area' }]}
        >
          <Input placeholder={`e.g. ${area.name} — South Pocket`} />
        </Form.Item>

        <Form.Item name="new_area_code" label="Area Code (optional)">
          <Input placeholder="e.g. SP-001" />
        </Form.Item>

        {operation === 'TRANSFER' && (
          <Form.Item
            name="reason"
            label="Reason for Transfer"
            rules={[{ required: true, message: 'Reason is required for TRANSFER' }]}
          >
            <Input.TextArea
              rows={2}
              placeholder="e.g. Land physically transferred to Air Force Station per Govt. order No. 1234/2026"
            />
          </Form.Item>
        )}

        <Form.Item name="notes" label="Notes (optional)">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>

      <Divider style={{ margin: '8px 0' }} />

      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 12 }}>
          Select features to transfer to the new area
          <Text style={{ color: '#4fc3f7', marginLeft: 8 }}>({selectedIds.length} selected)</Text>
        </Text>
        <Space>
          <Text
            style={{ fontSize: 11, color: '#888', cursor: 'pointer' }}
            onClick={() => setSelectedIds(features.map(f => f.id))}
          >
            Select all
          </Text>
          <Text style={{ fontSize: 11, color: '#888' }}>·</Text>
          <Text
            style={{ fontSize: 11, color: '#888', cursor: 'pointer' }}
            onClick={() => setSelectedIds([])}
          >
            Clear
          </Text>
        </Space>
      </div>

      <Table
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: keys => setSelectedIds(keys as number[]),
        }}
        dataSource={features}
        columns={cols}
        rowKey="id"
        size="small"
        loading={isLoading}
        pagination={{ pageSize: 10, size: 'small' }}
        scroll={{ y: 240 }}
        locale={{ emptyText: 'No features — make sure the area has active features loaded.' }}
      />
    </Modal>
  )
}
