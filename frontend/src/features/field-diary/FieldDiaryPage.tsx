import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Table, Tag, Modal, Form, Input, Select, Space, message,
  Typography, Row, Col, DatePicker, InputNumber, Drawer, Descriptions,
  Progress, Divider, Badge,
} from 'antd'
import {
  PlusOutlined, EditOutlined, CheckCircleOutlined, BookOutlined,
  SendOutlined, EyeOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

const { Title, Text } = Typography

interface DPR {
  id: number
  survey_area: number
  survey_area_name: string
  surveyor: number
  surveyor_name: string
  date: string
  weather: string
  weather_display: string
  station_points_set: number
  station_points_target: number
  work_description: string
  difficulties_faced: string
  next_day_plan: string
  remarks: string
  manpower_count: number
  photographs_taken: number
  progress_pct: number
  equipment_usage: any[]
  submitted_at: string | null
  is_submitted: boolean
  approved_by: number | null
  approved_by_name: string
  approved_at: string | null
  is_approved: boolean
  created_by_name: string
  created_at: string
}

const WEATHER_COLOR: Record<string, string> = {
  CLEAR: 'gold',
  PARTLY_CLOUDY: 'cyan',
  CLOUDY: 'blue',
  RAINY: 'geekblue',
  FOGGY: 'default',
  WINDY: 'purple',
}

export default function FieldDiaryPage() {
  const qc = useQueryClient()
  const user = useAppStore(s => s.user)
  const isAdmin = user && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)

  const [modalOpen, setModalOpen] = useState(false)
  const [editItem, setEditItem] = useState<DPR | null>(null)
  const [detailItem, setDetailItem] = useState<DPR | null>(null)
  const [form] = Form.useForm()

  const { data: dprs, isLoading } = useQuery<{ results: DPR[] }>({
    queryKey: ['field-diary'],
    queryFn: () => api.get('/field-ops/diary/?page_size=200').then(r => r.data),
  })

  const { data: areasData } = useQuery<{ results: any[] }>({
    queryKey: ['survey-areas-list'],
    queryFn: () => api.get('/projects/survey-areas/?page_size=500').then(r => r.data),
  })

  const saveMutation = useMutation({
    mutationFn: (values: any) =>
      editItem
        ? api.patch(`/field-ops/diary/${editItem.id}/`, values)
        : api.post('/field-ops/diary/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-diary'] })
      message.success(editItem ? 'DPR updated' : 'DPR created')
      setModalOpen(false)
      form.resetFields()
      setEditItem(null)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error saving DPR'),
  })

  const submitMutation = useMutation({
    mutationFn: (id: number) => api.post(`/field-ops/diary/${id}/submit/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-diary'] })
      message.success('DPR submitted for review')
    },
  })

  const approveMutation = useMutation({
    mutationFn: (id: number) => api.post(`/field-ops/diary/${id}/approve/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-diary'] })
      message.success('DPR approved')
    },
  })

  function openCreate() {
    setEditItem(null)
    form.resetFields()
    form.setFieldsValue({ date: dayjs() })
    setModalOpen(true)
  }

  function openEdit(dpr: DPR) {
    if (dpr.is_submitted) {
      message.warning('Submitted DPRs cannot be edited')
      return
    }
    setEditItem(dpr)
    form.setFieldsValue({ ...dpr, date: dayjs(dpr.date) })
    setModalOpen(true)
  }

  const records = dprs?.results ?? []
  const areas = areasData?.results ?? []

  const columns = [
    {
      title: 'Date',
      dataIndex: 'date',
      key: 'date',
      render: (v: string) => dayjs(v).format('DD MMM YYYY'),
      sorter: (a: DPR, b: DPR) => a.date.localeCompare(b.date),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: 'Survey Area',
      dataIndex: 'survey_area_name',
      key: 'area',
      ellipsis: true,
    },
    {
      title: 'Surveyor',
      dataIndex: 'surveyor_name',
      key: 'surveyor',
    },
    {
      title: 'Weather',
      dataIndex: 'weather',
      key: 'weather',
      render: (v: string, row: DPR) => (
        <Tag color={WEATHER_COLOR[v] || 'default'}>{row.weather_display}</Tag>
      ),
    },
    {
      title: 'Progress',
      dataIndex: 'progress_pct',
      key: 'progress',
      render: (v: number) => <Progress percent={v} size="small" style={{ width: 80 }} />,
      sorter: (a: DPR, b: DPR) => a.progress_pct - b.progress_pct,
    },
    {
      title: 'Status',
      key: 'status',
      render: (_: any, row: DPR) => {
        if (row.is_approved) return <Badge status="success" text="Approved" />
        if (row.is_submitted) return <Badge status="processing" text="Submitted" />
        return <Badge status="default" text="Draft" />
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, row: DPR) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetailItem(row)} />
          {!row.is_submitted && (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
          )}
          {!row.is_submitted && (
            <Button
              size="small"
              type="primary"
              icon={<SendOutlined />}
              onClick={() => submitMutation.mutate(row.id)}
              loading={submitMutation.isPending}
            >
              Submit
            </Button>
          )}
          {isAdmin && row.is_submitted && !row.is_approved && (
            <Button
              size="small"
              type="primary"
              icon={<CheckCircleOutlined />}
              onClick={() => approveMutation.mutate(row.id)}
              loading={approveMutation.isPending}
            >
              Approve
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Title level={3} style={{ margin: 0 }}>
            <BookOutlined style={{ marginRight: 8 }} />
            Field Diary / Daily Progress Report
          </Title>
          <Text type="secondary">Record daily survey field activities and progress</Text>
        </Col>
        <Col>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            New DPR Entry
          </Button>
        </Col>
      </Row>

      <Table
        dataSource={records}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 20 }}
      />

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        title={editItem ? 'Edit DPR Entry' : 'New Daily Progress Report'}
        onCancel={() => { setModalOpen(false); form.resetFields(); setEditItem(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={720}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={values => saveMutation.mutate({
            ...values,
            date: values.date?.format('YYYY-MM-DD'),
          })}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="survey_area" label="Survey Area" rules={[{ required: true }]}>
                <Select
                  showSearch
                  filterOption={(input, opt) =>
                    (opt?.label as string ?? '').toLowerCase().includes(input.toLowerCase())}
                  options={areas.map(a => ({ value: a.id, label: a.name }))}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="date" label="Date" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="weather" label="Weather" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'CLEAR',         label: 'Clear / Sunny' },
                  { value: 'PARTLY_CLOUDY', label: 'Partly Cloudy' },
                  { value: 'CLOUDY',        label: 'Overcast' },
                  { value: 'RAINY',         label: 'Rainy' },
                  { value: 'FOGGY',         label: 'Foggy' },
                  { value: 'WINDY',         label: 'Windy' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="work_description" label="Work Done Today" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder="Describe the survey work carried out..." />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="station_points_set" label="Station Points Set">
                <InputNumber style={{ width: '100%' }} min={0} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="station_points_target" label="Target Today">
                <InputNumber style={{ width: '100%' }} min={0} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="progress_pct" label="Cumulative Progress (%)">
                <InputNumber style={{ width: '100%' }} min={0} max={100} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="manpower_count" label="Manpower Present">
                <InputNumber style={{ width: '100%' }} min={0} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="photographs_taken" label="Photographs Taken">
                <InputNumber style={{ width: '100%' }} min={0} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="difficulties_faced" label="Difficulties Faced">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="next_day_plan" label="Next Day Plan">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Detail Drawer */}
      <Drawer
        open={!!detailItem}
        onClose={() => setDetailItem(null)}
        title={`DPR — ${detailItem?.survey_area_name} — ${detailItem?.date ? dayjs(detailItem.date).format('DD MMM YYYY') : ''}`}
        width={600}
      >
        {detailItem && (
          <>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="Surveyor" span={2}>{detailItem.surveyor_name}</Descriptions.Item>
              <Descriptions.Item label="Weather" span={1}>
                <Tag color={WEATHER_COLOR[detailItem.weather]}>{detailItem.weather_display}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Progress" span={1}>
                <Progress percent={detailItem.progress_pct} size="small" />
              </Descriptions.Item>
              <Descriptions.Item label="Station Points" span={1}>
                {detailItem.station_points_set} / {detailItem.station_points_target}
              </Descriptions.Item>
              <Descriptions.Item label="Manpower" span={1}>{detailItem.manpower_count}</Descriptions.Item>
              <Descriptions.Item label="Photographs" span={1}>{detailItem.photographs_taken}</Descriptions.Item>
            </Descriptions>
            <Divider />
            <Title level={5}>Work Done</Title>
            <Text>{detailItem.work_description || '—'}</Text>
            {detailItem.difficulties_faced && (
              <>
                <Title level={5} style={{ marginTop: 12 }}>Difficulties</Title>
                <Text>{detailItem.difficulties_faced}</Text>
              </>
            )}
            {detailItem.next_day_plan && (
              <>
                <Title level={5} style={{ marginTop: 12 }}>Next Day Plan</Title>
                <Text>{detailItem.next_day_plan}</Text>
              </>
            )}
            {detailItem.equipment_usage.length > 0 && (
              <>
                <Divider />
                <Title level={5}>Equipment Used</Title>
                {detailItem.equipment_usage.map((eu: any) => (
                  <Tag key={eu.id} style={{ marginBottom: 4 }}>
                    {eu.equipment_name}{eu.hours_used ? ` (${eu.hours_used}h)` : ''}
                  </Tag>
                ))}
              </>
            )}
            <Divider />
            {detailItem.is_approved && (
              <Text type="success">
                <CheckCircleOutlined /> Approved by {detailItem.approved_by_name} on{' '}
                {dayjs(detailItem.approved_at!).format('DD MMM YYYY HH:mm')}
              </Text>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
