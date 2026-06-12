import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Table, Tag, Modal, Form, Input, Select, Space, message,
  Popconfirm, Typography, Row, Col, Upload, Descriptions, Drawer,
  DatePicker, InputNumber,
} from 'antd'
import {
  PlusOutlined, EditOutlined, DeleteOutlined, PaperClipOutlined,
  ExclamationCircleOutlined, EyeOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

const { Title, Text } = Typography

interface EncroachmentRecord {
  id: number
  organisation: number
  organisation_name: string
  defence_parcel: number | null
  parcel_name: string | null
  survey_project: number | null
  encroachment_type: string
  encroachment_type_display: string
  encroacher_name: string
  encroacher_address: string
  encroacher_contact: string
  area_sqm: string | null
  detected_date: string
  detected_by: number | null
  detected_by_name: string
  status: string
  status_display: string
  notice_date: string | null
  notice_ref: string
  eviction_date: string | null
  case_ref: string
  remarks: string
  attachments: any[]
  created_by_name: string
  created_at: string
  updated_at: string
}

const STATUS_COLOR: Record<string, string> = {
  DETECTED: 'orange',
  NOTICE_SERVED: 'blue',
  LEGAL_ACTION: 'purple',
  EVICTED: 'green',
  REGULARISED: 'cyan',
  CLOSED: 'default',
}

const TYPE_COLOR: Record<string, string> = {
  OCCUPATION: 'red',
  CULTIVATION: 'lime',
  CONSTRUCTION: 'volcano',
  COMMERCIAL: 'gold',
  MINING: 'magenta',
  OTHER: 'default',
}

export default function EncroachmentPage() {
  const qc = useQueryClient()
  const user = useAppStore(s => s.user)
  const isAdmin = user && ['SUPERADMIN', 'DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN'].includes(user.role)

  const [modalOpen, setModalOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editItem, setEditItem] = useState<EncroachmentRecord | null>(null)
  const [detailItem, setDetailItem] = useState<EncroachmentRecord | null>(null)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery<{ results: EncroachmentRecord[] }>({
    queryKey: ['encroachments'],
    queryFn: () => api.get('/field-ops/encroachments/?page_size=200').then(r => r.data),
  })

  const saveMutation = useMutation({
    mutationFn: (values: any) =>
      editItem
        ? api.patch(`/field-ops/encroachments/${editItem.id}/`, values)
        : api.post('/field-ops/encroachments/', values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['encroachments'] })
      message.success(editItem ? 'Encroachment updated' : 'Encroachment recorded')
      setModalOpen(false)
      form.resetFields()
      setEditItem(null)
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Error saving'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/field-ops/encroachments/${id}/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['encroachments'] })
      message.success('Deleted')
    },
  })

  function openCreate() {
    setEditItem(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(rec: EncroachmentRecord) {
    setEditItem(rec)
    form.setFieldsValue({
      ...rec,
      detected_date: rec.detected_date ? dayjs(rec.detected_date) : null,
      notice_date: rec.notice_date ? dayjs(rec.notice_date) : null,
      eviction_date: rec.eviction_date ? dayjs(rec.eviction_date) : null,
    })
    setModalOpen(true)
  }

  function openDetail(rec: EncroachmentRecord) {
    setDetailItem(rec)
    setDetailOpen(true)
  }

  const records = data?.results ?? []

  const columns = [
    {
      title: 'Encroacher',
      dataIndex: 'encroacher_name',
      key: 'encroacher_name',
      render: (name: string, row: EncroachmentRecord) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.encroacher_contact}</Text>
        </Space>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'encroachment_type',
      key: 'type',
      render: (v: string, row: EncroachmentRecord) => (
        <Tag color={TYPE_COLOR[v] || 'default'}>{row.encroachment_type_display}</Tag>
      ),
    },
    {
      title: 'Area (sqm)',
      dataIndex: 'area_sqm',
      key: 'area_sqm',
      render: (v: string | null) => v ? Number(v).toLocaleString() : '—',
    },
    {
      title: 'Detected',
      dataIndex: 'detected_date',
      key: 'detected_date',
      render: (v: string) => dayjs(v).format('DD MMM YYYY'),
      sorter: (a: EncroachmentRecord, b: EncroachmentRecord) =>
        a.detected_date.localeCompare(b.detected_date),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (v: string, row: EncroachmentRecord) => (
        <Tag color={STATUS_COLOR[v] || 'default'}>{row.status_display}</Tag>
      ),
      filters: [
        { text: 'Detected', value: 'DETECTED' },
        { text: 'Notice Served', value: 'NOTICE_SERVED' },
        { text: 'Legal Action', value: 'LEGAL_ACTION' },
        { text: 'Evicted', value: 'EVICTED' },
        { text: 'Regularised', value: 'REGULARISED' },
        { text: 'Closed', value: 'CLOSED' },
      ],
      onFilter: (value: any, row: EncroachmentRecord) => row.status === value,
    },
    {
      title: 'Organisation',
      dataIndex: 'organisation_name',
      key: 'org',
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, row: EncroachmentRecord) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(row)} />
          {isAdmin && (
            <>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
              <Popconfirm title="Delete this record?" onConfirm={() => deleteMutation.mutate(row.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
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
            <ExclamationCircleOutlined style={{ marginRight: 8, color: '#ff4d4f' }} />
            Encroachment Register
          </Title>
          <Text type="secondary">Track and manage encroachments on defence land</Text>
        </Col>
        {isAdmin && (
          <Col>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              Record Encroachment
            </Button>
          </Col>
        )}
      </Row>

      <Table
        dataSource={records}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={{ pageSize: 20 }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={7}>
              <Text type="secondary">
                Total: {records.length} records |{' '}
                Active: {records.filter(r => !['EVICTED', 'REGULARISED', 'CLOSED'].includes(r.status)).length}
              </Text>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        title={editItem ? 'Edit Encroachment Record' : 'Record New Encroachment'}
        onCancel={() => { setModalOpen(false); form.resetFields(); setEditItem(null) }}
        onOk={() => form.submit()}
        confirmLoading={saveMutation.isPending}
        width={700}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={values => saveMutation.mutate({
            ...values,
            detected_date: values.detected_date?.format('YYYY-MM-DD'),
            notice_date: values.notice_date?.format('YYYY-MM-DD') ?? null,
            eviction_date: values.eviction_date?.format('YYYY-MM-DD') ?? null,
          })}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="encroacher_name" label="Encroacher Name" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="encroacher_contact" label="Contact">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="encroacher_address" label="Address">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="encroachment_type" label="Encroachment Type" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'OCCUPATION',   label: 'Unauthorized Occupation' },
                  { value: 'CULTIVATION',  label: 'Cultivation' },
                  { value: 'CONSTRUCTION', label: 'Unauthorized Construction' },
                  { value: 'COMMERCIAL',   label: 'Commercial Encroachment' },
                  { value: 'MINING',       label: 'Mining / Quarrying' },
                  { value: 'OTHER',        label: 'Other' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="area_sqm" label="Encroached Area (sqm)">
                <InputNumber style={{ width: '100%' }} min={0} precision={2} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="detected_date" label="Detection Date" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="Status" rules={[{ required: true }]}>
                <Select options={[
                  { value: 'DETECTED',      label: 'Detected' },
                  { value: 'NOTICE_SERVED', label: 'Notice Served' },
                  { value: 'LEGAL_ACTION',  label: 'Legal Action Initiated' },
                  { value: 'EVICTED',       label: 'Evicted' },
                  { value: 'REGULARISED',   label: 'Regularised' },
                  { value: 'CLOSED',        label: 'Closed' },
                ]} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="notice_date" label="Notice Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="notice_ref" label="Notice Reference No.">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="eviction_date" label="Eviction Date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="case_ref" label="Court Case / File Ref">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Detail Drawer */}
      <Drawer
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        title={`Encroachment #${detailItem?.id} — ${detailItem?.encroacher_name}`}
        width={600}
      >
        {detailItem && (
          <>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="Type" span={1}>
                <Tag color={TYPE_COLOR[detailItem.encroachment_type]}>
                  {detailItem.encroachment_type_display}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Status" span={1}>
                <Tag color={STATUS_COLOR[detailItem.status]}>{detailItem.status_display}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Encroacher" span={2}>
                {detailItem.encroacher_name}
              </Descriptions.Item>
              <Descriptions.Item label="Contact" span={1}>
                {detailItem.encroacher_contact || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Area" span={1}>
                {detailItem.area_sqm ? `${Number(detailItem.area_sqm).toLocaleString()} sqm` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Detected" span={1}>
                {dayjs(detailItem.detected_date).format('DD MMM YYYY')}
              </Descriptions.Item>
              <Descriptions.Item label="Detected By" span={1}>
                {detailItem.detected_by_name || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Notice Date" span={1}>
                {detailItem.notice_date ? dayjs(detailItem.notice_date).format('DD MMM YYYY') : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Notice Ref" span={1}>
                {detailItem.notice_ref || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Eviction Date" span={1}>
                {detailItem.eviction_date ? dayjs(detailItem.eviction_date).format('DD MMM YYYY') : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Case Ref" span={1}>
                {detailItem.case_ref || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Organisation" span={2}>
                {detailItem.organisation_name}
              </Descriptions.Item>
              {detailItem.parcel_name && (
                <Descriptions.Item label="Defence Parcel" span={2}>
                  {detailItem.parcel_name}
                </Descriptions.Item>
              )}
              <Descriptions.Item label="Remarks" span={2}>
                {detailItem.remarks || '—'}
              </Descriptions.Item>
            </Descriptions>

            {detailItem.attachments.length > 0 && (
              <>
                <Title level={5} style={{ marginTop: 16 }}>
                  <PaperClipOutlined /> Attachments
                </Title>
                {detailItem.attachments.map((a: any) => (
                  <div key={a.id} style={{ marginBottom: 8 }}>
                    <Tag>{a.file_type_display}</Tag>
                    <a href={a.file} target="_blank" rel="noreferrer">
                      {a.description || 'View file'}
                    </a>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </Drawer>
    </div>
  )
}
