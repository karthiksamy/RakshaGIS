import { useState, useCallback } from 'react'
import {
  Upload, Card, Button, Space, Typography, Alert, Tag, Descriptions, Badge,
  Timeline, Spin, Steps, Divider, Row, Col, Tooltip, Progress,
} from 'antd'
import {
  InboxOutlined, SafetyCertificateOutlined, CheckCircleOutlined, WarningOutlined,
  CloseCircleOutlined, InfoCircleOutlined, AuditOutlined, FileProtectOutlined,
  ClockCircleOutlined, KeyOutlined, DatabaseOutlined, ReloadOutlined,
  BranchesOutlined,
} from '@ant-design/icons'
import { message } from 'antd'
import api from '@/services/api'

const { Title, Text, Paragraph } = Typography
const { Dragger } = Upload

// ── Type helpers ──────────────────────────────────────────────────────────────

interface VerifyResult {
  watermarked: boolean
  confidence: number
  verification_method: string
  metadata: Record<string, any>
  registry_verified: boolean
  registry_record: {
    dna_hash: string
    file_name: string
    project_id: number | null
    project_number: string | null
    generated_by: string
    generated_at: string
    file_hash: string
  } | null
  registry_hash_matched?: boolean
  // C2PA-specific — present when verification_method === 'c2pa_signed_manifest'
  c2pa?: {
    validation_state: string | null
    title: string | null
    claim_generator: { name: string; version: string }[] | null
    active_manifest: string | null
  }
  // legacy CLPW (if present)
  clpw?: {
    matched: boolean
    match_rate: number
    confidence: number
    total_checked: number
    matching_count: number
  } | null
}

type ScanState = 'idle' | 'scanning' | 'done'

// ── Sub-components ────────────────────────────────────────────────────────────

function MethodBadge({ method }: { method: string }) {
  if (method === 'c2pa_signed_manifest') {
    return (
      <Tag
        icon={<SafetyCertificateOutlined />}
        color="blue"
        style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6 }}
      >
        C2PA Signed Manifest  (X.509 / ES256)
      </Tag>
    )
  }
  if (method === 'structural_cryptographic_signature') {
    return (
      <Tag
        icon={<KeyOutlined />}
        color="purple"
        style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6 }}
      >
        Legacy Token (Fernet AES-128-CBC)
      </Tag>
    )
  }
  if (method === 'coordinate_lsb_perturbation') {
    return (
      <Tag
        icon={<BranchesOutlined />}
        color="geekblue"
        style={{ fontSize: 12, padding: '3px 10px', borderRadius: 6 }}
      >
        Coordinate LSB Perturbation (geometric)
      </Tag>
    )
  }
  return <Tag color="default">{method.replace(/_/g, ' ')}</Tag>
}

function C2paBlock({ c2pa }: { c2pa: NonNullable<VerifyResult['c2pa']> }) {
  const valid = c2pa.validation_state === 'Valid'
  const invalid = c2pa.validation_state === 'Invalid'
  return (
    <Card
      size="small"
      style={{ background: 'rgba(22,119,255,0.06)', border: '1px solid rgba(22,119,255,0.25)', borderRadius: 8 }}
      title={
        <Space>
          <SafetyCertificateOutlined style={{ color: '#1677ff' }} />
          <span style={{ color: '#4fc3f7', fontWeight: 600, fontSize: 13 }}>C2PA Signed Manifest</span>
          {valid && <Tag color="success" style={{ marginLeft: 4 }}>Valid</Tag>}
          {invalid && <Tag color="error" style={{ marginLeft: 4 }}>Invalid — content tampered</Tag>}
          {!valid && !invalid && c2pa.validation_state && (
            <Tag color="warning" style={{ marginLeft: 4 }}>{c2pa.validation_state}</Tag>
          )}
        </Space>
      }
    >
      <Descriptions
        column={1} size="small" bordered
        labelStyle={{ color: '#888', fontSize: 12, background: 'rgba(255,255,255,0.02)', width: 140 }}
        contentStyle={{ color: '#e8e8e8', fontSize: 12 }}
      >
        {c2pa.title && (
          <Descriptions.Item label="Asset Title">{c2pa.title}</Descriptions.Item>
        )}
        {c2pa.claim_generator && c2pa.claim_generator.length > 0 && (
          <Descriptions.Item label="Claim Generator">
            {c2pa.claim_generator.map((g) => `${g.name} ${g.version ?? ''}`.trim()).join(', ')}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="Manifest ID">
          <code style={{ fontSize: 10, color: '#1677ff' }}>{c2pa.active_manifest ?? '—'}</code>
        </Descriptions.Item>
        <Descriptions.Item label="Signing Algorithm">
          <Tag color="blue" style={{ fontSize: 11 }}>ES256 / EC P-256</Tag>
          <Tag color="cyan" style={{ fontSize: 11, marginLeft: 4 }}>X.509 Certificate</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Spec">
          <a href="https://c2pa.org" target="_blank" rel="noreferrer" style={{ color: '#1677ff', fontSize: 11 }}>
            Coalition for Content Provenance &amp; Authenticity (C2PA)
          </a>
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 10, fontSize: 11, color: '#888' }}>
        {valid ? (
          <><CheckCircleOutlined style={{ color: '#52c41a', marginRight: 6 }} />
            The file's content hash matches the embedded signature — no tampering detected since signing.</>
        ) : invalid ? (
          <><CloseCircleOutlined style={{ color: '#ff4d4f', marginRight: 6 }} />
            The content hash does not match the signature — the file was modified after signing.</>
        ) : (
          <><InfoCircleOutlined style={{ color: '#faad14', marginRight: 6 }} />
            Validation state: {c2pa.validation_state ?? 'unknown'}.</>
        )}
      </div>
    </Card>
  )
}

