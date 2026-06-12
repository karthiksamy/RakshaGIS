/**
 * Pre-Submission Checklist Widget
 *
 * Drop this into the SurveyArea detail page beside the Submit button.
 * Usage: <ChecklistWidget surveyAreaId={area.id} onCanSubmit={setCanSubmit} />
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button, Card, List, Tag, Space, Typography, Divider, Alert,
  Spin, Tooltip, Badge,
} from 'antd'
import {
  CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled,
  ReloadOutlined, CheckOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import api from '@/services/api'

const { Text, Title } = Typography

interface CheckResult {
  passed: boolean
  severity: 'ERROR' | 'WARN'
  message: string
}

interface Checklist {
  id: number
  survey_area: number
  survey_area_name: string
  checked_by: number
  checked_by_name: string
  checked_at: string
  checks: Record<string, CheckResult>
  all_passed: boolean
  blocking_count: number
  warning_count: number
  can_submit: boolean
  acknowledged_by: number | null
  acknowledged_by_name: string
  acknowledged_at: string | null
}

const CHECK_LABELS: Record<string, string> = {
  area_name:             'Survey area has a name',
  has_features:          'GIS features recorded',
  features_have_geometry:'All features have geometry',
  mandatory_attributes:  'Mandatory attribute fields filled',
  has_documents:         'Project documents attached',
  has_assignee:          'Surveyor assigned',
  due_date:              'Project due date',
  topology:              'Geometry topology valid',
  field_diary_submitted: 'Field diary (DPR) submitted',
}

interface Props {
  surveyAreaId: number
  onCanSubmit?: (canSubmit: boolean) => void
}

export default function ChecklistWidget({ surveyAreaId, onCanSubmit }: Props) {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<{ results: Checklist[] }>({
    queryKey: ['checklists', surveyAreaId],
    queryFn: () =>
      api.get(`/field-ops/checklists/?survey_area=${surveyAreaId}&page_size=1`).then(r => r.data),
  })

  const latestChecklist = data?.results?.[0] ?? null

  const computeMutation = useMutation({
    mutationFn: () =>
      api.post('/field-ops/checklists/compute/', { survey_area_id: surveyAreaId }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['checklists', surveyAreaId] })
      onCanSubmit?.(res.data.can_submit)
    },
  })

  const acknowledgeMutation = useMutation({
    mutationFn: (id: number) => api.post(`/field-ops/checklists/${id}/acknowledge/`),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['checklists', surveyAreaId] })
      onCanSubmit?.(res.data.can_submit)
    },
  })

  if (isLoading) return <Spin />

  const checklist = latestChecklist

  return (
    <Card
      title={
        <Space>
          <Title level={5} style={{ margin: 0 }}>Pre-Submission Checklist</Title>
          {checklist && (
            checklist.all_passed
              ? <Badge status="success" text="All checks passed" />
              : checklist.blocking_count > 0
              ? <Badge status="error" text={`${checklist.blocking_count} error(s)`} />
              : <Badge status="warning" text={`${checklist.warning_count} warning(s)`} />
          )}
        </Space>
      }
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={() => computeMutation.mutate()}
          loading={computeMutation.isPending}
          size="small"
        >
          Run Checks
        </Button>
      }
      size="small"
    >
      {!checklist && (
        <Alert
          type="info"
          message='Click "Run Checks" to validate this survey area before submitting.'
          style={{ marginBottom: 0 }}
        />
      )}

      {checklist && (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Last checked: {dayjs(checklist.checked_at).format('DD MMM YYYY HH:mm')} by {checklist.checked_by_name}
          </Text>
          <Divider style={{ margin: '8px 0' }} />

          <List
            size="small"
            dataSource={Object.entries(checklist.checks)}
            renderItem={([key, result]) => (
              <List.Item style={{ padding: '4px 0' }}>
                <Space>
                  {result.passed ? (
                    <CheckCircleFilled style={{ color: '#52c41a' }} />
                  ) : result.severity === 'ERROR' ? (
                    <CloseCircleFilled style={{ color: '#ff4d4f' }} />
                  ) : (
                    <ExclamationCircleFilled style={{ color: '#faad14' }} />
                  )}
                  <Tooltip title={result.message}>
                    <Text
                      style={{ fontSize: 13 }}
                      type={result.passed ? undefined : result.severity === 'ERROR' ? 'danger' : 'warning'}
                    >
                      {CHECK_LABELS[key] || key}
                    </Text>
                  </Tooltip>
                  {!result.passed && (
                    <Tag color={result.severity === 'ERROR' ? 'error' : 'warning'} style={{ fontSize: 11 }}>
                      {result.severity}
                    </Tag>
                  )}
                </Space>
              </List.Item>
            )}
          />

          {checklist.blocking_count === 0 && checklist.warning_count > 0 && !checklist.acknowledged_at && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              <Alert
                type="warning"
                message="There are advisory warnings. You may proceed, but review them first."
                action={
                  <Button
                    size="small"
                    type="primary"
                    icon={<CheckOutlined />}
                    onClick={() => acknowledgeMutation.mutate(checklist.id)}
                    loading={acknowledgeMutation.isPending}
                  >
                    Acknowledge & Proceed
                  </Button>
                }
              />
            </>
          )}

          {checklist.acknowledged_at && (
            <Alert
              type="info"
              style={{ marginTop: 8 }}
              message={`Warnings acknowledged by ${checklist.acknowledged_by_name} on ${dayjs(checklist.acknowledged_at).format('DD MMM YYYY HH:mm')}`}
            />
          )}

          {checklist.can_submit && (
            <Alert
              type="success"
              style={{ marginTop: 8 }}
              icon={<CheckCircleFilled />}
              showIcon
              message="Ready for submission"
            />
          )}
        </>
      )}
    </Card>
  )
}
