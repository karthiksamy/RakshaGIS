import React, { useState, useMemo } from 'react'
import { Modal, Input, Spin, Tag, Button, Empty, Tooltip } from 'antd'
import { useQuery } from '@tanstack/react-query'
import {
  SearchOutlined, RightOutlined, LeftOutlined,
  BankOutlined, TeamOutlined, GlobalOutlined,
  CheckCircleOutlined, EyeOutlined,
} from '@ant-design/icons'
import api from '@/services/api'
import type { Organisation, OrgLevel } from '@/types'

interface OrgSurveyArea {
  id: number
  name: string
  area_code: string
  status: string
  folder: number | null
  project: number
}

interface Props {
  open: boolean
  onClose: () => void
  userOrgLevel: OrgLevel | undefined
  userOrgId: number | null           // own organisation ID — used to scope PDDE/DGDE top-level
  onSelectOrg: (org: Organisation) => void
  onSelectArea: (org: Organisation, area: OrgSurveyArea) => void
  selectedOrgId: number | null
  selectedAreaId: number | null
}

const LEVEL_COLOR: Record<string, string> = {
  DGDE: '#ef9a9a', PDDE: '#ce93d8', DEO: '#4fc3f7', CEO: '#81c784', ADEO: '#ffb74d',
}

const LEVEL_LABEL: Record<string, string> = {
  DGDE: 'DGDE', PDDE: 'PDDE', DEO: 'DEO', CEO: 'CEO', ADEO: 'ADEO',
}

function LevelIcon({ level }: { level: string }) {
  if (level === 'DGDE' || level === 'PDDE') return <GlobalOutlined />
  if (level === 'DEO') return <BankOutlined />
  return <TeamOutlined />
}