function LegacyBlock({ result }: { result: VerifyResult }) {
  const { metadata, clpw } = result
  return (
    <Card
      size="small"
      style={{ background: 'rgba(114,46,209,0.06)', border: '1px solid rgba(114,46,209,0.25)', borderRadius: 8 }}
      title={
        <Space>
          <KeyOutlined style={{ color: '#722ed1' }} />
          <span style={{ color: '#b37feb', fontWeight: 600, fontSize: 13 }}>
            Legacy Provenance Token
          </span>
          <Tooltip title="This file was signed with the in-house Fernet-based provenance scheme (pre-C2PA). Symmetric key — requires access to the platform secret to verify.">
            <InfoCircleOutlined style={{ color: '#888', fontSize: 12 }} />
          </Tooltip>
        </Space>
      }
    >
      <Descriptions
        column={1} size="small" bordered
        labelStyle={{ color: '#888', fontSize: 12, background: 'rgba(255,255,255,0.02)', width: 140 }}
        contentStyle={{ color: '#e8e8e8', fontSize: 12 }}
      >
        {metadata.source && (
          <Descriptions.Item label="Source System">
            <Badge status="processing" text={<span style={{ color: '#52c41a', fontWeight: 600 }}>{metadata.source}</span>} />
          </Descriptions.Item>
        )}
        {metadata.schema_generation && (
          <Descriptions.Item label="Schema">{metadata.schema_generation}</Descriptions.Item>
        )}
        {metadata.export_format && (
          <Descriptions.Item label="Export Format">
            <Tag color="cyan" style={{ margin: 0 }}>{metadata.export_format.toUpperCase()}</Tag>
          </Descriptions.Item>
        )}
        {(metadata.uploaded_by || metadata.generated_by) && (
          <Descriptions.Item label="Generated By">{metadata.uploaded_by ?? metadata.generated_by}</Descriptions.Item>
        )}
        {metadata.style && (
          <Descriptions.Item label="Map Style">{metadata.style}</Descriptions.Item>
        )}
        {(metadata.center_lon != null && metadata.center_lat != null) && (
          <Descriptions.Item label="Centre">
            {Number(metadata.center_lat).toFixed(5)}°, {Number(metadata.center_lon).toFixed(5)}°
          </Descriptions.Item>
        )}
        {metadata.zoom != null && (
          <Descriptions.Item label="Zoom">{metadata.zoom}</Descriptions.Item>
        )}
        {metadata.dna_hash && (
          <Descriptions.Item label="DNA Hash">
            <code style={{ fontSize: 10, color: '#1677ff' }}>{metadata.dna_hash.slice(0, 24)}…</code>
          </Descriptions.Item>
        )}
      </Descriptions>
      {clpw?.matched && (
        <div style={{ marginTop: 10, background: 'rgba(114,46,209,0.1)', borderRadius: 6, padding: 8 }}>
          <Text style={{ color: '#b37feb', fontSize: 12 }}>
            <BranchesOutlined style={{ marginRight: 6 }} />
            Coordinate LSB Perturbation matched — {clpw.matching_count}/{clpw.total_checked} vertices
            ({(clpw.match_rate * 100).toFixed(0)}%)
          </Text>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 11, color: '#888' }}>
        <InfoCircleOutlined style={{ marginRight: 4 }} />
        Symmetric cryptography — authenticity relies on server-side key secrecy, not a public certificate chain.
        Newer exports use the C2PA scheme above instead.
      </div>
    </Card>
  )
}

