import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Tag, Button, Space, Typography, Tabs, Descriptions, Timeline,
  Upload, Input, Modal, Form, Select, Table, Tree, Spin, message, Alert, Dropdown,
  Image, Tooltip, Popconfirm,
} from 'antd'
import {
  ArrowLeftOutlined, UploadOutlined, SendOutlined,
  CheckOutlined, CloseOutlined, LikeOutlined, GlobalOutlined,
  FolderOutlined, FileOutlined, CheckCircleOutlined,
  CalendarOutlined, BranchesOutlined, PlusOutlined, DeleteOutlined,
  MoreOutlined, DiffOutlined, ImportOutlined, AlertOutlined, BarChartOutlined,
  PaperClipOutlined, FilePdfOutlined, DatabaseOutlined,
  FileImageOutlined, EyeOutlined, PictureOutlined,
  SyncOutlined, CheckSquareOutlined, ExclamationCircleOutlined, MinusCircleOutlined,
  CodeOutlined, EnvironmentOutlined, LockOutlined, EditOutlined, RollbackOutlined,
  StopOutlined, ClockCircleOutlined, RobotOutlined, LoadingOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { DataNode } from 'antd/es/tree'
import api from '@/services/api'
import { qk } from '@/services/queryKeys'
import { useAppStore } from '@/app/store'
import type { SurveyProject, SurveyArea, Document, ProjectLayerFolder, GeoTiffLayer, ShapefileImport, QGISUploadLog } from '@/types'

// folder and folder_name now live directly on ShapefileImport
type ShapefileImportWithFolder = ShapefileImport

const { Title, Text } = Typography

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'default', SUBMITTED: 'processing', UNDER_REVIEW: 'warning',
  APPROVED: 'success', PUBLISHED: 'green', RETURNED: 'error',
}

function folderIcon(ft: string, isFinal: boolean) {
  if (isFinal) return <CheckCircleOutlined style={{ color: '#52c41a' }} />
  if (ft === 'VERSION')   return <FileOutlined style={{ color: '#4fc3f7' }} />
  if (ft === 'YEAR')      return <CalendarOutlined style={{ color: '#faad14' }} />
  if (ft === 'ZONE')      return <BranchesOutlined style={{ color: '#9c27b0' }} />
  if (ft === 'DOC')       return <FilePdfOutlined style={{ color: '#ff7875' }} />
  if (ft === 'SHAPEFILE') return <DatabaseOutlined style={{ color: '#95de64' }} />
  if (ft === 'RASTER')    return <PictureOutlined style={{ color: '#b37feb' }} />
  if (ft === 'OTHERS')    return <FolderOutlined style={{ color: '#fa8c16' }} />
  return <FolderOutlined style={{ color: '#4fc3f7' }} />
}

function findActiveVersionId(folders: ProjectLayerFolder[]): number | null {
  // DFS: find latest created non-final VERSION folder
  let latest: ProjectLayerFolder | null = null
  function dfs(list: ProjectLayerFolder[]) {
    for (const f of list) {
      if (f.folder_type === 'VERSION' && !f.is_final) {
        if (!latest || f.id > latest.id) latest = f
      }
      if (f.children?.length) dfs(f.children)
    }
  }
  dfs(folders)
  return latest ? (latest as ProjectLayerFolder).id : null
}

function findFolderById(folders: ProjectLayerFolder[], id: number): ProjectLayerFolder | null {
  for (const f of folders) {
    if (f.id === id) return f
    if (f.children?.length) {
      const found = findFolderById(f.children, id)
      if (found) return found
    }
  }
  return null
}

const LOCKED_STATUSES = new Set(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED'])

function isFolderLocked(
  folderId: number,
  folders: ProjectLayerFolder[],
  surveyAreas: SurveyArea[],
): boolean {
  const parentMap: Record<number, number | null> = {}
  const flatten = (fs: ProjectLayerFolder[]) => {
    for (const f of fs) {
      parentMap[f.id] = f.parent
      if (f.children?.length) flatten(f.children)
    }
  }
  flatten(folders)
  let current: number | null = folderId
  while (current !== null && current !== undefined) {
    const area = surveyAreas.find((a) => a.folder === current)
    if (area && LOCKED_STATUSES.has(area.status)) return true
    current = Object.prototype.hasOwnProperty.call(parentMap, current) ? parentMap[current] : null
  }
  return false
}

function fileIcon(mimeType: string) {
  if (mimeType?.startsWith('image/')) return <FileImageOutlined style={{ color: '#ff85c2' }} />
  if (mimeType?.includes('pdf')) return <FilePdfOutlined style={{ color: '#ff7875' }} />
  return <FileOutlined style={{ color: '#8c8c8c' }} />
}

function formatBytes(bytes: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const LEAF_TYPES = new Set(['DOC', 'SHAPEFILE', 'RASTER'])

function buildTreeData(
  folders: ProjectLayerFolder[],
  activeVersionId: number | null,
  docs: Document[],
  geotiffs: GeoTiffLayer[],
  shapefileImports: ShapefileImport[],
): DataNode[] {
  // Index files by folder id
  const docsByFolder = new Map<number, Document[]>()
  docs.forEach((d) => {
    if (d.folder) {
      if (!docsByFolder.has(d.folder)) docsByFolder.set(d.folder, [])
      docsByFolder.get(d.folder)!.push(d)
    }
  })

  const geotiffsByFolder = new Map<number, GeoTiffLayer[]>()
  geotiffs.forEach((g) => {
    if (g.folder) {
      if (!geotiffsByFolder.has(g.folder)) geotiffsByFolder.set(g.folder, [])
      geotiffsByFolder.get(g.folder)!.push(g)
    }
  })

  const shpByFolder = new Map<number, ShapefileImport[]>()
  shapefileImports.forEach((s) => {
    if ((s as any).folder) {
      const fid = (s as any).folder as number
      if (!shpByFolder.has(fid)) shpByFolder.set(fid, [])
      shpByFolder.get(fid)!.push(s)
    }
  })

  const roots = folders.filter((f) => !f.parent)

  function nodeOf(f: ProjectLayerFolder): DataNode {
    const isActive  = f.folder_type === 'VERSION' && !f.is_final && f.id === activeVersionId
    const isLeaf    = LEAF_TYPES.has(f.folder_type)

    let fileLeaves: DataNode[] = []

    if (f.folder_type === 'DOC') {
      fileLeaves = (docsByFolder.get(f.id) ?? []).map((doc) => ({
        key: `doc-${doc.id}`,
        isLeaf: true,
        selectable: false,
        icon: fileIcon(doc.mime_type),
        title: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 160 }}>
            <a href={doc.file} target="_blank" rel="noreferrer"
              style={{ color: '#aaa', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={doc.title} onClick={(e) => e.stopPropagation()}>
              {doc.title}
            </a>
            {doc.file_size > 0 && (
              <span style={{ color: '#555', fontSize: 10, flexShrink: 0 }}>{formatBytes(doc.file_size)}</span>
            )}
          </span>
        ) as any,
      }))
    } else if (f.folder_type === 'RASTER') {
      fileLeaves = (geotiffsByFolder.get(f.id) ?? []).map((g) => ({
        key: `geotiff-${g.id}`,
        isLeaf: true,
        selectable: false,
        icon: <PictureOutlined style={{ color: '#b37feb' }} />,
        title: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 160 }}>
            <span style={{ color: '#aaa', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.name}>
              {g.name}
            </span>
            <span style={{
              fontSize: 9, padding: '1px 4px', borderRadius: 2, flexShrink: 0,
              background: g.status === 'DONE' ? '#135200' : g.status === 'FAILED' ? '#5c0011' : '#1d3557',
              color: g.status === 'DONE' ? '#95de64' : g.status === 'FAILED' ? '#ff7875' : '#91caff',
            }}>{g.status}</span>
          </span>
        ) as any,
      }))
    } else if (f.folder_type === 'SHAPEFILE') {
      fileLeaves = (shpByFolder.get(f.id) ?? []).map((s) => ({
        key: `shp-${s.id}`,
        isLeaf: true,
        selectable: false,
        icon: <DatabaseOutlined style={{ color: '#95de64' }} />,
        title: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 160 }}>
            <span style={{ color: '#aaa', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.layer_name}>
              {s.layer_name}
            </span>
            <span style={{
              fontSize: 9, padding: '1px 4px', borderRadius: 2, flexShrink: 0,
              background: s.status === 'DONE' ? '#135200' : s.status === 'FAILED' ? '#5c0011' : '#1d3557',
              color: s.status === 'DONE' ? '#95de64' : s.status === 'FAILED' ? '#ff7875' : '#91caff',
            }}>{s.status}</span>
          </span>
        ) as any,
      }))
    }

    const folderChildren = f.children?.map(nodeOf) ?? []
    const fileCount = fileLeaves.length

    return {
      key: f.id,
      selectable: !isLeaf,
      icon: folderIcon(f.folder_type, f.is_final),
      title: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {f.name}
          {isActive && (
            <span style={{ fontSize: 9, background: '#4CAF50', color: '#fff', borderRadius: 3, padding: '1px 4px', fontWeight: 600, lineHeight: '14px' }}>
              ACTIVE
            </span>
          )}
          {isLeaf && fileCount > 0 && (
            <span style={{ fontSize: 9, color: '#666', marginLeft: 2 }}>({fileCount})</span>
          )}
        </span>
      ) as any,
      children: [...folderChildren, ...fileLeaves],
    }
  }
  return roots.map(nodeOf)
}

