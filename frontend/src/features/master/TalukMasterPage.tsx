import { useState } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Typography } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { MasterState, MasterDistrict, MasterTaluk } from '@/types'

const { Title } = Typography

export default function TalukMasterPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MasterTaluk | null>(null)
  const [filterDistrict, setFilterDistrict] = useState<number | undefined>()
  const [form] = Form.useForm()

  const { data: states = [] } = useQuery<MasterState[]>({
    queryKey: ['master-states'],
    queryFn: async () => {
      const res = await api.get('/gis/states/?page_size=1000')
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })

  const [selectedState, setSelectedState] = useState<number | undefined>()

  const { data: districts = [] } = useQuery<MasterDistrict[]>({
    queryKey: ['master-districts', selectedState],
    queryFn: async () => {
      if (!selectedState) return []
      const res = await api.get(`/gis/districts/?state=${selectedState}&page_size=1000`)
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
    enabled: !!selectedState,
  })

  const { data: taluks = [], isLoading } = useQuery<MasterTaluk[]>({
    queryKey: ['master-taluks', filterDistrict],
    queryFn: async () => {
      const params = filterDistrict ? `?district=${filterDistrict}&page_size=1000` : '?page_size=1000'
      const res = await api.get(`/gis/taluks/${params}`)
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })

  const save = useMutation({
    mutationFn: (values: Partial<MasterTaluk>) =>
      editing ? api.patch(`/gis/taluks/${editing.id}/`, values) : api.post('/gis/taluks/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-taluks'] })
      message.success(editing ? 'Taluk updated' : 'Taluk created')
      setModalOpen(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Save failed'),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/gis/taluks/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['master-taluks'] }); message.success('Deleted') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setSelectedState(undefined)
    setModalOpen(true)
  }

  function openEdit(row: MasterTaluk) {
    setEditing(row)
    form.setFieldsValue(row)
    setModalOpen(true)
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: 'Name', dataIndex: 'name', sorter: (a: MasterTaluk, b: MasterTaluk) => a.name.localeCompare(b.name) },
    { title: 'Code', dataIndex: 'code', width: 140 },
    { title: 'District', dataIndex: 'district_name' },
    {
      title: 'Actions',
      width: 120,
      render: (_: any, row: MasterTaluk) => (
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
        <Title level={4} style={{ margin: 0 }}>Taluks</Title>
        <Space>
          <Select
            allowClear
            placeholder="Filter by District"
            style={{ width: 200 }}
            options={districts.map((d) => ({ value: d.id, label: d.name }))}
            onChange={(v) => setFilterDistrict(v)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Taluk</Button>
        </Space>
      </div>
      <Table rowKey="id" columns={columns} dataSource={taluks} loading={isLoading} size="small" pagination={{ pageSize: 20 }} />
      <Modal
        title={editing ? 'Edit Taluk' : 'Add Taluk'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item label="State (for filter)">
            <Select
              allowClear
              options={states.map((s) => ({ value: s.id, label: s.name }))}
              onChange={(v) => { setSelectedState(v); form.setFieldValue('district', undefined) }}
              placeholder="Select state to filter districts"
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="district" label="District" rules={[{ required: true }]}>
            <Select
              options={districts.map((d) => ({ value: d.id, label: d.name }))}
              placeholder="Select district"
              showSearch
              optionFilterProp="label"
              disabled={!selectedState}
            />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="code" label="Code" rules={[{ required: true }, { max: 15 }]}>
            <Input maxLength={15} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
