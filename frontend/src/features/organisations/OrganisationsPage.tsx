import { useState } from 'react'
import { Table, Tag, Typography, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Row, Col } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { Organisation, MasterState, MasterDistrict } from '@/types'
import { useAppStore } from '@/app/store'

const LEVEL_COLORS: Record<string, string> = {
  DGDE: 'purple', PDDE: 'blue', DEO: 'cyan', CEO: 'green', ADEO: 'orange',
}

const LEVEL_OPTIONS = [
  { value: 'DGDE', label: 'DGDE (National)' },
  { value: 'PDDE', label: 'PDDE (Command)' },
  { value: 'DEO', label: 'DEO (District/Area)' },
  { value: 'CEO', label: 'CEO (Cantonment)' },
  { value: 'ADEO', label: 'ADEO (Sub-Area)' },
]

export default function OrganisationsPage() {
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const isSuperAdmin = user?.role === 'SUPERADMIN'

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Organisation | null>(null)
  const [formState, setFormState] = useState<number | undefined>()
  const [form] = Form.useForm()

  const { data: orgs = [], isLoading } = useQuery<Organisation[]>({
    queryKey: qk.organisations(),
    queryFn: () => api.get('/accounts/organisations/').then((r) => r.data.results ?? r.data),
  })

  const { data: states = [] } = useQuery<MasterState[]>({
    queryKey: ['master-states'],
    queryFn: async () => {
      const res = await api.get('/gis/states/?page_size=1000')
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })

  const { data: districts = [] } = useQuery<MasterDistrict[]>({
    queryKey: ['master-districts', formState],
    queryFn: async () => {
      if (!formState) return []
      const res = await api.get(`/gis/districts/?state=${formState}&page_size=1000`)
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
    enabled: !!formState,
  })

  const save = useMutation({
    mutationFn: (values: Partial<Organisation>) =>
      editing ? api.patch(`/accounts/organisations/${editing.id}/`, values) : api.post('/accounts/organisations/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.organisations() })
      message.success(editing ? 'Organisation updated' : 'Organisation created')
      setModalOpen(false)
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail || JSON.stringify(e?.response?.data) || 'Save failed'
      message.error(detail)
    },
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/accounts/organisations/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.organisations() }); message.success('Deleted') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  function openCreate() {
    setEditing(null)
    setFormState(undefined)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(row: Organisation) {
    setEditing(row)
    setFormState(row.state ?? undefined)
    form.setFieldsValue(row)
    setModalOpen(true)
  }

  const columns: ColumnsType<Organisation> = [
    { title: 'Office ID', dataIndex: 'office_id', width: 100 },
    { title: 'Name', dataIndex: 'name' },
    {
      title: 'Level',
      dataIndex: 'level',
      render: (l) => <Tag color={LEVEL_COLORS[l] ?? 'default'}>{l}</Tag>,
    },
    { title: 'State', dataIndex: 'state_name' },
    { title: 'District', dataIndex: 'district_name' },
    { title: 'Officer', dataIndex: 'officer_name' },
    ...(isSuperAdmin
      ? [{
          title: 'Actions',
          width: 100,
          render: (_: any, row: Organisation) => (
            <Space>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
              <Popconfirm title="Delete this organisation?" onConfirm={() => del.mutate(row.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </Space>
          ),
        }]
      : []),
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ marginBottom: 0, color: '#e8e8e8' }}>
          Organisations
        </Typography.Title>
        {isSuperAdmin && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Organisation</Button>
        )}
      </div>
      <Table
        dataSource={orgs}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
      />

      <Modal
        title={editing ? 'Edit Organisation' : 'Add Organisation'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        width={700}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="office_id" label="Office ID (5 chars)" rules={[{ max: 5 }]}>
                <Input maxLength={5} style={{ textTransform: 'uppercase' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="code" label="Code" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={16}>
              <Form.Item name="name" label="Office Name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="level" label="Level" rules={[{ required: true }]}>
                <Select options={LEVEL_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="officer_name" label="Officer Name">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label="Email">
                <Input type="email" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="mobile" label="Mobile">
                <Input maxLength={15} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="landline" label="Landline">
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="state" label="State">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={states.map((s) => ({ value: s.id, label: s.name }))}
                  onChange={(v) => { setFormState(v); form.setFieldValue('district', undefined) }}
                  placeholder="Select state"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="district" label="District">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={districts.map((d) => ({ value: d.id, label: d.name }))}
                  placeholder={formState ? 'Select district' : 'Select state first'}
                  disabled={!formState}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="pincode" label="Pincode" rules={[{ max: 6 }]}>
                <Input maxLength={6} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="parent" label="Parent Organisation">
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={orgs.map((o) => ({ value: o.id, label: `${o.level} — ${o.name}` }))}
                  placeholder="Select parent (if any)"
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
