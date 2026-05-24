import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Layout, List, Button, Input, Typography, Spin, Space, Card, message,
} from 'antd'
import { PlusOutlined, SendOutlined, RobotOutlined, UserOutlined } from '@ant-design/icons'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import type { ChatSession, ChatMessage } from '@/types'

const { Sider, Content } = Layout

export default function AIChatPage() {
  const qc = useQueryClient()
  const [activeSession, setActiveSession] = useState<number | null>(null)
  const [inputText, setInputText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const { data: sessions, isLoading: sessionsLoading } = useQuery<ChatSession[]>({
    queryKey: qk.chatSessions(),
    queryFn: () => api.get('/ai/sessions/').then((r) => r.data.results ?? r.data),
  })

  const { data: session } = useQuery<ChatSession>({
    queryKey: qk.chatSession(activeSession!),
    queryFn: () => api.get(`/ai/sessions/${activeSession}/`).then((r) => r.data),
    enabled: !!activeSession,
  })

  const createSession = useMutation({
    mutationFn: () => api.post('/ai/sessions/', { title: 'New Chat' }).then((r) => r.data),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: qk.chatSessions() })
      setActiveSession(s.id)
    },
  })

  const sendMessage = useMutation({
    mutationFn: (msg: string) =>
      api.post(`/ai/sessions/${activeSession}/chat/`, { message: msg }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.chatSession(activeSession!) })
      setInputText('')
    },
    onError: () => message.error('AI service unavailable'),
  })

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages])

  const messages = session?.messages ?? []

  return (
    <Layout style={{ height: '100%' }}>
      {/* Session list */}
      <Sider width={240} style={{ background: '#0a0a1a', borderRight: '1px solid #1a1a2e', padding: 12 }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          block
          size="small"
          onClick={() => createSession.mutate()}
          loading={createSession.isPending}
          style={{ marginBottom: 12 }}
        >
          New Chat
        </Button>
        {sessionsLoading ? (
          <Spin size="small" />
        ) : (
          <List
            dataSource={sessions}
            renderItem={(s) => (
              <List.Item
                onClick={() => setActiveSession(s.id)}
                style={{
                  cursor: 'pointer',
                  padding: '6px 8px',
                  borderRadius: 4,
                  background: activeSession === s.id ? '#1a2a4a' : 'transparent',
                  border: 'none',
                  color: '#ccc',
                  fontSize: 13,
                }}
              >
                {s.title}
              </List.Item>
            )}
          />
        )}
      </Sider>

      {/* Chat area */}
      <Content style={{ display: 'flex', flexDirection: 'column', background: '#0e0e1e' }}>
        {!activeSession ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#555' }}>
            <Space direction="vertical" align="center">
              <RobotOutlined style={{ fontSize: 48 }} />
              <Typography.Text type="secondary">Select or create a chat session</Typography.Text>
            </Space>
          </div>
        ) : (
          <>
            {/* Messages */}
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    display: 'flex',
                    gap: 10,
                    marginBottom: 16,
                    flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: msg.role === 'user' ? '#1565c0' : '#1a3a1a',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {msg.role === 'user' ? (
                      <UserOutlined style={{ fontSize: 14, color: '#90caf9' }} />
                    ) : (
                      <RobotOutlined style={{ fontSize: 14, color: '#81c784' }} />
                    )}
                  </div>
                  <Card
                    size="small"
                    style={{
                      maxWidth: '75%',
                      background: msg.role === 'user' ? '#0d2244' : '#0d1a0d',
                      border: `1px solid ${msg.role === 'user' ? '#1a3a6a' : '#1a3a1a'}`,
                    }}
                    bodyStyle={{ padding: '8px 12px' }}
                  >
                    <Typography.Text style={{ color: '#e8e8e8', whiteSpace: 'pre-wrap', fontSize: 13 }}>
                      {msg.content}
                    </Typography.Text>
                  </Card>
                </div>
              ))}
              {sendMessage.isPending && (
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#1a3a1a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <RobotOutlined style={{ fontSize: 14, color: '#81c784' }} />
                  </div>
                  <Card size="small" style={{ background: '#0d1a0d', border: '1px solid #1a3a1a' }} bodyStyle={{ padding: '8px 12px' }}>
                    <Spin size="small" />
                  </Card>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div style={{ padding: 12, borderTop: '1px solid #1a1a2e' }}>
              <Input.TextArea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onPressEnter={(e) => {
                  if (!e.shiftKey && inputText.trim()) {
                    e.preventDefault()
                    sendMessage.mutate(inputText.trim())
                  }
                }}
                placeholder="Ask about GIS data, survey projects, or defence lands... (Enter to send)"
                autoSize={{ minRows: 1, maxRows: 4 }}
                style={{ resize: 'none', background: '#141424', borderColor: '#2a2a4a', color: '#e8e8e8' }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  size="small"
                  onClick={() => inputText.trim() && sendMessage.mutate(inputText.trim())}
                  loading={sendMessage.isPending}
                  disabled={!inputText.trim()}
                >
                  Send
                </Button>
              </div>
            </div>
          </>
        )}
      </Content>
    </Layout>
  )
}