function MetadataBlock({ result }: { result: VerifyResult }) {
  const { metadata } = result
  const fields = [
    ['Project Number', metadata.project_number],
    ['Project ID',     metadata.project_id != null ? String(metadata.project_id) : null],
    ['Document Title', metadata.title],
    ['Document ID',    metadata.document_id != null ? String(metadata.document_id) : null],
  ].filter((f) => f[1])

  if (!fields.length) return null
  return (
    <Descriptions
      title={<span style={{ color: '#e8e8e8', fontSize: 13, fontWeight: 600 }}>Embedded Metadata</span>}
      column={2} size="small" bordered
      labelStyle={{ color: '#888', fontSize: 12, background: 'rgba(255,255,255,0.02)' }}
      contentStyle={{ color: '#e8e8e8', fontSize: 12 }}
    >
      {fields.map(([label, value]) => (
        <Descriptions.Item key={label!} label={label!}>{value}</Descriptions.Item>
      ))}
    </Descriptions>
  )
}

function RegistryBlock({ record }: { record: NonNullable<VerifyResult['registry_record']> }) {
  return (
    <Card
      size="small"
      style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8 }}
      title={
        <Space>
          <DatabaseOutlined style={{ color: '#52c41a' }} />
          <span style={{ color: '#e8e8e8', fontSize: 13, fontWeight: 600 }}>
            Trust Registry  <Tag color="success" style={{ marginLeft: 4 }}>Authenticated</Tag>
          </span>
        </Space>
      }
    >
      <Timeline
        mode="left"
        style={{ marginTop: 12 }}
        items={[
          {
            color: 'green',
            dot: <FileProtectOutlined style={{ fontSize: 14 }} />,
            children: (
              <div style={{ color: '#fff', fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Asset Exported / Generated</div>
                <div style={{ color: '#aaa' }}>{new Date(record.generated_at).toLocaleString()}</div>
                <div style={{ color: '#90b8d8' }}>
                  By user: <strong>{record.generated_by}</strong>
                </div>
                {record.project_number && (
                  <div style={{ color: '#888' }}>Project: <strong>{record.project_number}</strong></div>
                )}
              </div>
            ),
          },
          {
            color: 'blue',
            dot: <KeyOutlined style={{ fontSize: 14 }} />,
            children: (
              <div style={{ color: '#fff', fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>DNA Cryptographic Seal Applied</div>
                <div style={{ color: '#aaa' }}>
                  DNA:&nbsp;
                  <code style={{ fontSize: 10, color: '#1677ff' }}>{record.dna_hash.slice(0, 20)}…</code>
                </div>
                {record.file_hash && (
                  <div style={{ color: '#aaa' }}>
                    File SHA-256:&nbsp;
                    <code style={{ fontSize: 10, color: '#722ed1' }}>{record.file_hash.slice(0, 20)}…</code>
                  </div>
                )}
              </div>
            ),
          },
          {
            color: 'gold',
            dot: <CheckCircleOutlined style={{ fontSize: 14 }} />,
            children: (
              <div style={{ color: '#fff', fontSize: 11 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Verified Now</div>
                <div style={{ color: '#aaa' }}>{new Date().toLocaleString()}</div>
                <div style={{ color: '#52c41a', fontWeight: 600 }}>
                  Registry record confirmed · Origin authentic
                </div>
              </div>
            ),
          },
        ]}
      />
    </Card>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProvenanceVerifyPage() {
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [fileName, setFileName] = useState<string>('')

  const runVerify = useCallback(async (file: File) => {
    setFileName(file.name)
    setScanState('scanning')
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post('/documents/verify-watermark/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setResult(res.data)
      if (res.data.watermarked) {
        message.success('Provenance verified.')
      } else {
        message.warning('No provenance watermark found.')
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'Verification failed.')
    } finally {
      setScanState('done')
    }
  }, [])

  const reset = () => { setScanState('idle'); setResult(null); setFileName('') }

  const draggerProps = {
    name: 'file',
    multiple: false,
    showUploadList: false,
    disabled: scanState === 'scanning',
    customRequest: ({ file }: any) => runVerify(file as File),
    accept: '.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp,.docx,.xlsx,.pptx,.zip,.geojson,.json,.kml,.gpkg,.csv,.txt',
  }

  const isC2pa = result?.verification_method === 'c2pa_signed_manifest'
  const isLegacy = result?.watermarked && !isC2pa

  // Steps state
  const currentStep = scanState === 'idle' ? 0 : scanState === 'scanning' ? 1 : 2

  return (
    <div style={{
      minHeight: '100%', background: '#0a0a1a', padding: '24px 32px',
      display: 'flex', flexDirection: 'column', gap: 24,
    }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <Space align="center" style={{ marginBottom: 4 }}>
            <SafetyCertificateOutlined style={{ fontSize: 28, color: '#1677ff' }} />
            <Title level={3} style={{ margin: 0, color: '#e8e8e8' }}>
              Provenance &amp; Authenticity Verification
            </Title>
          </Space>
          <Paragraph style={{ color: '#888', margin: 0, fontSize: 13 }}>
            Verify the digital provenance of any file exported from RakshaGIS / DEMAP.
            Checks both signed&nbsp;<strong style={{ color: '#4fc3f7' }}>C2PA manifests</strong> (PNG, JPEG, TIFF, WebP)
            and the <strong style={{ color: '#b37feb' }}>legacy cryptographic token</strong> (PDF, DOCX, GeoJSON, KML, CSV, Shapefile, GPKG, etc.)
          </Paragraph>
        </div>
        {result && (
          <Button icon={<ReloadOutlined />} onClick={reset} size="small">
            Verify another
          </Button>
        )}
      </div>

      {/* Progress steps */}
      <Steps
        current={currentStep}
        size="small"
        style={{ maxWidth: 600 }}
        items={[
          { title: 'Upload', icon: <InboxOutlined /> },
          { title: 'Scanning', icon: scanState === 'scanning' ? <Spin indicator={<ClockCircleOutlined />} size="small" /> : <ClockCircleOutlined /> },
          { title: 'Result', icon: result ? (result.watermarked ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <WarningOutlined style={{ color: '#faad14' }} />) : <AuditOutlined /> },
        ]}
      />

      {/* Upload area — shown while idle or after a reset */}
      {scanState !== 'done' && (
        <Row gutter={24}>
          <Col xs={24} lg={16}>
            <Dragger
              {...draggerProps}
              style={{
                background: 'rgba(22,119,255,0.04)',
                border: `2px dashed ${scanState === 'scanning' ? '#1677ff' : 'rgba(255,255,255,0.15)'}`,
                borderRadius: 12,
                padding: '16px 0',
              }}
            >
              <p className="ant-upload-drag-icon">
                {scanState === 'scanning'
                  ? <Spin size="large" />
                  : <SafetyCertificateOutlined style={{ fontSize: 48, color: '#1677ff', opacity: 0.7 }} />}
              </p>
              <p style={{ color: '#e8e8e8', fontSize: 14, fontWeight: 500, margin: '8px 0 4px' }}>
                {scanState === 'scanning'
                  ? `Scanning "${fileName}"…`
                  : 'Click or drag a file here to verify its provenance'}
              </p>
              <p style={{ color: '#666', fontSize: 11, margin: 0 }}>
                PNG · JPEG · TIFF · WebP → C2PA manifest check
              </p>
              <p style={{ color: '#555', fontSize: 11, margin: 0 }}>
                PDF · DOCX · XLSX · ZIP · GeoJSON · KML · GPKG · CSV → legacy token check
              </p>
              <p style={{ color: '#444', fontSize: 11, margin: 0 }}>Max 100 MB</p>
            </Dragger>
          </Col>
          <Col xs={24} lg={8}>
            <Card
              size="small"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, height: '100%' }}
              title={<span style={{ color: '#aaa', fontSize: 12 }}>What this checks</span>}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <Tag icon={<SafetyCertificateOutlined />} color="blue" style={{ marginBottom: 4 }}>C2PA</Tag>
                  <div style={{ color: '#aaa', fontSize: 11 }}>
                    Signed X.509 manifest (ES256). Content-bound — any modification after signing is detectable. Readable by any C2PA-compliant tool.
                  </div>
                </div>
                <Divider style={{ borderColor: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
                <div>
                  <Tag icon={<KeyOutlined />} color="purple" style={{ marginBottom: 4 }}>Legacy Token</Tag>
                  <div style={{ color: '#aaa', fontSize: 11 }}>
                    Fernet-encrypted JSON token embedded in file metadata/comments. Requires platform secret to verify. Used for PDF, DOCX, GeoJSON, CSV, and other formats.
                  </div>
                </div>
                <Divider style={{ borderColor: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
                <div>
                  <Tag icon={<DatabaseOutlined />} color="green" style={{ marginBottom: 4 }}>Trust Registry</Tag>
                  <div style={{ color: '#aaa', fontSize: 11 }}>
                    Each export is logged server-side with a SHA-256 file hash, DNA hash, user, timestamp, and project. Registry lookup confirms the file was genuinely produced by this platform.
                  </div>
                </div>
              </div>
            </Card>
          </Col>
        </Row>
      )}

      {/* Results */}
      {scanState === 'done' && result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Verdict banner ── */}
          {result.watermarked ? (
            <Alert
              showIcon
              icon={<CheckCircleOutlined style={{ fontSize: 22, color: '#52c41a' }} />}
              type="success"
              style={{ background: 'rgba(82,196,26,0.08)', border: '1px solid rgba(82,196,26,0.25)', borderRadius: 10 }}
              message={
                <Space wrap>
                  <span style={{ fontWeight: 700, fontSize: 16, color: '#52c41a' }}>
                    Verified — RakshaGIS / DEMAP Origin Confirmed
                  </span>
                  {result.registry_verified
                    ? <Tag color="success">Trust Registry Authenticated</Tag>
                    : <Tag color="warning">Cryptographic Match — Registry record absent</Tag>}
                  <MethodBadge method={result.verification_method} />
                </Space>
              }
              description={
                <Space direction="vertical" size={4}>
                  <Text style={{ color: '#aaa', fontSize: 12 }}>
                    File: <strong style={{ color: '#e8e8e8' }}>{fileName}</strong>
                  </Text>
                  <Space>
                    <Text style={{ color: '#aaa', fontSize: 12 }}>Confidence:</Text>
                    <Progress
                      percent={Math.round(result.confidence * 100)}
                      size="small"
                      strokeColor={result.confidence > 0.9 ? '#52c41a' : '#faad14'}
                      style={{ width: 140, marginBottom: 0 }}
                    />
                    <Text style={{ color: result.confidence > 0.9 ? '#52c41a' : '#faad14', fontWeight: 600, fontSize: 12 }}>
                      {(result.confidence * 100).toFixed(1)}%
                    </Text>
                  </Space>
                </Space>
              }
            />
          ) : (
            <Alert
              showIcon
              icon={<WarningOutlined style={{ fontSize: 22, color: '#faad14' }} />}
              type="warning"
              style={{ background: 'rgba(250,173,20,0.08)', border: '1px solid rgba(250,173,20,0.25)', borderRadius: 10 }}
              message={<span style={{ fontWeight: 700, fontSize: 16, color: '#faad14' }}>No Provenance Found</span>}
              description={
                <div style={{ color: '#aaa', fontSize: 13 }}>
                  <p style={{ margin: '4px 0' }}>File: <strong style={{ color: '#e8e8e8' }}>{fileName}</strong></p>
                  <p style={{ margin: '4px 0' }}>
                    This file does not contain a C2PA manifest or a RakshaGIS provenance token.
                    It may have been exported from a different system, or the watermark may have been
                    stripped by a re-encode or format conversion.
                  </p>
                  {/\.(docx|xlsx|pptx)$/i.test(fileName) && (
                    <p style={{ margin: '8px 0 0', color: '#faad14', fontSize: 12 }}>
                      <strong>Word/Excel/PowerPoint files:</strong> If you downloaded this file using the
                      <em> Download</em> button inside the OnlyOffice editor, the provenance token may have
                      been stripped during re-export. To get a verified copy, download the file from
                      the <strong>Documents</strong> list in RakshaGIS instead — that copy retains the
                      provenance embedded in the document's custom properties.
                    </p>
                  )}
                </div>
              }
            />
          )}

          {/* ── Detail grid ── */}
          {result.watermarked && (
            <Row gutter={[20, 20]}>
              {/* Left column: method-specific + metadata */}
              <Col xs={24} lg={14}>
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {/* C2PA detail */}
                  {isC2pa && result.c2pa && <C2paBlock c2pa={result.c2pa} />}

                  {/* Legacy token detail */}
                  {isLegacy && <LegacyBlock result={result} />}

                  {/* Embedded metadata */}
                  <MetadataBlock result={result} />

                  {/* C2PA state for tampered files */}
                  {isC2pa && result.c2pa?.validation_state === 'Invalid' && (
                    <Alert
                      type="error"
                      showIcon
                      icon={<CloseCircleOutlined />}
                      message="Content Integrity Failure"
                      description="The C2PA manifest is present but the content hash does not match the signature. The file has been modified after signing — it is NOT authentic."
                      style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.3)' }}
                    />
                  )}

                  {/* Legacy state for tampered files */}
                  {isLegacy && result.registry_record && !result.registry_hash_matched && (
                    <Alert
                      type="error"
                      showIcon
                      icon={<CloseCircleOutlined />}
                      message="Content Integrity Failure"
                      description="A Trust Registry record was found for this seal, but the uploaded file's hash does not match the registered hash. The file has been modified since it was exported from RakshaGIS — it is NOT authentic."
                      style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.3)' }}
                    />
                  )}
                </Space>
              </Col>

              {/* Right column: registry + comparison */}
              <Col xs={24} lg={10}>
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {result.registry_record ? (
                    <RegistryBlock record={result.registry_record} />
                  ) : (
                    <Card
                      size="small"
                      style={{ background: 'rgba(250,173,20,0.05)', border: '1px solid rgba(250,173,20,0.2)', borderRadius: 8 }}
                    >
                      <Space>
                        <WarningOutlined style={{ color: '#faad14' }} />
                        <Text style={{ color: '#aaa', fontSize: 12 }}>
                          Cryptographic token verified but no matching Trust Registry record found.
                          The file may have been watermarked before registry logging was enabled,
                          or the registry was cleared.
                        </Text>
                      </Space>
                    </Card>
                  )}

                  {/* Method explanation */}
                  <Card
                    size="small"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8 }}
                    title={<span style={{ color: '#aaa', fontSize: 12 }}>Verification Method Detail</span>}
                  >
                    <Descriptions column={1} size="small"
                      labelStyle={{ color: '#666', fontSize: 11 }}
                      contentStyle={{ color: '#ccc', fontSize: 11 }}
                    >
                      <Descriptions.Item label="Method">
                        <MethodBadge method={result.verification_method} />
                      </Descriptions.Item>
                      <Descriptions.Item label="Confidence">
                        <span style={{ color: result.confidence > 0.9 ? '#52c41a' : '#faad14', fontWeight: 600 }}>
                           {(result.confidence * 100).toFixed(1)}%
                        </span>
                      </Descriptions.Item>
                      <Descriptions.Item label="Standard">
                        {isC2pa
                          ? 'C2PA 2.x (ISO/IEC DIS 19566-8 — Coalition for Content Provenance and Authenticity)'
                          : 'RakshaGIS LP-DNA v2 (proprietary — symmetric Fernet / HMAC-SHA256)'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Content-bound">
                        {isC2pa ? (
                          <Tag color="success">Yes — hash embedded in manifest</Tag>
                        ) : result.registry_verified && result.registry_hash_matched ? (
                          <Tag color="success">Yes — verified via registry file hash matching</Tag>
                        ) : (
                          <Tag color="warning">No — token rides in metadata/comments</Tag>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="Public verifiability">
                        {isC2pa
                          ? <Tag color="success">Yes — c2patool, Adobe CAI, etc.</Tag>
                          : <Tag color="default">No — requires platform secret key</Tag>}
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                </Space>
              </Col>
            </Row>
          )}
        </div>
      )}
    </div>
  )
}
