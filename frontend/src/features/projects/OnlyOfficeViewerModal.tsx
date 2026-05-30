import { useEffect, useRef, useState } from 'react'
import { Modal, Spin, Alert, Button, Space } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import api from '../../services/api'

interface EditorConfig {
  document: { fileType: string; key: string; title: string; url: string }
  documentType: string
  editorConfig: Record<string, unknown>
  token?: string
}

interface Props {
  docId: number | null
  title?: string
  downloadUrl?: string
  onClose: () => void
}

declare const DocsAPI: any

const SCRIPT_ID = 'onlyoffice-api-js'

export default function OnlyOfficeViewerModal({ docId, title, downloadUrl, onClose }: Props) {
  const editorRef = useRef<any>(null)
  // wrapperRef is always rendered as an empty div by React — OnlyOffice owns its children
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [config, setConfig] = useState<EditorConfig | null>(null)

  function destroyEditor() {
    if (editorRef.current) {
      try { editorRef.current.destroyEditor() } catch {}
      editorRef.current = null
    }
    // Clear the wrapper's children imperatively so the next init starts fresh
    const wrapper = wrapperRef.current
    if (wrapper) {
      while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild)
    }
  }

  function initEditor(cfg: EditorConfig) {
    const wrapper = wrapperRef.current
    if (!wrapper) { setError('Editor container not found.'); setLoading(false); return }

    destroyEditor()

    // Create a container div that OnlyOffice will own — React never touches this
    const container = document.createElement('div')
    container.style.width = '100%'
    container.style.height = '100%'
    wrapper.appendChild(container)

    const fullConfig = {
      ...cfg,
      events: {
        onReady: () => setLoading(false),
        onError: (e: any) => {
          setError(`Editor error: ${e?.data ?? 'unknown'}`)
          setLoading(false)
        },
        onRequestClose: onClose,
      },
    }

    try {
      editorRef.current = new DocsAPI.DocEditor(container, fullConfig)
    } catch (e: any) {
      setError(`Failed to create editor: ${e?.message ?? String(e)}`)
      setLoading(false)
    }
  }

  function loadEditor(cfg: EditorConfig) {
    if (typeof DocsAPI !== 'undefined') {
      initEditor(cfg)
      return
    }
    const existing = document.getElementById(SCRIPT_ID)
    if (existing) {
      setTimeout(() => loadEditor(cfg), 200)
      return
    }
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = '/onlyoffice/web-apps/apps/api/documents/api.js'
    script.onload = () => initEditor(cfg)
    script.onerror = () => {
      setError(
        'OnlyOffice could not be loaded. Make sure the OnlyOffice service is running ' +
        '(docker compose up -d) and accessible at /onlyoffice/.',
      )
      setLoading(false)
    }
    document.head.appendChild(script)
  }

  useEffect(() => {
    if (!docId) {
      destroyEditor()
      return
    }

    setLoading(true)
    setError(null)
    setConfig(null)

    let mounted = true

    api
      .get(`/documents/${docId}/editor-config/`)
      .then((r) => {
        if (!mounted) return
        setConfig(r.data)
        loadEditor(r.data)
      })
      .catch((e) => {
        if (!mounted) return
        setError(e?.response?.data?.detail ?? 'Failed to load editor configuration.')
        setLoading(false)
      })

    return () => {
      mounted = false
      destroyEditor()
    }
  }, [docId])

  return (
    <Modal
      open={!!docId}
      onCancel={() => { destroyEditor(); onClose() }}
      title={<span>{title || 'Document Viewer'}</span>}
      width="95vw"
      style={{ top: 10, paddingBottom: 0 }}
      styles={{ body: { height: 'calc(90vh - 55px)', padding: 0, overflow: 'hidden', position: 'relative' } }}
      footer={
        error ? (
          <Space>
            {downloadUrl && (
              <Button icon={<DownloadOutlined />} href={downloadUrl} target="_blank">
                Download File
              </Button>
            )}
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                if (config) { setLoading(true); setError(null); loadEditor(config) }
              }}
            >
              Retry
            </Button>
            <Button onClick={onClose}>Close</Button>
          </Space>
        ) : null
      }
      destroyOnClose
    >
      {/*
        wrapperRef is always the sole child here — React never puts JSX children
        inside it, so OnlyOffice can own its DOM subtree without confusing the
        reconciler. Loading and error overlays are position:absolute so they
        never shift wrapperRef's position in the parent's child list, which
        prevents the "insertBefore: child not before is not a child" crash.
      */}
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <div
          ref={wrapperRef}
          style={{ width: '100%', height: '100%', visibility: error ? 'hidden' : 'visible' }}
        />

        {loading && !error && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 10, background: 'rgba(255,255,255,0.85)',
          }}>
            <Spin size="large" tip="Loading OnlyOffice editor…" />
          </div>
        )}

        {error && (
          <div style={{
            position: 'absolute', inset: 0,
            padding: 24, overflowY: 'auto',
          }}>
            <Alert type="warning" message="OnlyOffice unavailable" description={error} showIcon />
            {downloadUrl && (
              <div style={{ marginTop: 16 }}>
                <Button type="primary" icon={<DownloadOutlined />} href={downloadUrl} target="_blank">
                  Download File Instead
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
