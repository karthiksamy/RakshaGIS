/**
 * ChunkedUploader
 * ───────────────
 * Uploads a single large file to the Django resumable-chunk upload API.
 *
 * Flow:
 *   1. POST /core/drone-datasets/upload/initiate/  → upload_id + chunk_size
 *   2. GET  /core/drone-datasets/upload/{id}/session  (optional: find missing chunks for resume)
 *   3. PUT  each chunk to /core/drone-datasets/upload/{id}/chunk/{index}/
 *   4. POST /core/drone-datasets/upload/{id}/complete/
 *
 * Props:
 *   file        — the File to upload
 *   metadata    — name, description, data_type, project, folder
 *   onDone      — called with dataset_id when assembly is queued
 *   onError     — called with error message
 *   onProgress  — called with 0–100
 *   chunkSizeMB — chunk size in MB (default 10)
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { Progress, Space, Button, Tag, Typography } from 'antd'
import { PauseOutlined, CaretRightOutlined, CloseOutlined } from '@ant-design/icons'
import api from '@/services/api'

const { Text } = Typography

export interface UploadMeta {
  name: string
  description?: string
  data_type: string
  project?: number | null
  folder?: number | null
}

interface Props {
  file: File
  meta: UploadMeta
  chunkSizeMB?: number
  autoStart?: boolean
  onDone: (uploadId: string) => void
  onError: (msg: string) => void
  onProgress?: (pct: number) => void
}

type UploadState = 'idle' | 'initiating' | 'uploading' | 'paused' | 'completing' | 'done' | 'error'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
  if (bytesPerSec < 1024 ** 2) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`
}

export default function ChunkedUploader({
  file, meta, chunkSizeMB = 10, autoStart = true,
  onDone, onError, onProgress,
}: Props) {
  const CHUNK_BYTES = chunkSizeMB * 1024 * 1024
  const totalChunks = Math.ceil(file.size / CHUNK_BYTES)

  const [state,    setState]    = useState<UploadState>('idle')
  const [uploaded, setUploaded] = useState(0)        // chunks done
  const [speed,    setSpeed]    = useState(0)        // bytes/sec
  const [uploadId, setUploadId] = useState<string>('')
  const [errMsg,   setErrMsg]   = useState('')

  const pausedRef    = useRef(false)
  const abortRef     = useRef(false)
  const startTimeRef = useRef<number>(0)
  const bytesDoneRef = useRef<number>(0)

  const pct = totalChunks ? Math.round((uploaded / totalChunks) * 100) : 0

  useEffect(() => { onProgress?.(pct) }, [pct])

  const uploadFile = useCallback(async (resumeUploadId?: string) => {
    pausedRef.current = false
    abortRef.current  = false
    setErrMsg('')

    try {
      let uid = resumeUploadId
      let missingChunks: number[] | null = null

      // ── Step 1: initiate (or resume) ──────────────────────────────
      if (!uid) {
        setState('initiating')
        const initRes = await api.post('/core/drone-datasets/upload/initiate/', {
          filename:   file.name,
          file_size:  file.size,
          chunk_size: CHUNK_BYTES,
          ...meta,
        })
        uid = initRes.data.upload_id
        setUploadId(uid!)
      } else {
        // Resume: get which chunks are still missing
        const sessionRes = await api.get(`/core/drone-datasets/upload/${uid}/session`)
        missingChunks = sessionRes.data.missing_chunks ?? null
        const alreadyDone = sessionRes.data.total_chunks - (missingChunks?.length ?? 0)
        setUploaded(alreadyDone)
        bytesDoneRef.current = alreadyDone * CHUNK_BYTES
      }

      setState('uploading')
      startTimeRef.current = Date.now() - (bytesDoneRef.current / (1024 * 1024)) * 1000 // rough

      const chunksToSend = missingChunks
        ?? Array.from({ length: totalChunks }, (_, i) => i)

      // ── Step 2: upload chunks (with concurrency = 3) ──────────────
      let cursor = 0
      const CONCURRENCY = 3

      async function sendChunk(idx: number) {
        if (abortRef.current) return
        const start = idx * CHUNK_BYTES
        const blob  = file.slice(start, start + CHUNK_BYTES)
        const fd    = new FormData()
        fd.append('chunk', blob, `chunk_${idx}`)

        const res = await api.put(
          `/core/drone-datasets/upload/${uid}/chunk/${idx}/`, fd,
          { headers: { 'Content-Type': 'multipart/form-data' } },
        )
        bytesDoneRef.current += blob.size
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        setSpeed(elapsed > 0 ? bytesDoneRef.current / elapsed : 0)
        setUploaded(res.data.received_chunks?.length ?? idx + 1)
      }

      while (cursor < chunksToSend.length) {
        if (abortRef.current) return
        if (pausedRef.current) {
          setState('paused')
          await new Promise<void>(resolve => {
            const check = setInterval(() => {
              if (!pausedRef.current) { clearInterval(check); resolve() }
            }, 300)
          })
          setState('uploading')
        }

        const batch = chunksToSend.slice(cursor, cursor + CONCURRENCY)
        await Promise.all(batch.map(sendChunk))
        cursor += CONCURRENCY
      }

      if (abortRef.current) return

      // ── Step 3: complete ──────────────────────────────────────────
      setState('completing')
      await api.post(`/core/drone-datasets/upload/${uid}/complete/`)
      setState('done')
      onDone(uid!)
    } catch (err: any) {
      const msg = err?.response?.data?.detail
            || err?.response?.data?.missing_chunks && `${err.response.data.missing_chunks.length} chunk(s) still missing`
            || err?.message
            || 'Upload failed'
      setErrMsg(msg)
      setState('error')
      onError(msg)
    }
  }, [file, meta, CHUNK_BYTES, totalChunks, onDone, onError])

  useEffect(() => {
    if (autoStart) uploadFile()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const statusColor: Record<UploadState, string> = {
    idle: 'default', initiating: 'processing', uploading: 'processing',
    paused: 'warning', completing: 'processing', done: 'success', error: 'error',
  }
  const statusLabel: Record<UploadState, string> = {
    idle: 'Queued', initiating: 'Initiating…', uploading: 'Uploading',
    paused: 'Paused', completing: 'Completing…', done: 'Done', error: 'Error',
  }

  const eta = speed > 0
    ? Math.round(((totalChunks - uploaded) * CHUNK_BYTES) / speed)
    : null

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <Space>
          <Tag color={statusColor[state]}>{statusLabel[state]}</Tag>
          <Text style={{ fontSize: 12 }} ellipsis={{ tooltip: file.name }}>
            {file.name}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {fmtBytes(file.size)}
          </Text>
        </Space>
        <Space size={4}>
          {state === 'uploading' && (
            <Button size="small" icon={<PauseOutlined />} onClick={() => { pausedRef.current = true }}
              style={{ fontSize: 11 }} />
          )}
          {state === 'paused' && (
            <Button size="small" icon={<CaretRightOutlined />} onClick={() => { pausedRef.current = false }}
              style={{ fontSize: 11 }} />
          )}
          {state === 'error' && (
            <Button size="small" icon={<CaretRightOutlined />}
              onClick={() => uploadFile(uploadId || undefined)}
              style={{ fontSize: 11 }}>
              Resume
            </Button>
          )}
          {(state === 'uploading' || state === 'paused' || state === 'error') && (
            <Button size="small" icon={<CloseOutlined />} danger
              onClick={() => { abortRef.current = true; setState('error'); setErrMsg('Cancelled') }}
              style={{ fontSize: 11 }} />
          )}
        </Space>
      </div>

      <Progress
        percent={pct}
        size="small"
        status={state === 'error' ? 'exception' : state === 'done' ? 'success' : 'active'}
        strokeColor={state === 'paused' ? '#faad14' : undefined}
        format={() => `${pct}%`}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <Text type="secondary" style={{ fontSize: 10 }}>
          {uploaded}/{totalChunks} chunks
          {speed > 0 && ` · ${fmtSpeed(speed)}`}
        </Text>
        {eta !== null && eta > 0 && (
          <Text type="secondary" style={{ fontSize: 10 }}>
            ETA {eta < 60 ? `${eta}s` : `${Math.round(eta / 60)}m`}
          </Text>
        )}
        {errMsg && <Text type="danger" style={{ fontSize: 10 }}>{errMsg}</Text>}
      </div>
    </div>
  )
}
