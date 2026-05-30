import { Tooltip, Badge } from 'antd'
import { WifiOutlined, DisconnectOutlined, LoadingOutlined } from '@ant-design/icons'
import type { CollabUser } from '@/hooks/useProjectWebSocket'

interface Props {
  connected: boolean
  reconnecting: boolean
  users: CollabUser[]
}

export default function CollabPresence({ connected, reconnecting, users }: Props) {
  if (!connected && !reconnecting) return null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      background: 'rgba(0,0,0,0.55)', borderRadius: 20,
      padding: '3px 10px 3px 6px', backdropFilter: 'blur(4px)',
    }}>
      {reconnecting ? (
        <Tooltip title="Reconnecting to collaboration server…">
          <LoadingOutlined style={{ color: '#faad14', fontSize: 12 }} />
        </Tooltip>
      ) : (
        <Tooltip title="Collaboration active — edits sync in real time">
          <WifiOutlined style={{ color: '#52c41a', fontSize: 12 }} />
        </Tooltip>
      )}

      {users.map(u => (
        <Tooltip key={u.id} title={`${u.name} is editing`}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%',
            background: u.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700, color: '#fff',
            border: '2px solid rgba(255,255,255,0.3)',
            cursor: 'default',
          }}>
            {u.name.slice(0, 1).toUpperCase()}
          </div>
        </Tooltip>
      ))}

      {users.length > 0 && (
        <span style={{ color: '#aaa', fontSize: 10 }}>
          {users.length} online
        </span>
      )}
    </div>
  )
}
