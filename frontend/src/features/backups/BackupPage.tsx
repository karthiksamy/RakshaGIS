import { useState } from 'react'
import {
  Tabs, Typography, Form, Select, Switch, Button, Table, Tag, Space,
  Popconfirm, message, Alert, Card, Statistic, Row, Col, Divider,
  Input, InputNumber, Tooltip, Modal, Spin,
} from 'antd'
import {
  CloudDownloadOutlined, DeleteOutlined, PlayCircleOutlined,
  ClockCircleOutlined, DatabaseOutlined, SafetyOutlined, ReloadOutlined,
  LockOutlined, UnlockOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

const { Title, Text } = Typography

interface BackupJob {
  id: number
  backup_type: 'FULL' | 'COMMAND' | 'OFFICE'
  org: number | null
  org_name: string | null
  org_code: string | null
  org_level: string | null
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED'
  file_path: string
  file_size_human: string
  encrypted: boolean
  result: Record<string, any>
  error_log: string
  notes: string
  created_by_name: string
  created_at: string
  completed_at: string | null
  expires_at: string | null
}

interface BackupSchedule {
  id: number
  name: string
  backup_type: 'FULL' | 'COMMAND' | 'OFFICE'
  org: number | null
  org_name: string | null
  org_code: string | null
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  run_hour: number
  encrypted: boolean
  retention_days: number
  is_active: boolean
  last_run: string | null
  recent_job_status: string | null
}

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'default', RUNNING: 'processing', DONE: 'success', FAILED: 'error',
}
const TYPE_COLOR: Record<string, string> = {
  FULL: 'purple', COMMAND: 'blue', OFFICE: 'cyan',
}