function AttachmentsPanel({ projectId }: { projectId: number }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<{ results: any[] }>({
    queryKey: ['feature-attachments', projectId],
    queryFn: () => api.get(`/projects/attachments/?feature__project=${projectId}`).then(r => r.data),
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/attachments/${id}/`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feature-attachments', projectId] }),
  })

  const attachments = data?.results ?? []

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Photos and files attached to features in this project.
      </Text>
      {isLoading ? <Spin /> : attachments.length === 0 ? (
        <Text type="secondary">No attachments yet. Add photos via the Map page when editing features.</Text>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {attachments.map((att: any) => (
            <div key={att.id} style={{ width: 160, background: '#0e1a2e', border: '1px solid #1a2a3a', borderRadius: 4, overflow: 'hidden' }}>
              {att.file_type === 'image' ? (
                <Image src={att.file_url} height={100} style={{ width: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <PaperClipOutlined style={{ fontSize: 32, color: '#4fc3f7' }} />
                </div>
              )}
              <div style={{ padding: '6px 8px' }}>
                <Text style={{ fontSize: 11, color: '#aaa', display: 'block' }} ellipsis>{att.original_filename}</Text>
                <Text style={{ fontSize: 10, color: '#555' }}>{att.uploaded_by_name}</Text>
                <div style={{ marginTop: 4 }}>
                  <Popconfirm title="Delete attachment?" onConfirm={() => deleteMut.mutate(att.id)}>
                    <Button size="small" danger type="link" style={{ fontSize: 10, padding: 0 }}>Delete</Button>
                  </Popconfirm>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Space>
  )
}

function AreaWorkflowHistory({ areaId }: { areaId: number }) {
  const { data } = useQuery({
    queryKey: ['area-workflow', areaId],
    queryFn: () => api.get(`/workflow/steps/?survey_area=${areaId}&page_size=50`).then(r => r.data),
  })
  const steps = data?.results ?? []
  if (!steps.length) {
    return <div style={{ padding: '8px 0', color: 'var(--text-secondary)', fontSize: 12 }}>No workflow history yet.</div>
  }
  return (
    <div style={{ marginTop: 12, padding: '8px 0', borderTop: '1px solid var(--border-color)' }}>
      <Timeline
        style={{ marginTop: 8 }}
        items={steps.map((w: any) => ({
          color: w.action === 'APPROVE' || w.action === 'PUBLISH' ? 'green'
            : w.action === 'RETURN' ? 'red' : 'blue',
          children: (
            <div style={{ fontSize: 12 }}>
              <strong>{w.action_display || w.action}</strong>
              {' '}<span style={{ color: 'var(--text-secondary)' }}>by {w.actor_name}</span>
              {w.remarks && (
                <div style={{
                  marginTop: 4, padding: '4px 8px',
                  background: 'var(--bg-surface)', borderRadius: 4,
                  borderLeft: '2px solid #faad14', fontSize: 12,
                }}>
                  {w.remarks}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                {new Date(w.timestamp).toLocaleString()}
              </div>
            </div>
          ),
        }))}
      />
    </div>
  )
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const user = useAppStore((s) => s.user)
  const { setSelectedFolderId, setSelectedProjectId } = useAppStore()

  const [commentModal, setCommentModal] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [addFolderModal, setAddFolderModal] = useState<{ parentId: number | null; isTopLevel?: boolean } | null>(null)
  const [folderForm] = Form.useForm()
  const [csvModalOpen, setCsvModalOpen] = useState(false)
  const [csvLayerName, setCsvLayerName] = useState('imported_layer')
  const [encroachmentData, setEncroachmentData] = useState<any>(null)
  const [encroachmentLoading, setEncroachmentLoading] = useState(false)
  const [shpModal, setShpModal] = useState<{ folderId: number; folderName: string } | null>(null)
  const [shpLayerName, setShpLayerName] = useState('')
  const [shpNameField, setShpNameField] = useState('')
  const [shpUploading, setShpUploading] = useState(false)
  const [shpGisType, setShpGisType] = useState<'auto' | 'zip' | 'geojson' | 'kml' | 'gpkg' | 'tiff'>('auto')
  const [docModal, setDocModal] = useState<{ folderId: number; folderName: string } | null>(null)
  const [docUploading, setDocUploading] = useState(false)

  // Survey area state
  const [areaModal, setAreaModal] = useState<'create' | SurveyArea | null>(null)
  const [areaForm] = Form.useForm()
  const [areaWorkflowModal, setAreaWorkflowModal] = useState<{ area: SurveyArea; action: string } | null>(null)
  const [areaRemarks, setAreaRemarks] = useState('')
  const [expandedAreaId, setExpandedAreaId] = useState<number | null>(null)

  const pid = Number(id)

  const { data: project, isLoading } = useQuery<SurveyProject>({
    queryKey: qk.project(pid),
    queryFn: () => api.get(`/projects/${pid}/`).then((r) => r.data),
  })

  const { data: workflow } = useQuery({
    queryKey: qk.projectWorkflow(pid),
    queryFn: () => api.get(`/workflow/steps/?project=${pid}`).then((r) => r.data),
  })

  const [aiPollingIds, setAiPollingIds] = useState<Set<number>>(new Set())

  const { data: docs } = useQuery({
    queryKey: qk.documents({ project: pid }),
    queryFn: () => api.get(`/documents/?project=${pid}`).then((r) => r.data),
    refetchInterval: aiPollingIds.size > 0 ? 3000 : false,
  })

  const { data: geotiffs = [] } = useQuery<GeoTiffLayer[]>({
    queryKey: qk.geotiffs(pid),
    queryFn: () => api.get(`/projects/geotiffs/?project=${pid}`).then((r) => r.data.results ?? r.data),
    refetchInterval: (query) => {
      const layers = query.state.data ?? []
      return layers.some((l) => l.status === 'PENDING' || l.status === 'PROCESSING') ? 4000 : false
    },
  })

  const { data: shapefileImports = [] } = useQuery<ShapefileImport[]>({
    queryKey: qk.shapefileImports(pid),
    queryFn: () => api.get(`/projects/shapefile-imports/?project=${pid}`).then((r) => r.data.results ?? r.data),
    refetchInterval: (query) => {
      const imports = query.state.data ?? []
      return imports.some((i) => i.status === 'PENDING' || i.status === 'RUNNING') ? 4000 : false
    },
  })

  const { data: qgisLogs, refetch: refetchQgisLogs } = useQuery<{ results: QGISUploadLog[] }>({
    queryKey: ['qgis-uploads', pid],
    queryFn: () => api.get(`/projects/qgis-uploads/?project=${pid}&page_size=200`).then((r) => r.data),
  })

  const deleteGeotiff = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/geotiffs/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.geotiffs(pid) }); message.success('Layer deleted') },
  })

  const { data: foldersRaw = [] } = useQuery<ProjectLayerFolder[]>({
    queryKey: ['folders', pid],
    queryFn: () =>
      api.get(`/projects/folders/?project=${pid}`).then((r) => {
        const items: ProjectLayerFolder[] = r.data.results ?? r.data
        // Build children list locally from flat list
        const map = new Map<number, ProjectLayerFolder>()
        items.forEach((f) => map.set(f.id, { ...f, children: [] }))
        const roots: ProjectLayerFolder[] = []
        map.forEach((f) => {
          if (f.parent) map.get(f.parent)?.children.push(f)
          else roots.push(f)
        })
        return roots
      }),
  })

  const transitionMutation = useMutation({
    mutationFn: ({ action, remarks }: { action: string; remarks: string }) =>
      api.post(`/workflow/steps/transition/${pid}/${action}/`, { remarks }).then((r) => r.data),
    onSuccess: () => {
      message.success('Workflow updated')
      qc.invalidateQueries({ queryKey: qk.project(pid) })
      qc.invalidateQueries({ queryKey: qk.projectWorkflow(pid) })
      qc.invalidateQueries({ queryKey: ['folders', pid] })
      setCommentModal(null)
      setComment('')
    },
    onError: (e: any) => message.error(e.response?.data?.detail || 'Transition failed'),
  })

  // Survey Areas queries & mutations
  const { data: surveyAreas = [] } = useQuery<SurveyArea[]>({
    queryKey: qk.surveyAreas(pid),
    queryFn: () => api.get(`/projects/survey-areas/?project=${pid}&page_size=200`).then(r => r.data.results ?? r.data),
  })

  const createArea = useMutation({
    mutationFn: (values: any) => api.post('/projects/survey-areas/', { ...values, project: pid }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.surveyAreas(pid) })
      message.success('Survey area created')
      setAreaModal(null)
      areaForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed to create survey area'),
  })

  const updateArea = useMutation({
    mutationFn: ({ id, values }: { id: number; values: any }) =>
      api.patch(`/projects/survey-areas/${id}/`, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.surveyAreas(pid) })
      message.success('Survey area updated')
      setAreaModal(null)
      areaForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed to update'),
  })

  const deleteArea = useMutation({
    mutationFn: (id: number) => api.delete(`/projects/survey-areas/${id}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.surveyAreas(pid) }); message.success('Survey area deleted') },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Cannot delete — may already be submitted'),
  })

  const areaTransition = useMutation({
    mutationFn: ({ areaId, action, remarks }: { areaId: number; action: string; remarks: string }) =>
      api.post(`/workflow/steps/area-transition/${areaId}/${action}/`, { remarks }).then(r => r.data),
    onSuccess: () => {
      message.success('Workflow updated')
      qc.invalidateQueries({ queryKey: qk.surveyAreas(pid) })
      setAreaWorkflowModal(null)
      setAreaRemarks('')
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Transition failed'),
  })

  const createFolder = useMutation({
    mutationFn: (values: any) => api.post('/projects/folders/', { ...values, project: pid }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['folders', pid] })
      message.success('Folder created')
      setAddFolderModal(null)
      folderForm.resetFields()
    },
    onError: (e: any) => message.error(e?.response?.data?.detail || 'Failed'),
  })

  const deleteFolder = useMutation({
    mutationFn: (fid: number) => api.delete(`/projects/folders/${fid}/`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['folders', pid] }); message.success('Folder deleted') },
  })

  // Computed values that are safe before early returns (foldersRaw defaults to [])
  const activeVersionId = findActiveVersionId(foldersRaw)
  const allDocs: Document[] = docs?.results ?? []
  const treeData = buildTreeData(foldersRaw, activeVersionId, allDocs, geotiffs, shapefileImports as ShapefileImportWithFolder[])

  // ALL hooks must appear before any conditional return
  useEffect(() => {
    if (activeVersionId) {
      setSelectedFolderId(activeVersionId)
      setSelectedProjectId(pid)
    }
  }, [activeVersionId])

  if (isLoading) return <div style={{ padding: 24 }}><Spin /></div>
  if (!project) return <Alert type="error" message="Project not found" style={{ margin: 24 }} />

  const canForward = user?.role && ['SDO', 'SURVEYOR', 'SUPERADMIN'].includes(user.role)
  const canCheck = user?.role && ['CHECKER', 'SUPERADMIN'].includes(user.role)
  const canApprove = user?.role && ['APPROVER', 'SUPERADMIN'].includes(user.role)
  const canPublish = user?.role && ['DEO_ADMIN', 'CEO_ADMIN', 'ADEO_ADMIN', 'SUPERADMIN'].includes(user.role)
  const canEdit = user?.role && ['SDO', 'SURVEYOR', 'SUPERADMIN'].includes(user.role)

  // Per-area actions helper
  function areaActions(area: SurveyArea) {
    const acts: { key: string; label: string; icon: React.ReactNode; danger?: boolean; requiresRemarks?: boolean }[] = []
    if (canForward && area.status === 'DRAFT')
      acts.push({ key: 'forward', label: 'Submit to Checker', icon: <SendOutlined /> })
    if (canForward && area.status === 'RETURNED')
      acts.push({ key: 're_forward', label: 'Resubmit to Checker', icon: <SendOutlined /> })
    if (canCheck && area.status === 'SUBMITTED') {
      acts.push({ key: 'send_to_approver', label: 'Send to Approver', icon: <CheckOutlined /> })
      acts.push({ key: 'return_to_sdo', label: 'Return to SDO', icon: <RollbackOutlined />, danger: true, requiresRemarks: true })
    }
    if (canApprove && area.status === 'UNDER_REVIEW') {
      acts.push({ key: 'approve', label: 'Approve', icon: <LikeOutlined /> })
      acts.push({ key: 'return_from_review', label: 'Return for Revision', icon: <RollbackOutlined />, danger: true, requiresRemarks: true })
    }
    if (canPublish && area.status === 'APPROVED')
      acts.push({ key: 'publish', label: 'Publish', icon: <GlobalOutlined /> })
    return acts
  }

  const AREA_STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
    DRAFT:        { color: 'default',    icon: <EditOutlined />,          label: 'Draft' },
    SUBMITTED:    { color: 'processing', icon: <ClockCircleOutlined />,   label: 'Submitted (Checker)' },
    UNDER_REVIEW: { color: 'warning',    icon: <ExclamationCircleOutlined />, label: 'Under Review (Approver)' },
    APPROVED:     { color: 'success',    icon: <CheckCircleOutlined />,   label: 'Approved' },
    PUBLISHED:    { color: 'green',      icon: <GlobalOutlined />,        label: 'Published' },
    RETURNED:     { color: 'error',      icon: <RollbackOutlined />,      label: 'Returned for Revision' },
  }

  const actions = []
  if (canForward && project.status === 'DRAFT')
    actions.push({ key: 'forward', label: 'Submit', icon: <SendOutlined /> })
  if (canForward && project.status === 'RETURNED')
    actions.push({ key: 're_forward', label: 'Resubmit', icon: <SendOutlined /> })
  if (canCheck && project.status === 'SUBMITTED')
    actions.push({ key: 'send_to_approver', label: 'Send to Approver', icon: <CheckOutlined /> })
  if (canCheck && project.status === 'SUBMITTED')
    actions.push({ key: 'return_to_sdo', label: 'Return', icon: <CloseOutlined /> })
  if (canApprove && project.status === 'UNDER_REVIEW')
    actions.push({ key: 'approve', label: 'Approve', icon: <LikeOutlined /> })
  if (canApprove && project.status === 'UNDER_REVIEW')
    actions.push({ key: 'return_from_review', label: 'Return', icon: <CloseOutlined /> })
  if (canPublish && project.status === 'APPROVED')
    actions.push({ key: 'publish', label: 'Publish', icon: <GlobalOutlined /> })

  const SUB_FOLDER_TYPE_OPTIONS = [
    { value: 'DOC',       label: 'Doc' },
    { value: 'SHAPEFILE', label: 'Shape Files' },
    { value: 'RASTER',    label: 'Raster' },
    { value: 'OTHERS',    label: 'Others' },
  ]

  function fmtBytes(n: number | undefined) {
    if (!n) return '—'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  const SENSITIVE_PATTERNS = ['aadhar','aadhaar','pan','mobile','phone','email','address',
    'name','owner','proprietor','occupant','dob','birth','passport','voter','ration']
  function isSensitive(col: string) {
    return SENSITIVE_PATTERNS.some((p) => col.toLowerCase().includes(p))
  }

  const docColumns: ColumnsType<Document> = [
    {
      title: 'Folder', dataIndex: 'folder_name', width: 100,
      render: (v) => v ? <Tag style={{ fontSize: 10 }}>{v}</Tag> : <span style={{ color: '#555' }}>—</span>,
    },
    { title: 'Title', dataIndex: 'title', ellipsis: true },
    {
      title: 'Category', dataIndex: 'category_display', width: 100,
      render: (v, doc) => <Tag style={{ fontSize: 10 }}>{v || doc.category}</Tag>,
    },
    {
      title: 'Size', dataIndex: 'file_size', width: 70,
      render: (v) => <span style={{ color: '#888', fontSize: 11 }}>{fmtBytes(v)}</span>,
    },
    {
      title: 'Uploaded By', dataIndex: 'uploaded_by_name', width: 110, ellipsis: true,
      render: (v) => <span style={{ color: '#aaa', fontSize: 11 }}>{v || '—'}</span>,
    },
    {
      title: 'Date', dataIndex: 'uploaded_at', width: 90,
      render: (v) => <span style={{ fontSize: 11 }}>{new Date(v).toLocaleDateString()}</span>,
    },
    {
      title: 'AI',
      dataIndex: 'ai_processed',
      width: 70,
      render: (v, doc) => v ? (
        <Tooltip
          title={doc.ai_summary ? <div style={{ maxWidth: 320, fontSize: 12, whiteSpace: 'pre-wrap' }}>{doc.ai_summary}</div> : 'No summary available'}
          placement="left"
        >
          <Tag color="green" style={{ cursor: 'pointer', fontSize: 10 }}>
            <EyeOutlined style={{ marginRight: 3 }} />Done
          </Tag>
        </Tooltip>
      ) : <Tag style={{ fontSize: 10 }}>Pending</Tag>,
    },
    {
      title: 'Actions', width: 160,
      render: (_, doc) => {
        const isPolling = aiPollingIds.has(doc.id)
        return (
          <Space size={4}>
            {doc.file_url && (
              <Button size="small" type="link" href={doc.file_url} target="_blank"
                style={{ fontSize: 11, padding: 0 }}>
                Download
              </Button>
            )}
            <Tooltip title={isPolling ? 'AI processing…' : doc.ai_processed ? 'Re-run AI analysis' : 'Run AI analysis on this document'}>
              <Button
                size="small"
                type={doc.ai_processed ? 'default' : 'primary'}
                icon={isPolling ? <LoadingOutlined /> : <RobotOutlined />}
                style={{ fontSize: 11 }}
                loading={isPolling}
                onClick={() => {
                  api.post(`/documents/${doc.id}/process_ai/`).then(() => {
                    message.info('AI processing queued…')
                    setAiPollingIds((prev) => new Set([...prev, doc.id]))
                    // Stop polling once this doc becomes processed
                    const stopPoll = setInterval(() => {
                      api.get(`/documents/${doc.id}/`).then((r) => {
                        if (r.data.ai_processed) {
                          clearInterval(stopPoll)
                          setAiPollingIds((prev) => { const s = new Set(prev); s.delete(doc.id); return s })
                          qc.invalidateQueries({ queryKey: qk.documents({ project: pid }) })
                          message.success('AI processing complete')
                        }
                      }).catch(() => { clearInterval(stopPoll); setAiPollingIds((prev) => { const s = new Set(prev); s.delete(doc.id); return s }) })
                    }, 3000)
                  }).catch(() => message.error('Failed to queue AI processing'))
                }}
              >
                {isPolling ? '' : doc.ai_processed ? 'Re-process' : 'Process AI'}
              </Button>
            </Tooltip>
          </Space>
        )
      },
    },
  ]

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left: folder tree panel */}
      <div
        style={{
          width: 240, background: '#0a0a1a', borderRight: '1px solid #1a1a2e',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid #1a1a2e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: '#aaa', fontSize: 12, fontWeight: 600 }}>LAYER FOLDERS</Text>
          {canEdit && (
            <Button
              size="small" type="text" icon={<PlusOutlined />}
              style={{ color: '#4fc3f7' }}
              onClick={() => {
                folderForm.resetFields()
                folderForm.setFieldsValue({ folder_type: 'ZONE' })
                setAddFolderModal({ parentId: null, isTopLevel: true })
              }}
            />
          )}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 4px' }}>
          <Tree
            showIcon
            treeData={treeData}
            onSelect={(keys) => {
              const key = keys[0]
              if (key) {
                setSelectedFolderId(Number(key))
                setSelectedProjectId(pid)
              }
            }}
            titleRender={(node: any) => {
              const folderObj = findFolderById(foldersRaw, Number(node.key))
              const ft = folderObj?.folder_type
              const isDoc    = ft === 'DOC'
              const isShp    = ft === 'SHAPEFILE'
              const isRaster = ft === 'RASTER'
              const isLeafFolder = isDoc || isShp || isRaster
              const folderLocked = folderObj
                ? isFolderLocked(folderObj.id, foldersRaw, surveyAreas)
                : false

              const menuItems: any[] = []

              if (isDoc) {
                menuItems.push({
                  key: 'doc', label: 'Upload Document', icon: <UploadOutlined />,
                  disabled: folderLocked,
                  onClick: folderLocked ? undefined : () => setDocModal({ folderId: folderObj!.id, folderName: folderObj!.name }),
                })
              } else if (isShp) {
                menuItems.push({
                  key: 'shp', label: 'Upload Shape File / Vector GIS', icon: <ImportOutlined />,
                  disabled: folderLocked,
                  onClick: folderLocked ? undefined : () => {
                    setShpLayerName(folderObj!.name.toLowerCase().replace(/\s+/g, '_'))
                    setShpNameField('')
                    setShpGisType('zip')   // default to shapefile zip for Shape Files folder
                    setShpModal({ folderId: folderObj!.id, folderName: folderObj!.name })
                  },
                })
              } else if (isRaster) {
                menuItems.push({
                  key: 'raster', label: 'Upload GeoTIFF / Raster', icon: <PictureOutlined />,
                  disabled: folderLocked,
                  onClick: folderLocked ? undefined : () => {
                    setShpLayerName(folderObj!.name.toLowerCase().replace(/\s+/g, '_'))
                    setShpNameField('')
                    setShpGisType('tiff')   // force raster for Raster folders
                    setShpModal({ folderId: folderObj!.id, folderName: folderObj!.name })
                  },
                })
              } else {
                // Non-leaf folder: allow adding sub-folders except system-managed BOUNDARY/COMMON
                if (ft !== 'BOUNDARY' && ft !== 'COMMON') {
                  menuItems.push({ key: 'add', label: 'Add Sub-folder', icon: <PlusOutlined />,
                    disabled: folderLocked,
                    onClick: folderLocked ? undefined : () => { folderForm.resetFields(); setAddFolderModal({ parentId: Number(node.key) }) } })
                }
              }

              if (!isLeafFolder) {
                menuItems.push({ key: 'del', label: 'Delete', icon: <DeleteOutlined />, danger: true,
                  disabled: folderLocked,
                  onClick: folderLocked ? undefined : () => deleteFolder.mutate(Number(node.key)) })
              }

              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: folderLocked ? '#faad14' : '#ddd', fontSize: 12 }}>
                    {folderLocked && <LockOutlined style={{ marginRight: 4, fontSize: 10, color: '#faad14' }} />}
                    {node.title}
                  </span>
                  {canEdit && menuItems.length > 0 && (
                    <Dropdown trigger={['click']} menu={{ items: menuItems }}>
                      <Button size="small" type="text" icon={<MoreOutlined />} style={{ color: '#666' }}
                        onClick={(e) => e.stopPropagation()} />
                    </Dropdown>
                  )}
                </div>
              )
            }}
            style={{ background: 'transparent', color: '#ddd' }}
          />
        </div>
        <div style={{ padding: 8, borderTop: '1px solid #1a1a2e' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <Link to={`/projects/${pid}/compare`}>
              <Button block size="small" icon={<DiffOutlined />} style={{ fontSize: 11 }}>Compare Versions</Button>
            </Link>
            <Link to={`/projects/${pid}/gantt`}>
              <Button block size="small" icon={<BarChartOutlined />} style={{ fontSize: 11 }}>Timeline / Gantt</Button>
            </Link>
            <Button
              block size="small" icon={<ImportOutlined />} style={{ fontSize: 11 }}
              onClick={() => setCsvModalOpen(true)}
            >Import CSV</Button>
            <Button
              block size="small" icon={<AlertOutlined />} style={{ fontSize: 11 }}
              loading={encroachmentLoading}
              onClick={async () => {
                setEncroachmentLoading(true)
                try {
                  const res = await api.get(`/projects/${pid}/encroachments/`)
                  setEncroachmentData(res.data)
                } finally { setEncroachmentLoading(false) }
              }}
            >Check Encroachments</Button>
          </Space>
        </div>
      </div>

      {/* Right: project detail */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <Space style={{ marginBottom: 16 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/projects')} />
          <Title level={4} style={{ margin: 0, color: '#e8e8e8' }}>{project.name}</Title>
          <Tag color={STATUS_COLORS[project.status]}>{project.status}</Tag>
        </Space>

        {actions.length > 0 && (
          <Card size="small" style={{ marginBottom: 16, background: '#0e1a2e', border: '1px solid #1a2a4a' }}>
            <Space>
              {actions.map((a) => (
                <Button key={a.key} type="primary" icon={a.icon} size="small" onClick={() => setCommentModal(a.key)}>
                  {a.label}
                </Button>
              ))}
            </Space>
          </Card>
        )}

        <Tabs
          defaultActiveKey="survey-areas"
          items={[
            {
              key: 'survey-areas',
              label: (
                <span>
                  <EnvironmentOutlined /> Survey Areas
                  {surveyAreas.length > 0 && (
                    <Tag style={{ marginLeft: 6, fontSize: 10 }} color="blue">{surveyAreas.length}</Tag>
                  )}
                </span>
              ),
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {canForward && (
                    <Button
                      type="primary" icon={<PlusOutlined />} size="small"
                      onClick={() => { areaForm.resetFields(); setAreaModal('create') }}
                    >
                      Add Survey Area
                    </Button>
                  )}
                  {surveyAreas.length === 0 && (
                    <Alert
                      type="info"
                      message="No survey areas defined yet. Create survey areas to track workflow per area/pocket."
                      style={{ marginTop: 8 }}
                    />
                  )}
                  {surveyAreas.map((area) => {
                    const cfg = AREA_STATUS_CONFIG[area.status] ?? AREA_STATUS_CONFIG.DRAFT
                    const acts = areaActions(area)
                    const isExpanded = expandedAreaId === area.id
                    return (
                      <Card
                        key={area.id}
                        size="small"
                        style={{
                          borderLeft: `3px solid ${
                            area.status === 'APPROVED' || area.status === 'PUBLISHED' ? '#52c41a'
                            : area.status === 'RETURNED' ? '#ff4d4f'
                            : area.status === 'UNDER_REVIEW' ? '#faad14'
                            : area.status === 'SUBMITTED' ? '#1890ff'
                            : 'var(--border-color)'
                          }`,
                        }}
                        extra={
                          <Space>
                            {(area.status === 'APPROVED' || area.status === 'PUBLISHED') && (
                              <Tag color="success" icon={<LockOutlined />}>Read-only</Tag>
                            )}
                            {canForward && (area.status === 'DRAFT' || area.status === 'RETURNED') && (
                              <Button
                                size="small" icon={<EditOutlined />} type="text"
                                onClick={() => { areaForm.setFieldsValue(area); setAreaModal(area) }}
                              />
                            )}
                            {canForward && (area.status === 'DRAFT' || area.status === 'RETURNED') && (
                              <Popconfirm
                                title="Delete this survey area?"
                                onConfirm={() => deleteArea.mutate(area.id)}
                              >
                                <Button size="small" icon={<DeleteOutlined />} type="text" danger />
                              </Popconfirm>
                            )}
                            <Tooltip title="Open in Map viewer">
                              <Button
                                size="small" type="text" icon={<GlobalOutlined />}
                                style={{ color: '#4fc3f7' }}
                                onClick={() => {
                                  setSelectedProjectId(pid)
                                  navigate(`/map?area=${area.id}`)
                                }}
                              />
                            </Tooltip>
                            <Button
                              size="small" type="text" icon={<EyeOutlined />}
                              onClick={() => setExpandedAreaId(isExpanded ? null : area.id)}
                            >
                              {isExpanded ? 'Hide' : 'History'}
                            </Button>
                          </Space>
                        }
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                          <div style={{ flex: 1 }}>
                            <Text strong style={{ fontSize: 14 }}>
                              <EnvironmentOutlined style={{ marginRight: 6, color: '#4fc3f7' }} />
                              {area.name}
                            </Text>
                            {area.area_code && (
                              <Tag style={{ marginLeft: 8, fontSize: 10 }}>{area.area_code}</Tag>
                            )}
                            {area.description && (
                              <div><Text style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{area.description}</Text></div>
                            )}
                            <div style={{ marginTop: 4 }}>
                              <Tag color={cfg.color} icon={cfg.icon}>{cfg.label}</Tag>
                              {area.assigned_to_name && (
                                <Text style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>
                                  Assigned: {area.assigned_to_name}
                                </Text>
                              )}
                              <Text style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>
                                Updated: {new Date(area.updated_at).toLocaleDateString()}
                              </Text>
                            </div>
                          </div>
                          {acts.length > 0 && (
                            <Space size={4} wrap>
                              {acts.map((act) => (
                                <Button
                                  key={act.key}
                                  size="small"
                                  type={act.danger ? 'default' : 'primary'}
                                  danger={act.danger}
                                  icon={act.icon}
                                  onClick={() => {
                                    if (act.requiresRemarks) {
                                      setAreaRemarks('')
                                      setAreaWorkflowModal({ area, action: act.key })
                                    } else {
                                      areaTransition.mutate({ areaId: area.id, action: act.key, remarks: '' })
                                    }
                                  }}
                                  loading={areaTransition.isPending}
                                >
                                  {act.label}
                                </Button>
                              ))}
                            </Space>
                          )}
                        </div>

                        {/* Expanded workflow history */}
                        {isExpanded && (
                          <AreaWorkflowHistory areaId={area.id} />
                        )}
                      </Card>
                    )
                  })}
                </Space>
              ),
            },
            {
              key: 'info',
              label: 'Details',
              children: (
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="Organisation">{project.organisation_name}</Descriptions.Item>
                  <Descriptions.Item label="Status">
                    <Tag color={STATUS_COLORS[project.status]}>{project.status}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Created By">{project.created_by_name}</Descriptions.Item>
                  <Descriptions.Item label="Created At">{new Date(project.created_at).toLocaleString()}</Descriptions.Item>
                  <Descriptions.Item label="Description" span={2}>{project.description || '—'}</Descriptions.Item>
                </Descriptions>
              ),
            },
            {
              key: 'workflow',
              label: 'Project History',
              children: (
                <Timeline
                  items={(workflow?.results ?? []).map((w: any) => ({
                    color: w.action === 'APPROVE' || w.action === 'PUBLISH' ? 'green'
                      : w.action === 'RETURN' ? 'red' : 'blue',
                    children: (
                      <div>
                        <strong>{w.action_display || w.action}</strong>
                        {w.survey_area_name && (
                          <Tag style={{ marginLeft: 8, fontSize: 10 }} color="purple">{w.survey_area_name}</Tag>
                        )}
                        {' '}<span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>by {w.actor_name}</span>
                        {w.remarks && (
                          <div style={{ marginTop: 4, padding: '4px 8px', background: 'var(--bg-surface)', borderRadius: 4, fontSize: 12, borderLeft: '2px solid #faad14' }}>
                            {w.remarks}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                          {new Date(w.timestamp).toLocaleString()}
                        </div>
                      </div>
                    ),
                  }))}
                />
              ),
            },
            {
              key: 'documents',
              label: 'Documents',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Upload
                    name="file"
                    action="/api/documents/"
                    data={{ project: pid, title: 'Upload', category: 'SURVEY' }}
                    headers={{ Authorization: `Bearer ${localStorage.getItem('access_token')}` }}
                    onChange={({ file }) => {
                      if (file.status === 'done') {
                        message.success('Document uploaded')
                        qc.invalidateQueries({ queryKey: qk.documents({ project: pid }) })
                      }
                    }}
                    showUploadList={false}
                  >
                    <Button icon={<UploadOutlined />} size="small">Upload Document</Button>
                  </Upload>
                  <Table dataSource={docs?.results} columns={docColumns} rowKey="id" size="small" pagination={false} />
                </Space>
              ),
            },
            {
              key: 'geotiffs',
              label: 'GeoTiff Layers',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {canEdit && (
                    <Upload
                      name="file"
                      accept=".tif,.tiff"
                      showUploadList={false}
                      customRequest={({ file, onSuccess, onError }) => {
                        const form = new FormData()
                        form.append('file', file as Blob)
                        form.append('project', String(pid))
                        form.append('name', (file as File).name.replace(/\.[^.]+$/, ''))
                        api.post('/projects/geotiffs/', form, {
                          headers: { 'Content-Type': 'multipart/form-data' },
                        }).then((r) => {
                          message.success('GeoTiff uploaded — COG conversion queued')
                          qc.invalidateQueries({ queryKey: qk.geotiffs(pid) })
                          onSuccess?.(r.data)
                        }).catch((e) => {
                          message.error(e?.response?.data?.detail || 'Upload failed')
                          onError?.(e)
                        })
                      }}
                    >
                      <Button icon={<UploadOutlined />} size="small">Upload GeoTiff (.tif)</Button>
                    </Upload>
                  )}
                  <Table<GeoTiffLayer>
                    dataSource={geotiffs}
                    rowKey="id"
                    size="small"
                    pagination={false}
                    columns={[
                      {
                        title: 'Folder', dataIndex: 'folder_name', width: 110,
                        render: (v: string) => v ? <Tag style={{ fontSize: 10 }}>{v}</Tag> : <span style={{ color: '#555' }}>—</span>,
                      },
                      { title: 'Name', dataIndex: 'name', ellipsis: true },
                      {
                        title: 'Status',
                        dataIndex: 'status',
                        render: (s: string) => (
                          <Tag color={s === 'DONE' ? 'green' : s === 'FAILED' ? 'error' : s === 'PROCESSING' ? 'processing' : 'default'}>
                            {s}
                          </Tag>
                        ),
                      },
                      {
                        title: 'Opacity',
                        dataIndex: 'opacity',
                        render: (v: number) => `${Math.round(v * 100)}%`,
                      },
                      {
                        title: 'Error',
                        dataIndex: 'error',
                        ellipsis: true,
                        render: (v: string) => v ? <span style={{ color: '#ff4d4f', fontSize: 11 }}>{v}</span> : null,
                      },
                      {
                        title: '',
                        render: (_, row) => (
                          <Space size={4}>
                            {row.cog_url && (
                              <Button
                                size="small"
                                type="link"
                                href={row.cog_url}
                                target="_blank"
                                style={{ fontSize: 11, padding: 0 }}
                              >
                                Download
                              </Button>
                            )}
                            {canEdit && (
                              <Button
                                size="small"
                                danger
                                type="text"
                                onClick={() => deleteGeotiff.mutate(row.id)}
                                style={{ fontSize: 11 }}
                              >
                                Delete
                              </Button>
                            )}
                          </Space>
                        ),
                      },
                    ]}
                  />
                </Space>
              ),
            },
            {
              key: 'shapefiles',
              label: 'Shapefile Import',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {canEdit && (
                    <Upload
                      name="file"
                      accept=".zip,.geojson,.json,.kml,.gpkg"
                      showUploadList={false}
                      customRequest={({ file, onSuccess, onError }) => {
                        const form = new FormData()
                        form.append('file', file as Blob)
                        form.append('project', String(pid))
                        form.append('layer_name', (file as File).name.replace(/\.[^.]+$/, ''))
                        api.post('/projects/shapefile-imports/', form, {
                          headers: { 'Content-Type': 'multipart/form-data' },
                        }).then((r) => {
                          message.success('File uploaded — import queued')
                          qc.invalidateQueries({ queryKey: qk.shapefileImports(pid) })
                          onSuccess?.(r.data)
                        }).catch((e) => {
                          message.error(e?.response?.data?.detail || 'Upload failed')
                          onError?.(e)
                        })
                      }}
                    >
                      <Button icon={<UploadOutlined />} size="small">Import GIS File (.zip / .geojson / .kml / .gpkg)</Button>
                    </Upload>
                  )}
                  <Table<ShapefileImport>
                    dataSource={shapefileImports}
                    rowKey="id"
                    size="small"
                    pagination={false}
                    expandable={{
                      expandedRowRender: (row) => {
                        if (!row.columns?.length) return <span style={{ color: '#555', fontSize: 12 }}>No attribute columns recorded.</span>
                        const sensitiveOnes = row.columns.filter(isSensitive)
                        return (
                          <div style={{ padding: '8px 0' }}>
                            {sensitiveOnes.length > 0 && (
                              <Alert
                                type="warning"
                                showIcon
                                icon={<AlertOutlined />}
                                message={`Sensitive field(s) detected: ${sensitiveOnes.join(', ')}`}
                                description="These columns may contain personally identifiable information (PII). Review before sharing or indexing."
                                style={{ marginBottom: 8, fontSize: 12 }}
                              />
                            )}
                            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>Attribute columns ({row.columns.length}):</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {row.columns.map((col) => (
                                <Tag
                                  key={col}
                                  color={isSensitive(col) ? 'orange' : 'default'}
                                  icon={isSensitive(col) ? <AlertOutlined /> : undefined}
                                  style={{ fontSize: 11 }}
                                >
                                  {col}
                                </Tag>
                              ))}
                            </div>
                          </div>
                        )
                      },
                      rowExpandable: (row) => row.status === 'DONE',
                    }}
                    columns={[
                      {
                        title: 'Folder', dataIndex: 'folder_name', width: 100,
                        render: (v) => v ? <Tag style={{ fontSize: 10 }}>{v}</Tag> : <span style={{ color: '#555' }}>—</span>,
                      },
                      { title: 'Layer Name', dataIndex: 'layer_name', ellipsis: true },
                      {
                        title: 'Status', dataIndex: 'status', width: 90,
                        render: (s: string) => (
                          <Tag color={s === 'DONE' ? 'green' : s === 'FAILED' ? 'error' : s === 'RUNNING' ? 'processing' : 'default'}>
                            {s}
                          </Tag>
                        ),
                      },
                      { title: 'Features', dataIndex: 'feature_count', width: 80, render: (v) => v ?? '—' },
                      {
                        title: 'Columns', width: 80,
                        render: (_, row) => {
                          if (!row.columns?.length) return <span style={{ color: '#555' }}>—</span>
                          const sensitiveCount = row.columns.filter(isSensitive).length
                          return (
                            <Space size={4}>
                              <span style={{ fontSize: 11 }}>{row.columns.length}</span>
                              {sensitiveCount > 0 && (
                                <Tooltip title={`${sensitiveCount} sensitive field(s) — expand row to view`}>
                                  <Tag color="orange" icon={<AlertOutlined />} style={{ fontSize: 10 }}>{sensitiveCount} PII</Tag>
                                </Tooltip>
                              )}
                            </Space>
                          )
                        },
                      },
                      {
                        title: 'Uploaded By', dataIndex: 'created_by_name', width: 110, ellipsis: true,
                        render: (v) => <span style={{ color: '#aaa', fontSize: 11 }}>{v || '—'}</span>,
                      },
                      {
                        title: 'Date', dataIndex: 'created_at', width: 90,
                        render: (v: string) => <span style={{ fontSize: 11 }}>{new Date(v).toLocaleDateString()}</span>,
                      },
                      {
                        title: 'AI', width: 90,
                        render: (_, row) => {
                          if (row.status !== 'DONE') return <span style={{ color: '#555', fontSize: 11 }}>—</span>
                          if (row.ai_processed) {
                            return (
                              <Tooltip
                                title={row.ai_summary ? <div style={{ maxWidth: 340, fontSize: 12, whiteSpace: 'pre-wrap' }}>{row.ai_summary}</div> : 'No summary'}
                                placement="left"
                              >
                                <Tag color="green" style={{ cursor: 'pointer', fontSize: 10 }}>
                                  <EyeOutlined style={{ marginRight: 3 }} />Done
                                </Tag>
                              </Tooltip>
                            )
                          }
                          return (
                            <Button
                              size="small" type="primary" icon={<RobotOutlined />}
                              style={{ fontSize: 10 }}
                              onClick={() => {
                                api.post(`/projects/shapefile-imports/${row.id}/process-ai/`).then(() => {
                                  message.info('AI analysis queued…')
                                  qc.invalidateQueries({ queryKey: qk.shapefileImports(pid) })
                                }).catch(() => message.error('Failed to queue AI analysis'))
                              }}
                            >
                              Analyse
                            </Button>
                          )
                        },
                      },
                      {
                        title: 'Error', dataIndex: 'error', ellipsis: true,
                        render: (v: string) => v ? <span style={{ color: '#ff4d4f', fontSize: 11 }}>{v}</span> : null,
                      },
                    ]}
                  />
                </Space>
              ),
            },
            {
              key: 'attachments',
              label: <span><PaperClipOutlined /> Attachments</span>,
              children: <AttachmentsPanel projectId={pid} />,
            },
            {
              key: 'qgis',
              label: <span><SyncOutlined /> QGIS Sync</span>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  {/* Header strip */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Space size={16}>
                      {(() => {
                        const logs = qgisLogs?.results ?? []
                        const ok   = logs.filter(l => l.status === 'SUCCESS').length
                        const fail = logs.filter(l => l.status === 'FAILED').length
                        const skip = logs.filter(l => l.status === 'SKIPPED').length
                        return (
                          <>
                            <Tag icon={<CheckSquareOutlined />} color="success">{ok} uploaded</Tag>
                            {fail > 0 && <Tag icon={<ExclamationCircleOutlined />} color="error">{fail} failed</Tag>}
                            {skip > 0 && <Tag icon={<MinusCircleOutlined />} color="default">{skip} skipped</Tag>}
                          </>
                        )
                      })()}
                    </Space>
                    <Button size="small" icon={<SyncOutlined />} onClick={() => refetchQgisLogs()}>
                      Refresh
                    </Button>
                  </div>

                  {/* Setup guide (shown when no logs yet) */}
                  {!(qgisLogs?.results?.length) && (
                    <div style={{
                      background: '#0e1a2e', border: '1px solid #1a3050', borderRadius: 6,
                      padding: '20px 24px',
                    }}>
                      <Text style={{ color: '#4fc3f7', fontWeight: 600, fontSize: 14, display: 'block', marginBottom: 12 }}>
                        <CodeOutlined style={{ marginRight: 8 }} />
                        Connect QGIS to this project
                      </Text>
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Text style={{ color: '#aaa', fontSize: 12 }}>
                          Install the <strong>RakshaGIS Sync</strong> QGIS plugin, then open it in the QGIS Python console:
                        </Text>
                        <div style={{ background: '#060d1f', borderRadius: 4, padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>
                          <div style={{ color: '#888' }}># In QGIS Python console:</div>
                          <div style={{ color: '#7ec8e3' }}>from qgis.utils import plugins</div>
                          <div style={{ color: '#7ec8e3' }}>sync = plugins[<span style={{ color: '#a8e6a3' }}>'rakshagis_sync'</span>]</div>
                          <div style={{ color: '#7ec8e3' }}>sync.upload_file(<span style={{ color: '#a8e6a3' }}>'/path/to/output.tif'</span>, project_id=<span style={{ color: '#ffa07a' }}>{pid}</span>)</div>
                        </div>
                        <Text style={{ color: '#aaa', fontSize: 12 }}>
                          Or configure the plugin settings with Project ID <Tag style={{ fontFamily: 'monospace' }}>{pid}</Tag>
                          to auto-upload when Processing algorithms finish.
                        </Text>
                      </Space>
                    </div>
                  )}

                  {/* Upload log table */}
                  <Table<QGISUploadLog>
                    dataSource={qgisLogs?.results ?? []}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    columns={[
                      {
                        title: 'Time',
                        dataIndex: 'uploaded_at',
                        width: 130,
                        render: (v: string) => new Date(v).toLocaleString('en-IN', {
                          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                        }),
                        defaultSortOrder: 'descend' as const,
                        sorter: (a: QGISUploadLog, b: QGISUploadLog) =>
                          new Date(a.uploaded_at).getTime() - new Date(b.uploaded_at).getTime(),
                      },
                      {
                        title: 'File',
                        dataIndex: 'filename',
                        ellipsis: true,
                        render: (v: string, row: QGISUploadLog) => (
                          <div>
                            <div style={{ color: '#ddd', fontSize: 12 }}>{v}</div>
                            {row.module_name && (
                              <div style={{ color: '#666', fontSize: 10 }}>{row.module_name}</div>
                            )}
                          </div>
                        ),
                      },
                      {
                        title: 'Folder',
                        dataIndex: 'folder_name',
                        width: 120,
                        render: (v: string) => v
                          ? <Tag style={{ fontSize: 10 }}>{v}</Tag>
                          : <span style={{ color: '#444' }}>—</span>,
                      },
                      {
                        title: 'Size',
                        dataIndex: 'file_size',
                        width: 70,
                        render: (v: number) => {
                          if (!v) return '—'
                          if (v < 1024) return `${v} B`
                          if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`
                          return `${(v / (1024 * 1024)).toFixed(1)} MB`
                        },
                      },
                      {
                        title: 'Algorithm',
                        dataIndex: 'algorithm_id',
                        width: 140,
                        ellipsis: true,
                        render: (v: string) => v
                          ? <Tag style={{ fontSize: 10, fontFamily: 'monospace' }}>{v.split(':').pop()}</Tag>
                          : <span style={{ color: '#444' }}>manual</span>,
                      },
                      {
                        title: 'Status',
                        dataIndex: 'status',
                        width: 90,
                        render: (v: string) => (
                          <Tag
                            color={v === 'SUCCESS' ? 'success' : v === 'FAILED' ? 'error' : 'default'}
                            icon={
                              v === 'SUCCESS' ? <CheckSquareOutlined /> :
                              v === 'FAILED'  ? <ExclamationCircleOutlined /> :
                              <MinusCircleOutlined />
                            }
                            style={{ fontSize: 10 }}
                          >
                            {v}
                          </Tag>
                        ),
                        filters: [
                          { text: 'Success', value: 'SUCCESS' },
                          { text: 'Failed', value: 'FAILED' },
                          { text: 'Skipped', value: 'SKIPPED' },
                        ],
                        onFilter: (value: any, record: QGISUploadLog) => record.status === value,
                      },
                      {
                        title: 'Error',
                        dataIndex: 'error_message',
                        ellipsis: true,
                        render: (v: string) => v
                          ? <span style={{ color: '#ff4d4f', fontSize: 11 }}>{v}</span>
                          : null,
                      },
                      {
                        title: 'By',
                        dataIndex: 'uploaded_by_name',
                        width: 100,
                        ellipsis: true,
                        render: (v: string) => <span style={{ color: '#888', fontSize: 11 }}>{v || '—'}</span>,
                      },
                    ]}
                  />
                </Space>
              ),
            },
          ]}
        />
      </div>

      {/* CSV Import Modal */}
      <Modal
        title="Import Features from CSV"
        open={csvModalOpen}
        onCancel={() => setCsvModalOpen(false)}
        footer={null}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            CSV must have <code>latitude</code> / <code>longitude</code> columns (or a <code>wkt</code> column for any geometry).
          </Text>
          <Input
            placeholder="Layer name (e.g. survey_points)"
            value={csvLayerName}
            onChange={e => setCsvLayerName(e.target.value)}
          />
          <Upload
            accept=".csv"
            showUploadList={false}
            customRequest={({ file, onSuccess, onError }) => {
              const fd = new FormData()
              fd.append('file', file as Blob)
              fd.append('layer_name', csvLayerName || 'imported_layer')
              api.post(`/projects/${pid}/import-csv/`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
                .then(r => {
                  message.success(`Imported ${r.data.imported} of ${r.data.total} rows`)
                  if (r.data.errors?.length) message.warning(`${r.data.errors.length} rows had errors`)
                  qc.invalidateQueries({ queryKey: qk.projectFeatures(pid) })
                  setCsvModalOpen(false)
                  onSuccess?.(r.data)
                })
                .catch(e => { message.error(e?.response?.data?.detail || 'Import failed'); onError?.(e) })
            }}
          >
            <Button icon={<UploadOutlined />} type="primary">Choose CSV File & Import</Button>
          </Upload>
        </Space>
      </Modal>

      {/* Encroachment Results Modal */}
      <Modal
        title={`Encroachment Check — ${encroachmentData?.project_number ?? ''}`}
        open={!!encroachmentData}
        onCancel={() => setEncroachmentData(null)}
        footer={<Button onClick={() => setEncroachmentData(null)}>Close</Button>}
        width={680}
      >
        {encroachmentData && (
          encroachmentData.encroachment_count === 0 ? (
            <Alert message="No encroachments detected" type="success" showIcon />
          ) : (
            <>
              <Alert
                message={`${encroachmentData.encroachment_count} potential encroachment(s) found`}
                type="warning" showIcon style={{ marginBottom: 12 }}
              />
              <Table
                dataSource={encroachmentData.encroachments}
                rowKey={(r: any) => `${r.feature_id}-${r.revenue_map_id}`}
                size="small"
                pagination={false}
                columns={[
                  { title: 'Feature', dataIndex: 'feature_label', width: 100 },
                  { title: 'Layer', dataIndex: 'layer_name', width: 120 },
                  { title: 'Survey No.', dataIndex: 'survey_number', width: 120 },
                  { title: 'Overlap (ha)', dataIndex: 'overlap_area_ha', width: 100, render: v => v?.toFixed(4) },
                ]}
              />
            </>
          )
        )}
      </Modal>

      {/* Workflow transition comment modal */}
      <Modal
        title={`Confirm: ${commentModal}`}
        open={!!commentModal}
        onOk={() => commentModal && transitionMutation.mutate({ action: commentModal, remarks: comment })}
        onCancel={() => { setCommentModal(null); setComment('') }}
        confirmLoading={transitionMutation.isPending}
      >
        <Input.TextArea
          rows={3}
          placeholder="Optional remarks..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ marginTop: 12 }}
        />
      </Modal>

      {/* Survey area create/edit modal */}
      <Modal
        title={areaModal === 'create' ? 'Add Survey Area' : 'Edit Survey Area'}
        open={!!areaModal}
        onCancel={() => { setAreaModal(null); areaForm.resetFields() }}
        onOk={() => areaForm.submit()}
        confirmLoading={createArea.isPending || updateArea.isPending}
        okText={areaModal === 'create' ? 'Create' : 'Save'}
      >
        <Form
          form={areaForm}
          layout="vertical"
          style={{ marginTop: 16 }}
          onFinish={(values) => {
            if (areaModal === 'create') {
              createArea.mutate(values)
            } else if (areaModal && typeof areaModal === 'object') {
              updateArea.mutate({ id: (areaModal as SurveyArea).id, values })
            }
          }}
        >
          <Form.Item name="name" label="Area / Pocket Name" rules={[{ required: true, message: 'Name required' }]}>
            <Input placeholder="e.g. AF Tambaram, Sector 7 Cantt" />
          </Form.Item>
          <Form.Item name="area_code" label="Area Code">
            <Input placeholder="e.g. AF-TBM-01" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} placeholder="Brief description of the survey area" />
          </Form.Item>
          <Form.Item name="folder" label="Link to Folder (optional)" extra="Select the area's root folder — sub-folders are included automatically">
            <Select
              allowClear
              placeholder="Select a folder"
              options={(() => {
                // Flatten entire folder tree
                function flatten(list: ProjectLayerFolder[], depth = 0): { id: number; label: string; type: string }[] {
                  const out: { id: number; label: string; type: string }[] = []
                  for (const f of list) {
                    out.push({ id: f.id, label: `${'— '.repeat(depth)}${f.name}`, type: f.folder_type })
                    if (f.children?.length) out.push(...flatten(f.children, depth + 1))
                  }
                  return out
                }
                const SYSTEM_TYPES = new Set(['COMMON', 'BOUNDARY', 'DOC', 'SHAPEFILE', 'RASTER', 'OTHERS'])
                const editingAreaId = areaModal && typeof areaModal === 'object' ? (areaModal as SurveyArea).id : null
                const linkedFolderIds = new Set(
                  surveyAreas
                    .filter((a) => a.id !== editingAreaId)
                    .map((a) => a.folder)
                    .filter((f): f is number => f != null)
                )
                return flatten(foldersRaw)
                  .filter((f) => !SYSTEM_TYPES.has(f.type) && !linkedFolderIds.has(f.id))
                  .map((f) => ({ value: f.id, label: f.label }))
              })()}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Survey area workflow remarks modal (for Return actions) */}
      <Modal
        title={
          <Space>
            {areaWorkflowModal?.action === 'return_to_sdo' || areaWorkflowModal?.action === 'return_from_review'
              ? <><RollbackOutlined style={{ color: '#ff4d4f' }} /> Return with Remarks</>
              : <><CheckOutlined /> Confirm Action</>
            }
          </Space>
        }
        open={!!areaWorkflowModal}
        onOk={() => {
          if (!areaWorkflowModal) return
          if ((areaWorkflowModal.action === 'return_to_sdo' || areaWorkflowModal.action === 'return_from_review') && !areaRemarks.trim()) {
            message.warning('Remarks are required when returning')
            return
          }
          areaTransition.mutate({ areaId: areaWorkflowModal.area.id, action: areaWorkflowModal.action, remarks: areaRemarks })
        }}
        onCancel={() => { setAreaWorkflowModal(null); setAreaRemarks('') }}
        confirmLoading={areaTransition.isPending}
        okButtonProps={{ danger: areaWorkflowModal?.action?.startsWith('return') }}
        okText={areaWorkflowModal?.action?.startsWith('return') ? 'Return' : 'Confirm'}
      >
        <Alert
          type="info"
          showIcon
          message={`Survey Area: ${areaWorkflowModal?.area.name}`}
          style={{ marginBottom: 12 }}
        />
        <Input.TextArea
          rows={4}
          placeholder={
            areaWorkflowModal?.action?.startsWith('return')
              ? 'Remarks are required when returning (describe what needs to be corrected)...'
              : 'Optional remarks...'
          }
          value={areaRemarks}
          onChange={(e) => setAreaRemarks(e.target.value)}
          style={{ marginTop: 4 }}
        />
      </Modal>

      {/* GIS File upload modal (Shape Files or Raster folder) */}
      <Modal
        title={<><ImportOutlined style={{ marginRight: 8 }} />Upload to "{shpModal?.folderName}"</>}
        open={!!shpModal}
        onCancel={() => setShpModal(null)}
        footer={null}
        width={520}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={12}>
          {/* Only show type selector for non-forced contexts */}
          {shpGisType !== 'tiff' && (
            <div>
              <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>File Type</div>
              <Select
                style={{ width: '100%' }}
                value={shpGisType}
                onChange={(v) => setShpGisType(v)}
                options={[
                  { value: 'zip',     label: 'Shapefile (.zip — contains .shp, .dbf, .shx)' },
                  { value: 'geojson', label: 'GeoJSON (.geojson / .json)' },
                  { value: 'kml',     label: 'KML (.kml)' },
                  { value: 'gpkg',    label: 'GeoPackage (.gpkg)' },
                ]}
              />
            </div>
          )}
          {shpGisType === 'tiff' && (
            <div style={{ background: '#0e1a2e', borderRadius: 4, padding: '8px 12px' }}>
              <span style={{ color: '#b37feb', fontSize: 12 }}>
                <PictureOutlined style={{ marginRight: 6 }} />
                GeoTIFF upload — will be queued for COG conversion
              </span>
            </div>
          )}
          <div>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Layer name</div>
            <Input
              placeholder="e.g. district_boundary"
              value={shpLayerName}
              onChange={e => setShpLayerName(e.target.value)}
            />
          </div>
          {shpGisType !== 'tiff' && (
            <div>
              <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Feature label field <span style={{ color: '#666' }}>(optional)</span></div>
              <Input
                placeholder="e.g. NAME, DIST_NM, SURVEY_NO"
                value={shpNameField}
                onChange={e => setShpNameField(e.target.value)}
              />
            </div>
          )}
          <Upload
            accept={
              shpGisType === 'zip'     ? '.zip' :
              shpGisType === 'geojson' ? '.geojson,.json' :
              shpGisType === 'kml'     ? '.kml' :
              shpGisType === 'gpkg'    ? '.gpkg' :
              shpGisType === 'tiff'    ? '.tif,.tiff' :
              '.zip,.geojson,.json,.kml,.gpkg'
            }
            showUploadList={false}
            disabled={shpUploading}
            customRequest={({ file, onSuccess, onError }) => {
              if (!shpModal) return
              const fd = new FormData()
              fd.append('file', file as Blob)
              if (shpLayerName) fd.append('layer_name', shpLayerName)
              if (shpNameField) fd.append('name_field', shpNameField)
              setShpUploading(true)
              api.post(`/projects/folders/${shpModal.folderId}/import-gis-file/`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
              })
                .then(r => {
                  if (r.data.type === 'geotiff') {
                    message.success('GeoTiff uploaded — COG conversion queued')
                    qc.invalidateQueries({ queryKey: qk.geotiffs(pid) })
                  } else {
                    const { created, errors: errs } = r.data
                    message.success(`Imported ${created} feature(s)`)
                    if (errs?.length) message.warning(`${errs.length} row error(s): ${errs[0]}`)
                    qc.invalidateQueries({ queryKey: ['map-features', pid] })
                  }
                  setShpModal(null)
                  onSuccess?.(r.data)
                })
                .catch(e => {
                  message.error(e?.response?.data?.detail || 'GIS import failed')
                  onError?.(e)
                })
                .finally(() => setShpUploading(false))
            }}
          >
            <Button type="primary" icon={<UploadOutlined />} loading={shpUploading} style={{ width: '100%' }}>
              {shpUploading ? 'Importing…' : 'Choose GIS File & Import'}
            </Button>
          </Upload>
        </Space>
      </Modal>

      {/* Document upload modal (for DOC folders) */}
      <Modal
        title={<><FilePdfOutlined style={{ marginRight: 8 }} />Upload Document to "{docModal?.folderName}"</>}
        open={!!docModal}
        onCancel={() => setDocModal(null)}
        footer={null}
        width={460}
      >
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={12}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Accepted: Excel, PDF, DOCX, CSV, TXT, Images, and other document formats.
            GIS files (.shp, .tif, .geojson) should be uploaded via Shape Files or Raster folders.
          </Text>
          <Upload
            accept=".pdf,.xlsx,.xls,.doc,.docx,.csv,.txt,.png,.jpg,.jpeg,.gif,.bmp,.pptx,.ppt,.zip"
            showUploadList={false}
            disabled={docUploading}
            customRequest={({ file, onSuccess, onError }) => {
              if (!docModal) return
              const fd = new FormData()
              fd.append('file', file as Blob)
              fd.append('title', (file as File).name)
              setDocUploading(true)
              api.post(`/projects/folders/${docModal.folderId}/upload-doc/`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
              })
                .then(r => {
                  message.success('Document uploaded')
                  qc.invalidateQueries({ queryKey: qk.documents({ project: pid }) })
                  setDocModal(null)
                  onSuccess?.(r.data)
                })
                .catch(e => {
                  message.error(e?.response?.data?.detail || 'Upload failed')
                  onError?.(e)
                })
                .finally(() => setDocUploading(false))
            }}
          >
            <Button type="primary" icon={<UploadOutlined />} loading={docUploading} style={{ width: '100%' }}>
              {docUploading ? 'Uploading…' : 'Choose Document & Upload'}
            </Button>
          </Upload>
        </Space>
      </Modal>

      {/* Add folder modal */}
      <Modal
        title={addFolderModal?.isTopLevel ? 'Add Pockets Folder' : 'Add Sub-folder'}
        open={!!addFolderModal}
        onCancel={() => setAddFolderModal(null)}
        onOk={() => folderForm.submit()}
        confirmLoading={createFolder.isPending}
      >
        <Form
          form={folderForm}
          layout="vertical"
          onFinish={(v) => createFolder.mutate({ ...v, parent: addFolderModal?.parentId ?? null })}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="folder_type" label="Type" rules={[{ required: true }]}>
            {addFolderModal?.isTopLevel ? (
              <Select
                disabled
                options={[{ value: 'ZONE', label: 'Pockets' }]}
              />
            ) : (
              <Select
                placeholder="Select folder type"
                options={SUB_FOLDER_TYPE_OPTIONS}
              />
            )}
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.folder_type !== cur.folder_type}
          >
            {({ getFieldValue }) => {
              const ft = getFieldValue('folder_type')
              const isOthers = ft === 'OTHERS'
              return (
                <Form.Item name="name" label="Name" rules={[{ required: true }]}>
                  <Input
                    placeholder={
                      isOthers
                        ? 'e.g. Encroachment Data, Analysis Results…'
                        : addFolderModal?.isTopLevel
                        ? 'e.g. AFS Sulur, AF Tambaram…'
                        : ft === 'DOC' ? 'e.g. Documents'
                        : ft === 'SHAPEFILE' ? 'e.g. Shape Files'
                        : ft === 'RASTER' ? 'e.g. Raster'
                        : 'Folder name'
                    }
                  />
                </Form.Item>
              )
            }}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
