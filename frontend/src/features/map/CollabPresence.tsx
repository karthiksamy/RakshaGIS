import { useState } from 'react'
import { Popover } from 'antd'
import { WifiOutlined, LoadingOutlined } from '@ant-design/icons'
import type { CollabUser } from '@/hooks/useProjectWebSocket'

interface Props {
  connected: boolean
  reconnecting: boolean
  users: CollabUser[]
  lockedFeatures: Map<number, CollabUser>
}

// Pick an icon/colour based on the activity label
function activityDot(activity: string, isEditing: boolean): { color: string; pulse: boolean } {
  if (isEditing)                                   return { color: '#fa8c16', pulse: true  }
  if (activity.startsWith('Drawing'))              return { color: '#ff4d4f', pulse: true  }
  if (activity.startsWith('Editing') || activity.startsWith('Moving')
    || activity.startsWith('Rotating') || activity.startsWith('Scaling')
    || activity.startsWith('Splitt') || activity.startsWith('Merging')
    || activity.startsWith('Reshaping') || activity.startsWith('Delet'))
                                                   return { color: '#fa8c16', pulse: true  }
  if (activity.startsWith('Measuring') || activity.startsWith('Buffer')
    || activity.startsWith('Select'))              return { color: '#1890ff', pulse: false }
  return { color: '#52c41a', pulse: false }   // Viewing / default
}

export default function CollabPresence({ connected, reconnecting, users, lockedFeatures }: Props) {
  const [open, setOpen] = useState(false)

  if (!connected && !reconnecting) return null

  const statusColor = reconnecting ? '#faad14' : '#52c41a'
  const editingUserIds = new Set<number>()
  lockedFeatures.forEach((u) => editingUserIds.add(u.id))

  const popoverContent = (
    <div style={{ minWidth: 200, maxWidth: 260 }}>
      {/* Status row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #f0f0f0',
      }}>
        {reconnecting
          ? <LoadingOutlined style={{ color: '#faad14', fontSize: 12 }} />
          : <WifiOutlined style={{ color: '#52c41a', fontSize: 12 }} />}
        <span style={{ fontSize: 12, fontWeight: 600, color: statusColor }}>
          {reconnecting ? 'Reconnecting…' : 'Real-time sync active'}
        </span>
      </div>

      {users.length === 0 ? (
        <div style={{ fontSize: 12, color: '#888' }}>No other users currently online</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {users.map((u) => {
            const isEditing = editingUserIds.has(u.id)
            const activity  = u.activity || 'Viewing'
            const dot       = activityDot(activity, isEditing)
            return (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* Avatar */}
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: u.color, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 700, color: '#fff',
                  border: '2px solid rgba(0,0,0,0.1)',
                  boxShadow: `0 0 6px ${u.color}55`,
                }}>
                  {u.name.slice(0, 1).toUpperCase()}
                </div>
                {/* Name + live activity */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#222',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {u.name}
                  </div>
                  <div style={{ fontSize: 10, color: dot.color, marginTop: 1,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activity}
                  </div>
                </div>
                {/* Live dot */}
                <span style={{
                  width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                  background: dot.color,
                  display: 'inline-block',
                  boxShadow: dot.pulse ? `0 0 6px ${dot.color}` : 'none',
                }} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // Active users: anyone whose activity isn't just "Viewing"
  const activeCount = users.filter(u => (u.activity || 'Viewing') !== 'Viewing').length

  return (
    <Popover
      content={popoverContent}
      title={
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          Online Users{users.length > 0 ? ` · ${users.length}` : ''}
        </span>
      }
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
    >
      {/* Single icon — same size as Layers button, below basemap */}
      <div style={{
        width: 24, height: 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(20,20,30,0.85)',
        border: `1px solid ${reconnecting ? '#faad14' : '#52c41a'}`,
        borderRadius: 4, cursor: 'pointer', alignSelf: 'flex-end',
        position: 'relative',
      }}>
        {reconnecting
          ? <LoadingOutlined style={{ color: '#faad14', fontSize: 12 }} />
          : <WifiOutlined style={{ color: '#52c41a', fontSize: 12 }} />}

        {/* Badge: orange when someone is actively working, blue when all just viewing */}
        {users.length > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 14, height: 14, borderRadius: 7,
            background: activeCount > 0 ? '#fa8c16' : '#1890ff',
            border: '1.5px solid rgba(20,20,30,0.9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 8, fontWeight: 700, color: '#fff', lineHeight: 1,
          }}>
            {users.length}
          </span>
        )}
      </div>
    </Popover>
  )
}
