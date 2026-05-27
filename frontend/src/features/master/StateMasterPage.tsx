import { useState } from 'react'
import { Table, Button, Modal, Form, Input, Space, Popconfirm, message, Typography } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import type { MasterState } from '@/types'

const { Title } = Typography

function useStates() {
  return useQuery<MasterState[]>({
    queryKey: ['master-states'],
    queryFn: async () => {
      const res = await api.get('/gis/states/?page_size=1000')
      return res.data.results ?? res.data.features?.map((f: any) => ({ id: f.id, ...f.properties })) ?? []
    },
  })
}

export default function StateMasterPage() {
  const qc = useQueryClient()
  const { data = [], isLoading } = useStates()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<MasterState | null>(null)
  const [form] = Form.useForm()

  const save = useMutation({
    mutationFn: (values: Partial<MasterState>) =>
      editing
        ? api.patch(`/gis/states/${editing.id}/`, values)
        : api.post('/gis/states/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-states'] })
      message.success(editing ? 'State updated' : 'State created')
      setModalOpen(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Save failed'),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/gis/states/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master-states'] })
      message.success('State deleted')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(row: MasterState) {
    setEditing(row)
    form.setFieldsValue(row)
    setModalOpen(true)
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: 'Name', dataIndex: 'name', sorter: (a: MasterState, b: MasterState) => a.name.localeCompare(b.name) },
    { title: 'Code', dataIndex: 'code', width: 100 },
    {
      title: 'Actions',
      width: 120,
      render: (_: any, row: MasterState) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          <Popconfirm title="Delete this state?" onConfirm={() => del.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>States</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add State</Button>
      </div>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 20 }}
      />
      <Modal
        title={editing ? 'Edit State' : 'Add State'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="code"
            label="Code"
            rules={[{ required: true }, { max: 5, message: 'Max 5 characters' }]}
          >
            <Input maxLength={5} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