export default function BackupPage() {
  const user = useAppStore(s => s.user)
  const qc = useQueryClient()
  const isSuperAdmin = user?.role === 'SUPERADMIN'

  const { data: orgs = [] } = useQuery<any[]>({
    queryKey: ['orgs-all'],
    queryFn: () => api.get('/accounts/organisations/?page_size=500').then(r => r.data.results ?? r.data),
  })

  const { data: jobs = [], isLoading: jobsLoading } = useQuery<BackupJob[]>({
    queryKey: ['backup-jobs'],
    queryFn: () => api.get('/backups/jobs/?page_size=100').then(r => r.data.results ?? r.data),
    refetchInterval: (q) => {
      const running = (q.state.data as BackupJob[] | undefined)?.some(
        j => j.status === 'PENDING' || j.status === 'RUNNING'
      )
      return running ? 4000 : false
    },
  })

  const { data: schedules = [], isLoading: schedLoading } = useQuery<BackupSchedule[]>({
    queryKey: ['backup-schedules'],
    queryFn: () => api.get('/backups/schedules/').then(r => r.data.results ?? r.data),
    enabled: isSuperAdmin,
  })

  const { data: diskInfo } = useQuery<any>({
    queryKey: ['backup-disk'],
    queryFn: () => api.get('/backups/jobs/disk-usage/').then(r => r.data),
    enabled: isSuperAdmin,
  })

  const createJob = useMutation({
    mutationFn: (data: any) => api.post('/backups/jobs/', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-jobs'] })
      message.success('Backup queued — running in background')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed to start backup'),
  })

  const deleteJob = useMutation({
    mutationFn: (id: number) => api.delete(`/backups/jobs/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backup-jobs'] }); message.success('Deleted') },
  })

  const rotate = useMutation({
    mutationFn: () => api.post('/backups/jobs/rotate/'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-jobs'] })
      message.success('Rotation task queued')
    },
  })

  const createSchedule = useMutation({
    mutationFn: (data: any) => api.post('/backups/schedules/', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-schedules'] })
      message.success('Schedule created')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed'),
  })

  const deleteSchedule = useMutation({
    mutationFn: (id: number) => api.delete(`/backups/schedules/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedules'] }),
  })

  const toggleSchedule = useMutation({
    mutationFn: (id: number) => api.post(`/backups/schedules/${id}/toggle/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backup-schedules'] }),
  })

  const runNow = useMutation({
    mutationFn: (id: number) => api.post(`/backups/schedules/${id}/run-now/`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup-jobs'] })
      message.success('Backup triggered')
    },
  })

  function downloadJob(job: BackupJob) {
    if (job.status !== 'DONE') return
    window.open(`/api/backups/jobs/${job.id}/download/`, '_blank')
  }

  const orgOptions = orgs.map((o: any) => ({
    value: o.id,
    label: `[${o.level}] ${o.name} (${o.code})`,
    level: o.level,
  }))

  const pddeOrgs  = orgOptions.filter(o => o.level === 'PDDE')
  const officeOrgs = orgOptions.filter(o => ['DEO', 'CEO', 'ADEO'].includes(o.level))

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <SafetyOutlined style={{ fontSize: 24, color: '#4fc3f7' }} />
        <Title level={4} style={{ margin: 0 }}>Backup &amp; Recovery</Title>
        {isSuperAdmin && diskInfo && (
          <Tag color="default" style={{ marginLeft: 'auto' }}>
            <DatabaseOutlined /> {diskInfo.file_count} files · {diskInfo.total_human} on disk
          </Tag>
        )}
      </div>

      <Tabs
        defaultActiveKey="manual"
        items={[
          {
            key: 'manual',
            label: 'Manual Backup',
            children: <ManualBackupTab
              isSuperAdmin={isSuperAdmin}
              jobs={jobs}
              jobsLoading={jobsLoading}
              pddeOrgs={pddeOrgs}
              officeOrgs={officeOrgs}
              onCreateJob={createJob.mutate}
              onDeleteJob={deleteJob.mutate}
              onDownload={downloadJob}
              onRotate={() => rotate.mutate()}
              rotatePending={rotate.isPending}
              createPending={createJob.isPending}
            />,
          },
          ...(isSuperAdmin ? [{
            key: 'schedules',
            label: 'Schedules',
            children: <SchedulesTab
              schedules={schedules}
              loading={schedLoading}
              pddeOrgs={pddeOrgs}
              officeOrgs={officeOrgs}
              onCreate={createSchedule.mutate}
              onDelete={deleteSchedule.mutate}
              onToggle={toggleSchedule.mutate}
              onRunNow={runNow.mutate}
              createPending={createSchedule.isPending}
            />,
          }] : []),
        ]}
      />
    </div>
  )
}

// ── Manual Backup Tab ─────────────────────────────────────────────────────────

function ManualBackupTab({
  isSuperAdmin, jobs, jobsLoading, pddeOrgs, officeOrgs,
  onCreateJob, onDeleteJob, onDownload, onRotate, rotatePending, createPending,
}: any) {
  const [form] = Form.useForm()
  const [backupType, setBackupType] = useState<string>('FULL')

  function onFinish(v: any) {
    onCreateJob({ backup_type: v.backup_type, org: v.org ?? null, encrypted: v.encrypted ?? true })
  }

  const jobColumns = [
    {
      title: 'Type', dataIndex: 'backup_type', width: 90,
      render: (t: string) => <Tag color={TYPE_COLOR[t]}>{t}</Tag>,
    },
    {
      title: 'Target',
      render: (_: any, r: BackupJob) => r.org_name
        ? <><Tag style={{ fontSize: 10 }}>{r.org_level}</Tag> {r.org_name}</>
        : <Text type="secondary">Full DB</Text>,
    },
    {
      title: 'Status', dataIndex: 'status', width: 110,
      render: (s: string) => (
        <Tag color={STATUS_COLOR[s]} icon={s === 'RUNNING' ? <Spin size="small" /> : undefined}>
          {s}
        </Tag>
      ),
    },
    {
      title: 'Size', dataIndex: 'file_size_human', width: 90,
      render: (v: string) => <Text type="secondary">{v}</Text>,
    },
    {
      title: 'Enc.', dataIndex: 'encrypted', width: 60,
      render: (v: boolean) => v
        ? <LockOutlined style={{ color: '#52c41a' }} />
        : <UnlockOutlined style={{ color: '#faad14' }} />,
    },
    {
      title: 'Created', dataIndex: 'created_at', width: 150,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: 'Expires', dataIndex: 'expires_at', width: 110,
      render: (v: string | null) => v
        ? <Text style={{ fontSize: 11 }}>{new Date(v).toLocaleDateString()}</Text>
        : '—',
    },
    {
      title: '', width: 100,
      render: (_: any, r: BackupJob) => (
        <Space size={4}>
          <Tooltip title="Download (decrypts automatically)">
            <Button
              size="small" type="primary" ghost
              icon={<CloudDownloadOutlined />}
              disabled={r.status !== 'DONE'}
              onClick={() => onDownload(r)}
            />
          </Tooltip>
          {isSuperAdmin && (
            <Popconfirm title="Delete this backup?" onConfirm={() => onDeleteJob(r.id)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <>
      {isSuperAdmin && (
        <Card size="small" style={{ marginBottom: 20 }}>
          <Form form={form} layout="inline" onFinish={onFinish}
            initialValues={{ backup_type: 'FULL', encrypted: true }}>
            <Form.Item name="backup_type" label="Type" rules={[{ required: true }]}>
              <Select style={{ width: 160 }} onChange={setBackupType}>
                <Select.Option value="FULL">Full Database</Select.Option>
                <Select.Option value="COMMAND">Command (PDDE)</Select.Option>
                <Select.Option value="OFFICE">Office (DEO/CEO/ADEO)</Select.Option>
              </Select>
            </Form.Item>

            {backupType === 'COMMAND' && (
              <Form.Item name="org" label="PDDE Command" rules={[{ required: true }]}>
                <Select style={{ width: 200 }} options={pddeOrgs} placeholder="Select PDDE" />
              </Form.Item>
            )}
            {backupType === 'OFFICE' && (
              <Form.Item name="org" label="Office" rules={[{ required: true }]}>
                <Select
                  style={{ width: 240 }} options={officeOrgs}
                  placeholder="Select DEO/CEO/ADEO" showSearch
                  filterOption={(i, o) => (o?.label as string)?.toLowerCase().includes(i.toLowerCase())}
                />
              </Form.Item>
            )}

            <Form.Item name="encrypted" label="Encrypt" valuePropName="checked">
              <Switch checkedChildren={<LockOutlined />} unCheckedChildren={<UnlockOutlined />} />
            </Form.Item>

            <Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={createPending}
                  icon={<SafetyOutlined />}>
                  Start Backup
                </Button>
                <Tooltip title="Delete expired backup files now">
                  <Button icon={<ReloadOutlined />} loading={rotatePending} onClick={onRotate}>
                    Rotate Now
                  </Button>
                </Tooltip>
              </Space>
            </Form.Item>
          </Form>

          <Alert
            type="info" showIcon style={{ marginTop: 12 }}
            message="Encrypted backups are decrypted automatically on download. The key is stored in BACKUP_DIR/.backup_key or BACKUP_ENCRYPTION_KEY env var."
          />
        </Card>
      )}

      {!isSuperAdmin && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }}
          message="You can download backups created by SUPERADMIN for your organisation or command." />
      )}

      <Table
        rowKey="id"
        columns={jobColumns}
        dataSource={jobs}
        loading={jobsLoading}
        size="small"
        pagination={{ pageSize: 20 }}
        expandable={{
          expandedRowRender: (r: BackupJob) => (
            <div style={{ fontSize: 11 }}>
              {r.result && Object.keys(r.result).length > 0 && (
                <div>
                  <strong>Records exported:</strong>{' '}
                  {Object.entries(r.result)
                    .filter(([k]) => k !== 'encrypted')
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </div>
              )}
              {r.error_log && (
                <pre style={{ color: '#ff4d4f', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                  {r.error_log.slice(0, 500)}
                </pre>
              )}
            </div>
          ),
          rowExpandable: (r: BackupJob) => !!(r.result && Object.keys(r.result).length) || !!r.error_log,
        }}
      />
    </>
  )
}

// ── Schedules Tab ─────────────────────────────────────────────────────────────

function SchedulesTab({
  schedules, loading, pddeOrgs, officeOrgs,
  onCreate, onDelete, onToggle, onRunNow, createPending,
}: any) {
  const [form] = Form.useForm()
  const [schedType, setSchedType] = useState('FULL')

  const cols = [
    { title: 'Name', dataIndex: 'name', ellipsis: true },
    {
      title: 'Type', dataIndex: 'backup_type', width: 90,
      render: (t: string) => <Tag color={TYPE_COLOR[t]}>{t}</Tag>,
    },
    {
      title: 'Target',
      render: (_: any, r: BackupSchedule) => r.org_name
        ? <>{r.org_code} — {r.org_name}</>
        : <Text type="secondary">All</Text>,
    },
    {
      title: 'Frequency', dataIndex: 'frequency', width: 110,
      render: (v: string, r: BackupSchedule) => `${v} @ ${r.run_hour}:00 UTC`,
    },
    { title: 'Retain', dataIndex: 'retention_days', width: 80, render: (v: number) => `${v}d` },
    {
      title: 'Enc.', dataIndex: 'encrypted', width: 55,
      render: (v: boolean) => v ? <LockOutlined style={{ color: '#52c41a' }} /> : <UnlockOutlined />,
    },
    {
      title: 'Active', dataIndex: 'is_active', width: 80,
      render: (v: boolean, r: BackupSchedule) => (
        <Switch size="small" checked={v} onChange={() => onToggle(r.id)} />
      ),
    },
    {
      title: 'Last run', dataIndex: 'last_run', width: 120,
      render: (v: string | null) => v ? new Date(v).toLocaleDateString() : '—',
    },
    {
      title: '', width: 90,
      render: (_: any, r: BackupSchedule) => (
        <Space size={4}>
          <Tooltip title="Run now (ignores schedule timing)">
            <Button size="small" icon={<PlayCircleOutlined />} onClick={() => onRunNow(r.id)} />
          </Tooltip>
          <Popconfirm title="Delete schedule?" onConfirm={() => onDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card size="small" style={{ marginBottom: 20 }} title="Add Schedule">
        <Form form={form} layout="inline" onFinish={(v) => {
          onCreate({ ...v, org: v.org ?? null })
          form.resetFields()
        }} initialValues={{ frequency: 'DAILY', run_hour: 2, encrypted: true, retention_days: 30, backup_type: 'FULL' }}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input style={{ width: 160 }} placeholder="e.g. Daily Full" />
          </Form.Item>
          <Form.Item name="backup_type" label="Type" rules={[{ required: true }]}>
            <Select style={{ width: 140 }} onChange={setSchedType}>
              <Select.Option value="FULL">Full DB</Select.Option>
              <Select.Option value="COMMAND">Command</Select.Option>
              <Select.Option value="OFFICE">Office</Select.Option>
            </Select>
          </Form.Item>
          {schedType === 'COMMAND' && (
            <Form.Item name="org" label="PDDE" rules={[{ required: true }]}>
              <Select style={{ width: 180 }} options={pddeOrgs} />
            </Form.Item>
          )}
          {schedType === 'OFFICE' && (
            <Form.Item name="org" label="Office" rules={[{ required: true }]}>
              <Select style={{ width: 200 }} options={officeOrgs} showSearch />
            </Form.Item>
          )}
          <Form.Item name="frequency" label="Frequency">
            <Select style={{ width: 120 }}>
              <Select.Option value="DAILY">Daily</Select.Option>
              <Select.Option value="WEEKLY">Weekly</Select.Option>
              <Select.Option value="MONTHLY">Monthly</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="run_hour" label="UTC Hour">
            <InputNumber min={0} max={23} style={{ width: 70 }} />
          </Form.Item>
          <Form.Item name="retention_days" label="Keep (days)">
            <InputNumber min={1} max={365} style={{ width: 80 }} />
          </Form.Item>
          <Form.Item name="encrypted" label="Encrypt" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={createPending}
              icon={<ClockCircleOutlined />}>
              Add
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Table
        rowKey="id"
        columns={cols}
        dataSource={schedules}
        loading={loading}
        size="small"
        pagination={false}
      />
    </>
  )
}
