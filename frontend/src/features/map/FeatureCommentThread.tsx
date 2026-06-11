import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Collapse, Input, List, Popconfirm, Space, Tag, Typography, message } from 'antd'
import { CommentOutlined, DeleteOutlined, SendOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import api from '@/services/api'
import { useAppStore } from '@/app/store'

dayjs.extend(relativeTime)

const { Text } = Typography

export interface FeatureComment {
  id: number
  feature: number
  user: number | null
  user_name: string
  user_username: string
  user_role: string
  text: string
  created_at: string
}

const ROLE_COLOR: Record<string, string> = {
  SUPERADMIN: 'magenta', DEO_ADMIN: 'gold', CEO_ADMIN: 'gold', ADEO_ADMIN: 'gold',
  APPROVER: 'green', CHECKER: 'cyan', SDO: 'blue', SURVEYOR: 'default', VIEWER: 'default',
}

/** Collapsible comment thread for one GISFeature (feature info drawer). */
export default function FeatureCommentThread({ featureId }: { featureId: number }) {
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const [text, setText] = useState('')

  const { data: comments = [], isLoading } = useQuery<FeatureComment[]>({
    queryKey: ['feature-comments', featureId],
    queryFn: () =>
      api.get(`/projects/feature-comments/?feature=${featureId}`)
        .then((r) => r.data.results ?? r.data),
    enabled: !!featureId,
  })

  const addMutation = useMutation({
    mutationFn: (body: string) =>
      api.post('/projects/feature-comments/', { feature: featureId, text: body }),
    onSuccess: () => {
      setText('')
      qc.invalidateQueries({ queryKey: ['feature-comments', featureId] })
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed to add comment'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/feature-comments/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feature-comments', featureId] }),
    onError: () => message.error('Failed to delete comment'),
  })

  function submit() {
    const body = text.trim()
    if (!body) return
    addMutation.mutate(body)
  }

  return (
    <Collapse
      ghost
      size="small"
      items={[{
        key: 'comments',
        label: (
          <span style={{ color: '#4fc3f7', fontSize: 12 }}>
            <CommentOutlined style={{ marginRight: 6 }} />
            Comments{comments.length > 0 ? ` (${comments.length})` : ''}
          </span>
        ),
        children: (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <List
              size="small"
              loading={isLoading}
              dataSource={comments}
              locale={{ emptyText: <span style={{ color: '#555', fontSize: 11 }}>No remarks yet</span> }}
              renderItem={(c) => (
                <List.Item
                  style={{ padding: '6px 0', borderColor: '#1a1a2e', alignItems: 'flex-start' }}
                  actions={
                    (user?.id === c.user || user?.role === 'SUPERADMIN') ? [
                      <Popconfirm key="del" title="Delete this remark?"
                        onConfirm={() => deleteMutation.mutate(c.id)}>
                        <Button size="small" type="text" danger icon={<DeleteOutlined />}
                          style={{ fontSize: 10 }} />
                      </Popconfirm>,
                    ] : undefined
                  }
                >
                  <div style={{ width: '100%' }}>
                    <Space size={6} style={{ marginBottom: 2 }}>
                      <Text style={{ color: '#e0e0e0', fontSize: 12, fontWeight: 600 }}>
                        {c.user_name || c.user_username || 'Unknown'}
                      </Text>
                      {c.user_role && (
                        <Tag color={ROLE_COLOR[c.user_role] ?? 'default'} style={{ fontSize: 9, lineHeight: '14px' }}>
                          {c.user_role}
                        </Tag>
                      )}
                      <Text style={{ color: '#555', fontSize: 10 }}>{dayjs(c.created_at).fromNow()}</Text>
                    </Space>
                    <div style={{ color: '#bbb', fontSize: 12, whiteSpace: 'pre-wrap' }}>{c.text}</div>
                  </div>
                </List.Item>
              )}
            />
            <Space.Compact style={{ width: '100%' }}>
              <Input
                size="small"
                placeholder="Add a remark…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onPressEnter={submit}
                maxLength={2000}
                style={{ background: '#0d1526', borderColor: '#1e3050', color: '#dde8f8' }}
              />
              <Button
                size="small" type="primary" icon={<SendOutlined />}
                loading={addMutation.isPending} onClick={submit}
              />
            </Space.Compact>
          </Space>
        ),
      }]}
    />
  )
}