export default function FieldOfficeBrowserModal({
  open, onClose, userOrgLevel, userOrgId,
  onSelectOrg, onSelectArea,
  selectedOrgId, selectedAreaId,
}: Props) {
  const [search, setSearch] = useState('')
  // Breadcrumb stack of drilled organisations
  const [breadcrumb, setBreadcrumb] = useState<Organisation[]>([])

  const currentOrg = breadcrumb[breadcrumb.length - 1] ?? null

  const { data: allOrgs = [], isLoading: orgsLoading } = useQuery<Organisation[]>({
    queryKey: ['field-orgs'],
    queryFn: () => api.get('/accounts/organisations/?page_size=500').then(r => r.data.results ?? r.data),
    enabled: open,
    staleTime: 60_000,
  })

  const { data: orgAreas = [], isLoading: areasLoading } = useQuery<OrgSurveyArea[]>({
    queryKey: ['field-org-areas', currentOrg?.id],
    queryFn: () =>
      api.get(`/projects/survey-areas/?organisation=${currentOrg!.id}&page_size=200`)
        .then(r => r.data.results ?? r.data),
    enabled: !!currentOrg,
    staleTime: 30_000,
  })

  // Organisations to show in the left list:
  //   — no current org (top level):
  //       SUPERADMIN     → all orgs grouped as a flat list
  //       DGDE user      → direct children of the DGDE org (all PDDEs under it)
  //       PDDE user      → direct children of the PDDE org (DEOs + direct ADEOs under it)
  //   — drilled into an org → direct children of that org
  const visibleOrgs = useMemo(() => {
    let base: Organisation[]

    if (currentOrg) {
      // Drilled view — always show direct children of the selected org
      base = allOrgs.filter(o => o.parent === currentOrg.id)
    } else if (userOrgId && (userOrgLevel === 'PDDE' || userOrgLevel === 'DGDE')) {
      // PDDE/DGDE: show only direct children of their own org at the top level.
      // This scopes the list to their subtree without mixing in other PDDEs' DEOs.
      base = allOrgs.filter(o => o.parent === userOrgId)
    } else {
      // SUPERADMIN (no org level): show all orgs that have no parent, OR fall back
      // to showing everything (API already returns only accessible orgs).
      const roots = allOrgs.filter(o => o.parent === null)
      base = roots.length > 0 ? roots : allOrgs
    }

    if (!search.trim()) return base
    // When searching, scan the full list (not just current level)
    const q = search.toLowerCase()
    const searchable = currentOrg ? base : allOrgs
    return searchable.filter(o =>
      o.name.toLowerCase().includes(q) || o.code?.toLowerCase().includes(q)
    )
  }, [allOrgs, currentOrg, userOrgLevel, userOrgId, search])

  function drillInto(org: Organisation) {
    setBreadcrumb(prev => [...prev, org])
    setSearch('')
  }

  function drillBack(idx: number) {
    setBreadcrumb(prev => prev.slice(0, idx))
    setSearch('')
  }

  function handleClose() {
    setBreadcrumb([])
    setSearch('')
    onClose()
  }

  const hasChildren = (org: Organisation) => allOrgs.some(o => o.parent === org.id)

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={
        <span style={{ color: '#4fc3f7', fontWeight: 700, fontSize: 14 }}>
          Field Office Browser
        </span>
      }
      width={820}
      footer={null}
      styles={{
        content: { background: 'rgba(10,14,28,0.98)', border: '1px solid #1e2a3a', padding: 0 },
        header: { background: 'rgba(10,14,28,0.98)', borderBottom: '1px solid #1e2a3a', padding: '12px 20px' },
        body: { padding: 0 },
      }}
    >
      {/* Breadcrumb */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4,
        padding: '8px 16px', borderBottom: '1px solid #1e2a3a',
        background: 'rgba(8,12,24,0.9)', flexWrap: 'wrap',
      }}>
        <span
          onClick={() => drillBack(0)}
          style={{ fontSize: 11, color: '#4fc3f7', cursor: 'pointer', fontWeight: 600 }}
        >
          All Offices
        </span>
        {breadcrumb.map((org, idx) => (
          <React.Fragment key={org.id}>
            <RightOutlined style={{ color: '#333', fontSize: 9 }} />
            <span
              onClick={() => drillBack(idx + 1)}
              style={{
                fontSize: 11,
                color: idx === breadcrumb.length - 1 ? '#e0e0e0' : '#4fc3f7',
                cursor: idx === breadcrumb.length - 1 ? 'default' : 'pointer',
                fontWeight: idx === breadcrumb.length - 1 ? 600 : 400,
              }}
            >
              {org.name}
            </span>
          </React.Fragment>
        ))}
      </div>

      <div style={{ display: 'flex', height: 480 }}>
        {/* Left panel — office list */}
        <div style={{
          width: 340, borderRight: '1px solid #1e2a3a',
          display: 'flex', flexDirection: 'column',
          background: 'rgba(8,12,24,0.98)',
        }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #1e2a3a' }}>
            <Input
              prefix={<SearchOutlined style={{ color: '#555' }} />}
              placeholder="Search offices…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              size="small"
              allowClear
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid #333', color: '#e0e0e0' }}
            />
          </div>
          {/* Back row when drilled */}
          {currentOrg && (
            <div
              onClick={() => drillBack(breadcrumb.length - 1)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 14px', cursor: 'pointer',
                borderBottom: '1px solid #1e2a3a',
                color: '#4fc3f7', fontSize: 11, fontWeight: 600,
              }}
            >
              <LeftOutlined style={{ fontSize: 10 }} />
              Back
            </div>
          )}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {orgsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                <Spin size="small" />
              </div>
            ) : visibleOrgs.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<span style={{ color: '#555', fontSize: 12 }}>No offices found</span>}
                style={{ marginTop: 32 }}
              />
            ) : (
              visibleOrgs.map((org) => {
                const col = LEVEL_COLOR[org.level] ?? '#888'
                const isActive = currentOrg?.id === org.id
                const canDrill = hasChildren(org)
                return (
                  <div
                    key={org.id}
                    onClick={() => drillInto(org)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 14px', cursor: 'pointer',
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      background: isActive ? `${col}1a` : 'transparent',
                      borderLeft: isActive ? `3px solid ${col}` : '3px solid transparent',
                      transition: 'background 0.12s',
                    }}
                  >
                    <span style={{ color: col, fontSize: 14, flexShrink: 0 }}>
                      <LevelIcon level={org.level} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        color: '#e0e0e0', fontSize: 12,
                        fontWeight: isActive ? 600 : 400,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {org.name}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                        <span style={{
                          fontSize: 10, color: col, background: `${col}22`,
                          borderRadius: 3, padding: '1px 5px', fontWeight: 700,
                        }}>
                          {LEVEL_LABEL[org.level] ?? org.level}
                        </span>
                        {org.code && (
                          <span style={{ fontSize: 10, color: '#555' }}>{org.code}</span>
                        )}
                      </div>
                    </div>
                    {canDrill && (
                      <RightOutlined style={{ color: '#444', fontSize: 10, flexShrink: 0 }} />
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Right panel — drill detail */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'rgba(10,14,28,0.98)', overflow: 'hidden' }}>
          {!currentOrg ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center', color: '#3a3a4a' }}>
                <GlobalOutlined style={{ fontSize: 36, display: 'block', marginBottom: 10 }} />
                <div style={{ fontSize: 13, color: '#444' }}>Select an office to explore</div>
                <div style={{ fontSize: 11, color: '#333', marginTop: 4 }}>
                  Drill down to see survey areas
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Office header */}
              <div style={{
                padding: '12px 16px', borderBottom: '1px solid #1e2a3a',
                display: 'flex', alignItems: 'flex-start', gap: 12,
              }}>
                <span style={{ color: LEVEL_COLOR[currentOrg.level] ?? '#888', fontSize: 18, marginTop: 2 }}>
                  <LevelIcon level={currentOrg.level} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#e0e0e0', fontWeight: 700, fontSize: 13 }}>{currentOrg.name}</div>
                  <div style={{ color: '#666', fontSize: 11, marginTop: 2 }}>
                    {currentOrg.level_display ?? currentOrg.level}
                    {currentOrg.code ? ` · ${currentOrg.code}` : ''}
                    {currentOrg.officer_name ? ` · ${currentOrg.officer_name}` : ''}
                  </div>
                </div>
                <Tooltip title="Load all published survey data for this office on the map">
                  <Button
                    size="small"
                    type="primary"
                    icon={<EyeOutlined />}
                    onClick={() => { onSelectOrg(currentOrg); handleClose() }}
                    style={{ background: '#1565c0', border: 'none', fontSize: 11, whiteSpace: 'nowrap' }}
                  >
                    View All Data
                  </Button>
                </Tooltip>
              </div>

              {/* Survey areas list */}
              <div style={{ flex: 1, overflowY: 'auto' }}>
                <div style={{
                  padding: '8px 16px 4px',
                  fontSize: 10, color: '#555', fontWeight: 700, letterSpacing: '0.06em',
                }}>
                  PUBLISHED SURVEY AREAS
                  {!areasLoading && ` (${orgAreas.length})`}
                </div>

                {areasLoading ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                    <Spin size="small" />
                  </div>
                ) : orgAreas.length === 0 ? (
                  <div style={{ padding: '16px', color: '#444', fontSize: 12, textAlign: 'center' }}>
                    No published survey areas for this office
                  </div>
                ) : (
                  orgAreas.map((area) => {
                    const isAreaSelected = selectedAreaId === area.id && selectedOrgId === currentOrg.id
                    return (
                      <div
                        key={area.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 16px', cursor: 'pointer',
                          background: isAreaSelected ? 'rgba(82,196,26,0.12)' : 'rgba(255,255,255,0.02)',
                          borderLeft: isAreaSelected ? '3px solid #52c41a' : '3px solid transparent',
                          borderBottom: '1px solid rgba(255,255,255,0.03)',
                          transition: 'all 0.12s',
                        }}
                        onClick={() => { onSelectArea(currentOrg, area); handleClose() }}
                      >
                        <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 12, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            color: isAreaSelected ? '#52c41a' : '#e0e0e0',
                            fontSize: 12, fontWeight: isAreaSelected ? 600 : 400,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {area.name}
                          </div>
                          {area.area_code && (
                            <div style={{ color: '#555', fontSize: 10 }}>{area.area_code}</div>
                          )}
                        </div>
                        <Tag
                          color="success"
                          style={{ fontSize: 10, padding: '0 5px', margin: 0, flexShrink: 0 }}
                        >
                          Published
                        </Tag>
                      </div>
                    )
                  })
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
