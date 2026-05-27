import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Button, Tag, Space, Typography, Modal, Form, Input,
  Select, Popconfirm, message, Tooltip,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined,
  KeyOutlined, PoweroffOutlined, LogoutOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { User } from '@/types'
import { ADMIN_ROLES } from '@/types'

const ALL_ROLES = ['SUPERADMIN', 'PDDE_VIEWER', 'VIEWER', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN', 'SDO', 'SURVEYOR', 'CHECKER', 'APPROVER']
const ORG_ADMIN_ASSIGNABLE = ['SDO', 'SURVEYOR', 'CHECKER', 'APPROVER', 'VIEWER']

export default function UsersPage() {
  const qc = useQueryClient()
  const currentUser = useAppStore((s) => s.user)
  const isSuperAdmin = currentUser?.role === 'SUPERADMIN'

  const [userModalOpen, setUserModalOpen] = useState(false)
  const [pwdModalOpen, setPwdModalOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<User | null>(null)
  const [pwdTarget, setPwdTarget] = useState<User | null>(null)
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: qk.users(),
    queryFn: () => api.get('/accounts/users/').then((r) => r.data.results ?? r.data),
  })

  const { data: orgs = [] } = useQuery({
    queryKey: qk.organisations(),
    queryFn: () => api.get('/accounts/organisations/').then((r) => r.data.results ?? r.data),
  })

  const saveUser = useMutation({
    mutationFn: (values: any) =>
      editingUser
        ? api.patch(`/accounts/users/${editingUser.id}/`, values)
        : api.post('/accounts/users/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.users() })
      message.success(editingUser ? 'User updated' : 'User created')
      setUserModalOpen(false)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Save failed'),
  })

  const delUser = useMutation({
    mutationFn: (id: number) => api.delete(`/accounts/users/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.users() }); message.success('User deleted') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Delete failed'),
  })

  const forceLogout = useMutation({
    mutationFn: (id: number) => api.post(`/accounts/users/${id}/force-logout/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.users() }); message.success('User force-logged out') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed'),
  })

  const toggleActive = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/accounts/users/${id}/`, { is_active }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.users() }); message.success('Status updated') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed'),
  })

  const changePwd = useMutation({
    mutationFn: ({ id, new_password }: { id: number; new_password: string }) =>
      api.post(`/accounts/users/${id}/change-password/`, { new_password }),
    onSuccess: () => { message.success('Password changed'); setPwdModalOpen(false); pwdForm.resetFields() },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed'),
  })

  function isProtected(u: User) {
    return ADMIN_ROLES.includes(u.role)
  }

  function openCreate() {
    setEditingUser(null)
    form.resetFields()
    setUserModalOpen(true)
  }

  function openEdit(u: User) {
    setEditingUser(u)
    form.setFieldsValue(u)
    setUserModalOpen(true)
  }

  function openChangePwd(u: User) {
    setPwdTarget(u)
    pwdForm.resetFields()
    setPwdModalOpen(true)
  }

  const roleOptions = isSuperAdmin
    ? ALL_ROLES.map((r) => ({ value: r, label: r }))
    : ORG_ADMIN_ASSIGNABLE.map((r) => ({ value: r, label: r }))

  const columns: ColumnsType<User> = [
    { title: 'Username', dataIndex: 'username', width: 140 },
    { title: 'Full Name', dataIndex: 'full_name' },
    { title: 'Email', dataIndex: 'email', responsive: ['md'] },
    {
      title: 'Role',
      dataIndex: 'role',
      render: (r) => <Tag color={ADMIN_ROLES.includes(r) ? 'gold' : 'default'}>{r}</Tag>,
    },
    { title: 'Organisation', dataIndex: 'organisation_name', responsive: ['lg'] },
    {
      title: 'Active',
      dataIndex: 'is_active',
      render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? 'Active' : 'Inactive'}</Tag>,
    },
    {
      title: 'Actions',
      width: 200,
      render: (_: any, u: User) => {
        const protected_ = isProtected(u)
        const canAct = isSuperAdmin || !protected_
        return (
          <Space size={4}>
            <Tooltip title="Edit">
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(u)} />
            </Tooltip>
            <Tooltip title="Change Password">
              <Button size="small" icon={<KeyOutlined />} onClick={() => openChangePwd(u)} />
            </Tooltip>
            <Tooltip title={u.is_active ? 'Deactivate' : 'Activate'}>
              <Button
                size="small"
                icon={<PoweroffOutlined />}
                disabled={!canAct}
                onClick={() => toggleActive.mutate({ id: u.id, is_active: !u.is_active })}
              />
            </Tooltip>
            <Tooltip title="Force Logout">
              <Button
                size="small"
                icon={<LogoutOutlined />}
                disabled={!canAct}
                onClick={() => { if (canAct) forceLogout.mutate(u.id) }}
              />
            </Tooltip>
            <Popconfirm
              title="Delete this user?"
              disabled={!canAct}
              onConfirm={() => canAct && delUser.mutate(u.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} disabled={!canAct} />
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>Users</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Add User</Button>
      </div>

      <Table
        dataSource={data}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ pageSize: 25 }}
      />

      {/* Create / Edit modal */}
      <Modal
        title={editingUser ? 'Edit User' : 'Create User'}
        open={userModalOpen}
        onCancel={() => setUserModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saveUser.isPending}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={(v) => saveUser.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="username" label="Username" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="first_name" label="First Name">
            <Input />
          </Form.Item>
          <Form.Item name="last_name" label="Last Name">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input type="email" />
          </Form.Item>
          <Form.Item name="employee_id" label="Employee ID">
            <Input />
          </Form.Item>
          <Form.Item name="designation" label="Designation">
            <Input />
          </Form.Item>
          <Form.Item name="phone" label="Phone">
            <Input maxLength={15} />
          </Form.Item>
          {!editingUser && (
            <Form.Item name="password" label="Password" rules={[{ required: true }, { min: 8 }]}>
              <Input.Password />
            </Form.Item>
          )}
          <Form.Item name="role" label="Role" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item name="organisation" label="Organisation">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={orgs?.map((o: any) => ({ label: `${o.level} — ${o.name}`, value: o.id }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Change password modal */}
      <Modal
        title={`Change Password — ${pwdTarget?.full_name || pwdTarget?.username}`}
        open={pwdModalOpen}
        onCancel={() => setPwdModalOpen(false)}
        onOk={() => pwdForm.submit()}
        confirmLoading={changePwd.isPending}
      >
        <Form
          form={pwdForm}
          layout="vertical"
          onFinish={(v) => pwdTarget && changePwd.mutate({ id: pwdTarget.id, new_password: v.new_password })}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            name="new_password"
            label="New Password"
            rules={[{ required: true }, { min: 8, message: 'Minimum 8 characters' }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
