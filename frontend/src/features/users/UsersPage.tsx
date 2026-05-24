import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Space, Typography, Modal, Form, Input,
  Select, Switch, message,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { User } from '@/types'

export default function UsersPage() {
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: qk.users(),
    queryFn: () => api.get('/accounts/users/').then((r) => r.data),
  })

  const { data: orgs } = useQuery({
    queryKey: qk.organisations(),
    queryFn: () => api.get('/accounts/organisations/').then((r) => r.data.results ?? r.data),
  })

  const createMutation = useMutation({
    mutationFn: (values: any) => api.post('/accounts/users/', values).then((r) => r.data),
    onSuccess: () => {
      message.success('User created')
      qc.invalidateQueries({ queryKey: qk.users() })
      setModalOpen(false)
      form.resetFields()
    },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Failed to create user'),
  })

  const columns: ColumnsType<User> = [
    { title: 'Username', dataIndex: 'username' },
    { title: 'Full Name', dataIndex: 'full_name' },
    { title: 'Email', dataIndex: 'email', responsive: ['md'] },
    { title: 'Role', dataIndex: 'role', render: (r) => <Tag>{r}</Tag> },
    { title: 'Organisation', dataIndex: 'organisation_name', responsive: ['lg'] },
    {
      title: 'Active',
      dataIndex: 'is_active',
      render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? 'Active' : 'Inactive'}</Tag>,
    },
  ]

  const ROLE_OPTIONS = user?.role === 'SUPERADMIN'
    ? ['PDDE_VIEWER', 'VIEWER', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN', 'SDO', 'SURVEYOR', 'CHECKER', 'APPROVER']
    : ['SDO', 'SURVEYOR', 'CHECKER', 'APPROVER', 'VIEWER']

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>
          Users
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          Add User
        </Button>
      </div>

      <Table
        dataSource={data?.results}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
      />

      <Modal
        title="Create User"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
      >
        <Form form={form} layout="vertical" onFinish={createMutation.mutate}>
          <Form.Item name="username" label="Username" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="full_name" label="Full Name">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input type="email" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true }]}>
            <Select options={ROLE_OPTIONS.map((r) => ({ label: r, value: r }))} />
          </Form.Item>
          <Form.Item name="organisation" label="Organisation" rules={[{ required: true }]}>
            <Select
              options={orgs?.map((o: any) => ({ label: o.name, value: o.id }))}
              showSearch
              filterOption={(input, option) =>
                String(option?.label).toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
