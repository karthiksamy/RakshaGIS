/**
 * useProjectWebSocket — real-time collaboration hook.
 *
 * Connects to ws[s]://<host>/ws/project/<id>/?token=<jwt>
 * and exposes:
 *   - connected / reconnecting state
 *   - presenceUsers: who else is in the room
 *   - lockedFeatures: Map<featureId, user> — features locked by others
 *   - sendFeatureCreated / sendFeatureUpdated / sendFeatureDeleted
 *   - lockFeature / unlockFeature
 *   - onRemoteEvent callback ref (set this to handle incoming edits)
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '@/app/store'

export interface CollabUser {
  id: number
  name: string
  color: string
}

export type CollabEventType =
  | 'feature_created'
  | 'feature_updated'
  | 'feature_deleted'
  | 'feature_locked'
  | 'feature_unlocked'
  | 'feature_lock_denied'

export interface CollabEvent {
  type: CollabEventType
  feature?: any
  feature_id?: number
  geometry?: any
  attributes?: any
  sender_id?: number
  user?: CollabUser
}

type EventHandler = (event: CollabEvent) => void

const WS_RECONNECT_DELAY = 3000
const WS_PING_INTERVAL   = 25000  // keep-alive

export function useProjectWebSocket(projectId: number | null) {
  const user = useAppStore(s => s.user)

  const wsRef       = useRef<WebSocket | null>(null)
  const pingRef     = useRef<ReturnType<typeof setInterval> | null>(null)
  const handlerRef  = useRef<EventHandler | null>(null)  // external event handler
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [connected,    setConnected]    = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [presenceUsers, setPresenceUsers] = useState<CollabUser[]>([])
  const [lockedFeatures, setLockedFeatures] = useState<Map<number, CollabUser>>(new Map())

  // Allow caller to set a handler for remote events
  const setEventHandler = useCallback((fn: EventHandler) => {
    handlerRef.current = fn
  }, [])

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  const sendFeatureCreated = useCallback((feature: any) => {
    send({ type: 'feature_created', feature })
  }, [send])

  const sendFeatureUpdated = useCallback((featureId: number, geometry: any, attributes: any) => {
    send({ type: 'feature_updated', feature_id: featureId, geometry, attributes })
  }, [send])

  const sendFeatureDeleted = useCallback((featureId: number) => {
    send({ type: 'feature_deleted', feature_id: featureId })
  }, [send])

  const lockFeature = useCallback((featureId: number) => {
    send({ type: 'feature_lock', feature_id: featureId })
  }, [send])

  const unlockFeature = useCallback((featureId: number) => {
    send({ type: 'feature_unlock', feature_id: featureId })
  }, [send])

  const sendCursor = useCallback((lng: number, lat: number) => {
    send({ type: 'cursor', lng, lat })
  }, [send])

  // Main connection logic
  useEffect(() => {
    if (!projectId || !user) return

    const token = localStorage.getItem('access_token') ?? ''
    if (!token) return

    let destroyed = false

    function connect() {
      if (destroyed) return

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const url = `${proto}://${window.location.host}/ws/project/${projectId}/?token=${token}`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        if (destroyed) { ws.close(); return }
        setConnected(true)
        setReconnecting(false)
        // Keep-alive pings
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        }, WS_PING_INTERVAL)
      }

      ws.onclose = (e) => {
        if (destroyed) return
        setConnected(false)
        setPresenceUsers([])
        if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null }
        if (e.code !== 4001 && e.code !== 4003) {
          // Reconnect unless auth failure / permission denied
          setReconnecting(true)
          reconnectRef.current = setTimeout(connect, WS_RECONNECT_DELAY)
        }
      }

      ws.onerror = () => {
        // Let onclose handle reconnect
      }

      ws.onmessage = (e) => {
        if (e.data === 'pong' || e.data === 'ping') return
        let msg: any
        try { msg = JSON.parse(e.data) } catch { return }

        switch (msg.type) {
          case 'room_state':
            setPresenceUsers(msg.users ?? [])
            setLockedFeatures(new Map(
              Object.entries(msg.locked_features ?? {}).map(([fid, u]) => [parseInt(fid), u as CollabUser])
            ))
            break

          case 'presence':
            setPresenceUsers(prev => {
              if (msg.event === 'joined') {
                return prev.some(u => u.id === msg.user.id) ? prev : [...prev, msg.user]
              }
              return prev.filter(u => u.id !== msg.user.id)
            })
            break

          case 'feature_locked':
            setLockedFeatures(prev => {
              const next = new Map(prev)
              next.set(msg.feature_id, msg.user)
              return next
            })
            handlerRef.current?.(msg)
            break

          case 'feature_unlocked':
            setLockedFeatures(prev => {
              const next = new Map(prev)
              next.delete(msg.feature_id)
              return next
            })
            handlerRef.current?.(msg)
            break

          case 'feature_created':
          case 'feature_updated':
          case 'feature_deleted':
          case 'feature_lock_denied':
            handlerRef.current?.(msg)
            break
        }
      }
    }

    connect()

    return () => {
      destroyed = true
      if (pingRef.current) clearInterval(pingRef.current)
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      wsRef.current?.close()
      setConnected(false)
      setPresenceUsers([])
      setLockedFeatures(new Map())
    }
  }, [projectId, user])

  return {
    connected,
    reconnecting,
    presenceUsers,
    lockedFeatures,
    setEventHandler,
    sendFeatureCreated,
    sendFeatureUpdated,
    sendFeatureDeleted,
    lockFeature,
    unlockFeature,
    sendCursor,
  }
}
