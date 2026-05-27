import { useState } from 'react'
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Typography } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { MasterState, MasterDistrict, MasterTaluk, MasterVillage } from '@/types'

const { Title } = Typography

export default function VillageMasterPage() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MasterVillage | null>(null)
  const [filterTaluk, setFilterTaluk] = useState<number | undefined>()
  const [formState, setFormState] = useState<number | undefined>()
  const [formDistrict, setFormDistrict] = useState<number | undefined>()
  const [form] = Form.useForm()

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

  const { data: taluks = [] } = useQuery<MasterTaluk[]>({
    queryKey: ['master-taluks-form', formDistrict],
    queryFn: async () => {
      if (!formDistrict) return []
      const res = await api.get(`/gis/taluks/?district=${formDistrict}&page_size=1000`)
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
    enabled: !!formDistrict,
  })

  const { data: villages = [], isLoading } = useQuery<MasterVillage[]>({
    queryKey: ['master-villages', filterTaluk],
    queryFn: async () => {
      const params = filterTaluk ? `?taluk=${filterTaluk}&page_size=1000` : '?page_size=1000'
      const res = await api.get(`/gis/villages/${params}`)
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })

  const save = useMutation({
    mutationFn: (values: Partial<MasterVillage>) =>
      editing ? api.patch(`/gis/villages/${editing.id}/`, values) : api.post('/gis/villages/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-villages'] })
      message.success(editing ? 'Village updated' : 'Village created')
      setModalOpen(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Save failed'),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/gis/villages/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['master-villages'] }); message.success('Deleted') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setFormState(undefined)
    setFormDistrict(undefined)
    setModalOpen(true)
  }

  function openEdit(row: MasterVillage) {
    setEditing(row)
    form.setFieldsValue(row)
    setModalOpen(true)
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: 'Name', dataIndex: 'name', sorter: (a: MasterVillage, b: MasterVillage) => a.name.localeCompare(b.name) },
    { title: 'Code', dataIndex: 'code', width: 140 },
    { title: 'Taluk', dataIndex: 'taluk_name' },
    {
      title: 'Actions',
      width: 120,
      render: (_: any, row: MasterVillage) => (
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
        <Title level={4} style={{ margin: 0 }}>Villages</Title>
        <Space>
          <Select
            allowClear
            placeholder="Filter by Taluk"
            style={{ width: 200 }}
            options={taluks.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(v) => setFilterTaluk(v)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add Village</Button>
        </Space>
      </div>
      <Table rowKey="id" columns={columns} dataSource={villages} loading={isLoading} size="small" pagination={{ pageSize: 20 }} />
      <Modal
        title={editing ? 'Edit Village' : 'Add Village'}
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
              onChange={(v) => { setFormState(v); setFormDistrict(undefined); form.setFieldsValue({ district: undefined, taluk: undefined }) }}
              placeholder="Select state"
              showSearch optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item label="District (for filter)">
            <Select
              allowClear
              options={districts.map((d) => ({ value: d.id, label: d.name }))}
              onChange={(v) => { setFormDistrict(v); form.setFieldValue('taluk', undefined) }}
              placeholder="Select district"
              disabled={!formState}
              showSearch optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="taluk" label="Taluk" rules={[{ required: true }]}>
            <Select
              options={taluks.map((t) => ({ value: t.id, label: t.name }))}
              placeholder="Select taluk"
              disabled={!formDistrict}
              showSearch optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="code" label="Code" rules={[{ required: true }, { max: 20 }]}>
            <Input maxLength={20} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
