import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Table, Tag, Modal, Form, Input, Select, Space, message,
  Popconfirm, Typography, Row, Col, Tabs, DatePicker, Drawer,
  Descriptions, Alert, Divider, Badge,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ToolOutlined,
  ExportOutlined, ImportOutlined, WarningOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

const { Title, Text } = Typography
const { TabPane } = Tabs

interface Equipment {
  id: number
  category: number
  category_name: string
  name: string
  make: string
  model: string
  serial_number: string
  asset_tag: string
  owned_by: number
  owned_by_name: string
  current_holder: number | null
  current_holder_name: string | null
  status: string
  status_display: string
  purchase_date: string | null
  warranty_expiry: string | null
  warranty_expired: boolean
  calibration_due: string | null
  calibration_overdue: boolean
  location_note: string
  notes: string
  active_issue: { id: number; issued_to: string; issued_date: string; expected_return_date: string | null } | null
  recent_maintenance: any[]
  created_by_name: string
}

interface EquipmentIssue {
  id: number
  equipment: number
  equipment_name: string
  issued_to: number
  issued_to_name: string
  issued_for_project: number | null
  project_name: string | null
  issued_date: string
  expected_return_date: string | null
  issued_by_name: string
  condition_at_issue: string
  actual_return_date: string | null
  is_outstanding: boolean
  condition_at_return: string
  remarks: string
}

const STATUS_COLOR: Record<string, string> = {
  AVAILABLE:   'green',
  ISSUED:      'blue',
  MAINTENANCE: 'orange',
  CONDEMNED:   'red',
}

