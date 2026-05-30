import { Modal, Table, Alert, Typography, Tag, Space, Button } from 'antd'
import { WarningOutlined, SendOutlined } from '@ant-design/icons'

const { Text } = Typography

export interface DisputeRow {
  source_feature_id: number
  source_layer: string
  target_feature_id: number
  target_layer: string
  target_project: string
  target_org: string
  overlap_sqm: number
}

interface Props {
  open: boolean
  areaName: string
  disputes: DisputeRow[]
  loading: boolean
  readOnly?: boolean
  onCancel: () => void
  onForceSubmit: () => void
}

export default function DisputeModal({
  open, areaName, disputes, loading, readOnly, onCancel, onForceSubmit,
}: Props) {
  const columns = [
    {
      title: 'Your Feature',
      render: (_: any, r: DisputeRow) => (
        <span>
          <Tag color="blue">{r.source_layer}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}> #{r.source_feature_id}</Text>
        </span>
      ),
    },
    {
      title: 'Conflicts With',
      render: (_: any, r: DisputeRow) => (
        <span>
          <Tag color="orange">{r.target_layer}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}> #{r.target_feature_id}</Text>
        </span>
      ),
    },
    {
      title: 'Other Organisation',
      dataIndex: 'target_org',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: 'Project',
      dataIndex: 'target_project',
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: 'Overlap',
      dataIndex: 'overlap_sqm',
      width: 110,
      render: (v: number) => (
        <Text type="danger">
          {v >= 10000
            ? `${(v / 10000).toFixed(2)} ha`
            : `${v.toFixed(0)} m²`}
        </Text>
      ),
    },
  ]

  return (
    <Modal
      open={open}
      title={
        <Space>
          <WarningOutlined style={{ color: '#faad14' }} />
          Boundary Dispute Detected — {areaName}
        </Space>
      }
      width={860}
      onCancel={onCancel}
      footer={
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={onCancel}>{readOnly ? 'Close' : 'Cancel Submission'}</Button>
          {!readOnly && (
            <Button
              type="primary"
              danger
              icon={<SendOutlined />}
              loading={loading}
              onClick={onForceSubmit}
            >
              Acknowledge &amp; Submit Anyway
            </Button>
          )}
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message={`${disputes.length} spatial overlap${disputes.length !== 1 ? 's' : ''} detected`}
        description={
          <>
            The features in <strong>{areaName}</strong> overlap with published features from other
            organisations. Review the conflicts below. You may submit anyway — the overlaps will be
            recorded for review by the Checker and Approver.
          </>
        }
      />
      <Table
        rowKey={(r) => `${r.source_feature_id}-${r.target_feature_id}`}
        columns={columns}
        dataSource={disputes}
        size="small"
        pagination={disputes.length > 10 ? { pageSize: 10 } : false}
        scroll={{ x: true }}
      />
    </Modal>
  )
}
