import { useState } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Typography } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { MasterState, MasterDistrict } from '@/types'

const { Title } = Typography

export default function DistrictMasterPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MasterDistrict | null>(null)
  const [filterState, setFilterState] = useState<number | undefined>()
  const [form] = Form.useForm()
  const formState = Form.useWatch('state', form)

  const { data: states = [] } = useQuery<MasterState[]>({
    queryKey: ['master-states'],
    queryFn: async () => {
      const res = await api.get('/gis/states/?page_size=1000')
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })

  const { data: districts = [], isLoading } = useQuery<MasterDistrict[]>({
    queryKey: ['master-districts', filterState],
    queryFn: async () => {
      const params = filterState ? `?state=${filterState}&page_size=1000` : '?page_size=1000'
      const res = await api.get(`/gis/districts/${params}`)
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })

  const save = useMutation({
    mutationFn: (values: Partial<MasterDistrict>) =>
      editing ? api.patch(`/gis/districts/${editing.id}/`, values) : api.post('/gis/districts/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-districts'] })
      message.success(editing ? 'District updated' : 'District created')
      setModalOpen(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Save failed'),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/gis/districts/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['master-districts'] }); message.success('Deleted') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(row: MasterDistrict) {
    setEditing(row)
    form.setFieldsValue(row)
    setModalOpen(true)
  }

  const stateOptions = states.map((s) => ({ value: s.id, label: s.name }))

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: 'Name', dataIndex: 'name', sorter: (a: MasterDistrict, b: MasterDistrict) => a.name.localeCompare(b.name) },
    { title: 'Code', dataIndex: 'code', width: 120 },
    { title: 'State', dataIndex: 'state_name' },
    {
      title: 'Actions',
      width: 120,
      render: (_: any, row: MasterDistrict) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title="Delete?" onConfirm={() => del.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Districts</Title>
        <Space>
          <Select
            allowClear
            placeholder="Filter by State"
            style={{ width: 200 }}
            options={stateOptions}
            onChange={(v) => setFilterState(v)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add District</Button>
        </Space>
      </div>
      <Table rowKey="id" columns={columns} dataSource={districts} loading={isLoading} size="small" pagination={{ pageSize: 20 }} />
      <Modal
        title={editing ? 'Edit District' : 'Add District'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="state" label="State" rules={[{ required: true }]}>
            <Select options={stateOptions} placeholder="Select state" showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="code" label="Code" rules={[{ required: true }, { max: 10 }]}>
            <Input maxLength={10} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