export default function EquipmentPage() {
  const qc = useQueryClient()
  const user = useAppStore(s => s.user)
  const isAdmin = user && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)

  const [modalOpen, setModalOpen] = useState(false)
  const [issueModalOpen, setIssueModalOpen] = useState(false)
  const [returnModalOpen, setReturnModalOpen] = useState(false)
  const [maintenanceModalOpen, setMaintenanceModalOpen] = useState(false)
  const [selectedItem, setSelectedItem] = useState<Equipment | null>(null)
  const [editItem, setEditItem] = useState<Equipment | null>(null)
  const [detailItem, setDetailItem] = useState<Equipment | null>(null)
  const [form] = Form.useForm()
  const [issueForm] = Form.useForm()
  const [returnForm] = Form.useForm()
  const [maintenanceForm] = Form.useForm()

  const { data, isLoading } = useQuery<{ results: Equipment[] }>({
    queryKey: ['equipment'],
    queryFn: () => api.get('/field-ops/equipment/?page_size=500').then(r => r.data),
  })

  const { data: issuesData, isLoading: issuesLoading } = useQuery<{ results: EquipmentIssue[] }>({
    queryKey: ['equipment-issues'],
    queryFn: () => api.get('/field-ops/equipment-issues/?page_size=500').then(r => r.data),
  })

  const { data: categoriesData } = useQuery<{ results: any[] }>({
    queryKey: ['equipment-categories'],
    queryFn: () => api.get('/field-ops/equipment-categories/?page_size=100').then(r => r.data),
  })

  const { data: usersData } = useQuery<{ results: any[] }>({
    queryKey: ['users-list'],
    queryFn: () => api.get('/accounts/users/?page_size=500').then(r => r.data),
  })

  const { data: projectsData } = useQuery<{ results: any[] }>({
    queryKey: ['projects-list'],
    queryFn: () => api.get('/projects/projects/?page_size=200').then(r => r.data),
  })

  const saveMutation = useMutation({
    mutationFn: (values: any) =>
      editItem
        ? api.patch(`/field-ops/equipment/${editItem.id}/`, values)
        : api.post('/field-ops/equipment/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['equipment'] })
      message.success(editItem ? 'Equipment updated' : 'Equipment added')
      setModalOpen(false)
      form.resetFields()
      setEditItem(null)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error saving'),
  })

  const issueMutation = useMutation({
    mutationFn: ({ id, values }: { id: number; values: any }) =>
      api.post(`/field-ops/equipment/${id}/issue/`, {
        ...values,
        expected_return_date: values.expected_return_date?.format('YYYY-MM-DD') ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['equipment'] })
      qc.invalidateQueries({ queryKey: ['equipment-issues'] })
      message.success('Equipment issued successfully')
      setIssueModalOpen(false)
      issueForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error issuing'),
  })

  const returnMutation = useMutation({
    mutationFn: ({ id, values }: { id: number; values: any }) =>
      api.post(`/field-ops/equipment/${id}/return/`, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['equipment'] })
      qc.invalidateQueries({ queryKey: ['equipment-issues'] })
      message.success('Equipment returned')
      setReturnModalOpen(false)
      returnForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error returning'),
  })

  const maintenanceMutation = useMutation({
    mutationFn: (values: any) => api.post('/field-ops/equipment-maintenance/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['equipment'] })
      message.success('Maintenance record saved')
      setMaintenanceModalOpen(false)
      maintenanceForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error saving maintenance'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/field-ops/equipment/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['equipment'] })
      message.success('Deleted')
    },
  })

  const equipment = data?.results ?? []
  const issues = issuesData?.results ?? []
  const categories = categoriesData?.results ?? []
  const users = usersData?.results ?? []
  const projects = projectsData?.results ?? []

  const overdueCalibration = equipment.filter(e => e.calibration_overdue && e.status !== 'CONDEMNED')
  const outstanding = issues.filter(i => i.is_outstanding)

  const columns = [
    {
      title: 'Equipment',
      key: 'name',
      render: (_: any, row: Equipment) => (
        <Space direction="vertical" size={0}>
          <Text strong>{row.name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {[row.make, row.model].filter(Boolean).join(' ')}
            {row.serial_number ? ` · S/N: ${row.serial_number}` : ''}
          </Text>
        </Space>
      ),
    },
    { title: 'Category', dataIndex: 'category_name', key: 'cat' },
    { title: 'Asset Tag', dataIndex: 'asset_tag', key: 'tag', render: (v: string) => v || '—' },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (v: string, row: Equipment) => (
        <Tag color={STATUS_COLOR[v] || 'default'}>{row.status_display}</Tag>
      ),
      filters: [
        { text: 'Available', value: 'AVAILABLE' },
        { text: 'Issued', value: 'ISSUED' },
        { text: 'Maintenance', value: 'MAINTENANCE' },
        { text: 'Condemned', value: 'CONDEMNED' },
      ],
      onFilter: (value: any, row: Equipment) => row.status === value,
    },
    {
      title: 'Holder / Location',
      key: 'holder',
      render: (_: any, row: Equipment) =>
        row.current_holder_name
          ? <Text type="warning">{row.current_holder_name}</Text>
          : <Text type="secondary">{row.location_note || 'In store'}</Text>,
    },
    {
      title: 'Calibration Due',
      dataIndex: 'calibration_due',
      key: 'cal',
      render: (v: string | null, row: Equipment) =>
        v ? (
          <Tag color={row.calibration_overdue ? 'red' : 'green'}>
            {row.calibration_overdue ? <WarningOutlined /> : <CheckCircleOutlined />}{' '}
            {dayjs(v).format('DD MMM YYYY')}
          </Tag>
        ) : '—',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, row: Equipment) => (
        <Space size="small" wrap>
          {isAdmin && row.status === 'AVAILABLE' && (
            <Button
              size="small"
              type="primary"
              icon={<ExportOutlined />}
              onClick={() => { setSelectedItem(row); issueForm.resetFields(); setIssueModalOpen(true) }}
            >
              Issue
            </Button>
          )}
          {isAdmin && row.status === 'ISSUED' && (
            <Button
              size="small"
              icon={<ImportOutlined />}
              onClick={() => { setSelectedItem(row); returnForm.resetFields(); setReturnModalOpen(true) }}
            >
              Return
            </Button>
          )}
          {isAdmin && (
            <Button
              size="small"
              icon={<ToolOutlined />}
              onClick={() => {
                setSelectedItem(row)
                maintenanceForm.setFieldsValue({ equipment: row.id })
                setMaintenanceModalOpen(true)
              }}
            />
          )}
          {isAdmin && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditItem(row)
                form.setFieldsValue({
                  ...row,
                  purchase_date: row.purchase_date ? dayjs(row.purchase_date) : null,
                  warranty_expiry: row.warranty_expiry ? dayjs(row.warranty_expiry) : null,
                  calibration_due: row.calibration_due ? dayjs(row.calibration_due) : null,
                })
                setModalOpen(true)
              }}
            />
          )}
          {isAdmin && (
            <Popconfirm title="Delete this equipment record?" onConfirm={() => deleteMutation.mutate(row.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  const issueColumns = [
    { title: 'Equipment', dataIndex: 'equipment_name', key: 'eq' },
    { title: 'Issued To', dataIndex: 'issued_to_name', key: 'to' },
    {
      title: 'Issued Date',
      dataIndex: 'issued_date',
      key: 'date',
      render: (v: string) => dayjs(v).format('DD MMM YYYY'),
    },
    {
      title: 'Expected Return',
      dataIndex: 'expected_return_date',
      key: 'ret',
      render: (v: string | null) => {
        if (!v) return '—'
        const overdue = dayjs(v).isBefore(dayjs(), 'day')
        return <Tag color={overdue ? 'red' : 'default'}>{dayjs(v).format('DD MMM YYYY')}</Tag>
      },
    },
    { title: 'Project', dataIndex: 'project_name', key: 'proj', render: (v: string | null) => v || '—' },
    {
      title: 'Status',
      key: 'status',
      render: (_: any, row: EquipmentIssue) =>
        row.is_outstanding
          ? <Badge status="processing" text="Outstanding" />
          : <Badge status="success" text={`Returned ${dayjs(row.actual_return_date!).format('DD MMM YYYY')}`} />,
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Title level={3} style={{ margin: 0 }}>
            <ToolOutlined style={{ marginRight: 8 }} />
            Survey Equipment Register
          </Title>
          <Text type="secondary">
            Inventory, issue/return, and maintenance tracking — all stored locally, no internet required
          </Text>
        </Col>
        {isAdmin && (
          <Col>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditItem(null); form.resetFields(); setModalOpen(true) }}>
              Add Equipment
            </Button>
          </Col>
        )}
      </Row>

      {overdueCalibration.length > 0 && (
        <Alert
          type="warning"
          style={{ marginBottom: 16 }}
          icon={<WarningOutlined />}
          showIcon
          message={`${overdueCalibration.length} equipment item(s) have overdue calibration`}
          description={overdueCalibration.map(e => e.name).join(', ')}
        />
      )}

      <Tabs defaultActiveKey="inventory">
        <TabPane tab={`Inventory (${equipment.length})`} key="inventory">
          <Table
            dataSource={equipment}
            columns={columns}
            rowKey="id"
            loading={isLoading}
            pagination={{ pageSize: 20 }}
          />
        </TabPane>
        <TabPane tab={`Outstanding Issues (${outstanding.length})`} key="outstanding">
          <Table
            dataSource={outstanding}
            columns={issueColumns}
            rowKey="id"
            loading={issuesLoading}
            pagination={{ pageSize: 20 }}
          />
        </TabPane>
        <TabPane tab="Full Issue History" key="history">
          <Table
            dataSource={issues}
            columns={issueColumns}
            rowKey="id"
            loading={issuesLoading}
            pagination={{ pageSize: 20 }}
          />
        </TabPane>
      </Tabs>

      {/* Add / Edit Equipment Modal */}
      <Modal
        open={modalOpen}
        title={editItem ? 'Edit Equipment' : 'Add Equipment to Register'}
        onCancel={() => { setModalOpen(false); form.resetFields(); setEditItem(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={680}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={values => saveMutation.mutate({
            ...values,
            purchase_date: values.purchase_date?.format('YYYY-MM-DD') ?? null,
            warranty_expiry: values.warranty_expiry?.format('YYYY-MM-DD') ?? null,
            calibration_due: values.calibration_due?.format('YYYY-MM-DD') ?? null,
          })}
        >
          <Row gutter={12}>
            <Col span={16}>
              <Form.Item name="name" label="Equipment Name" rules={[{ required: true }]}>
                <Input placeholder='e.g. "Leica TS16 Total Station Unit-2"' />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="category" label="Category" rules={[{ required: true }]}>
                <Select options={categories.map(c => ({ value: c.id, label: c.name }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="make" label="Make / Brand">
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="model" label="Model">
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="serial_number" label="Serial Number">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="asset_tag" label="Asset Tag">
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="purchase_date" label="Purchase Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="warranty_expiry" label="Warranty Expiry">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="calibration_due" label="Calibration Due Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_note" label="Storage Location">
                <Input placeholder="Room / almirah / shelf number" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Issue Modal */}
      <Modal
        open={issueModalOpen}
        title={`Issue: ${selectedItem?.name}`}
        onCancel={() => setIssueModalOpen(false)}
        onOk={() => issueForm.submit()}
        confirmLoading={issueMutation.isPending}
      >
        <Form
          form={issueForm}
          layout="vertical"
          onFinish={values => issueMutation.mutate({ id: selectedItem!.id, values })}
        >
          <Form.Item name="issued_to" label="Issue To (User)" rules={[{ required: true }]}>
            <Select
              showSearch
              filterOption={(inp, opt) => (opt?.label as string ?? '').toLowerCase().includes(inp.toLowerCase())}
              options={users.map(u => ({ value: u.id, label: u.full_name || u.username }))}
            />
          </Form.Item>
          <Form.Item name="issued_for_project" label="For Project (optional)">
            <Select
              allowClear
              showSearch
              filterOption={(inp, opt) => (opt?.label as string ?? '').toLowerCase().includes(inp.toLowerCase())}
              options={projects.map(p => ({ value: p.id, label: p.name }))}
            />
          </Form.Item>
          <Form.Item name="expected_return_date" label="Expected Return Date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="condition_at_issue" label="Condition at Issue" initialValue="GOOD">
            <Select options={[
              { value: 'GOOD', label: 'Good' },
              { value: 'FAIR', label: 'Fair / Minor wear' },
              { value: 'NEEDS_ATTENTION', label: 'Needs Attention' },
            ]} />
          </Form.Item>
          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Return Modal */}
      <Modal
        open={returnModalOpen}
        title={`Return: ${selectedItem?.name}`}
        onCancel={() => setReturnModalOpen(false)}
        onOk={() => returnForm.submit()}
        confirmLoading={returnMutation.isPending}
      >
        {selectedItem?.active_issue && (
          <Alert
            type="info"
            style={{ marginBottom: 16 }}
            message={`Currently issued to ${selectedItem.active_issue.issued_to} since ${dayjs(selectedItem.active_issue.issued_date).format('DD MMM YYYY')}`}
          />
        )}
        <Form
          form={returnForm}
          layout="vertical"
          onFinish={values => returnMutation.mutate({ id: selectedItem!.id, values })}
        >
          <Form.Item name="condition_at_return" label="Condition on Return" rules={[{ required: true }]}>
            <Select options={[
              { value: 'GOOD', label: 'Good' },
              { value: 'FAIR', label: 'Fair / Minor wear' },
              { value: 'DAMAGED', label: 'Damaged (will go to maintenance)' },
              { value: 'LOST', label: 'Lost' },
            ]} />
          </Form.Item>
          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Maintenance Modal */}
      <Modal
        open={maintenanceModalOpen}
        title={`Add Maintenance Record: ${selectedItem?.name}`}
        onCancel={() => setMaintenanceModalOpen(false)}
        onOk={() => maintenanceForm.submit()}
        confirmLoading={maintenanceMutation.isPending}
      >
        <Form
          form={maintenanceForm}
          layout="vertical"
          onFinish={values => maintenanceMutation.mutate({
            ...values,
            equipment: selectedItem?.id,
            maintenance_date: values.maintenance_date?.format('YYYY-MM-DD'),
            next_due_date: values.next_due_date?.format('YYYY-MM-DD') ?? null,
          })}
        >
          <Form.Item name="maintenance_type" label="Type" rules={[{ required: true }]}>
            <Select options={[
              { value: 'CALIBRATION', label: 'Calibration' },
              { value: 'REPAIR',      label: 'Repair' },
              { value: 'SERVICE',     label: 'Periodic Service' },
              { value: 'INSPECTION',  label: 'Inspection' },
            ]} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="maintenance_date" label="Date" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="next_due_date" label="Next Due Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="performed_by_name" label="Performed By" rules={[{ required: true }]}>
            <Input placeholder="Technician / vendor name" />
          </Form.Item>
          <Form.Item name="certificate_ref" label="Certificate / Report Reference">
            <Input />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
