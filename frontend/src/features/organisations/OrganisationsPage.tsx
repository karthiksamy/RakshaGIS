import { useState } from 'react'
import { Table, Tag, Typography, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Row, Col } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()

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
      message.success(editing ? t('org.org_updated') : t('org.org_created'))
      setModalOpen(false)
    },
    onError: (e: any) => {
      const detail = e?.response?.data?.detail || JSON.stringify(e?.response?.data) || 'Save failed'
      message.error(detail)
    },
  })

  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/accounts/organisations/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.organisations() }); message.success(t('common.deleted')) },
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
    { title: t("org.office_id"), dataIndex: "office_id", width: 100 },
    { title: t("common.name"), dataIndex: "name" },
    {
      title: t('org.level'),
      dataIndex: 'level',
      render: (l) => <Tag color={LEVEL_COLORS[l] ?? 'default'}>{l}</Tag>,
    },
    { title: t("org.state"), dataIndex: "state_name" },
    { title: t("org.district"), dataIndex: "district_name" },
    { title: t("org.officer_name"), dataIndex: "officer_name" },
    ...(isSuperAdmin
      ? [{
          title: t('common.actions'),
          width: 100,
          render: (_: any, row: Organisation) => (
            <Space>
              <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
              <Popconfirm title={t("org.delete_org")} onConfirm={() => del.mutate(row.id)}>
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
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t("org.add_org")}</Button>
        )}
      </div>
      <Table
        dataSource={orgs}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [25, 50, 100, 200] }}
      />

      <Modal
        title={editing ? t('org.edit_org') : t('org.add_org')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        width={700}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="office_id" label={t("org.office_id_5")} rules={[{ max: 5 }]}>
                <Input maxLength={5} style={{ textTransform: 'uppercase' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="code" label={t("common.code")} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={16}>
              <Form.Item name="name" label={t("org.office_name")} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="level" label={t("org.level")} rules={[{ required: true }]}>
                <Select options={LEVEL_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="officer_name" label={t("org.officer_name")}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="email" label={t("user.email")}>
                <Input type="email" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="mobile" label={t("org.mobile")}>
                <Input maxLength={15} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="landline" label={t("org.landline")}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="address" label={t("org.address")}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="state" label={t("org.state")}>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={states.map((s) => ({ value: s.id, label: s.name }))}
                  onChange={(v) => { setFormState(v); form.setFieldValue('district', undefined) }}
                  placeholder={t("org.select_state")}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="district" label={t("org.district")}>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={districts.map((d) => ({ value: d.id, label: d.name }))}
                  placeholder={formState ? t("org.select_district") : t("org.select_state_first")}
                  disabled={!formState}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="pincode" label={t("org.pincode")} rules={[{ max: 6 }]}>
                <Input maxLength={6} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="parent" label={t("org.parent")}>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={orgs.map((o) => ({ value: o.id, label: `${o.level} — ${o.name}` }))}
                  placeholder={t("org.select_parent")}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}
