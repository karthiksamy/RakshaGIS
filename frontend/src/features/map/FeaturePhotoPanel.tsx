import { useState } from 'react'
import { Upload, Button, Image, Spin, Popconfirm, Input, Typography, Empty } from 'antd'
import { CameraOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '@/services/api'

const { Text } = Typography

interface Attachment {
  id: number
  file: string
  file_url: string | null
  original_filename: string
  file_size: number
  file_type: string
  caption: string
  uploaded_by_name: string
  uploaded_at: string
}

interface Props {
  featureId: number
}

export default function FeaturePhotoPanel({ featureId }: Props) {
  const qc = useQueryClient()
  const [caption, setCaption] = useState('')
  const [uploading, setUploading] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  const { data, isLoading } = useQuery<Attachment[]>({
    queryKey: ['feature-attachments', featureId],
    queryFn: () =>
      api.get(`/projects/attachments/?feature=${featureId}`).then(r => r.data.results ?? r.data),
  })

  const photos = (data ?? []).filter(a => a.file_type === 'image')
  const docs = (data ?? []).filter(a => a.file_type !== 'image')

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('feature', String(featureId))
      if (caption.trim()) fd.append('caption', caption.trim())
      await api.post('/projects/attachments/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setCaption('')
      qc.invalidateQueries({ queryKey: ['feature-attachments', featureId] })
    } finally {
      setUploading(false)
    }
    return false
  }

  async function handleDelete(id: number) {
    await api.delete(`/projects/attachments/${id}/`)
    qc.invalidateQueries({ queryKey: ['feature-attachments', featureId] })
  }

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ color: '#666', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        <CameraOutlined style={{ marginRight: 4 }} />Photos &amp; Attachments
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '12px 0' }}><Spin size="small" /></div>
      ) : (
        <>
          {/* Photo thumbnails */}
          {photos.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              <Image.PreviewGroup>
                {photos.map(att => (
                  <div key={att.id} style={{ position: 'relative' }}>
                    <Image
                      src={att.file_url || att.file}
                      width={72} height={72}
                      style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #333' }}
                      preview={{ src: att.file_url || att.file }}
                    />
                    <Popconfirm title="Delete photo?" onConfirm={() => handleDelete(att.id)} okType="danger">
                      <Button
                        size="small" type="text" danger icon={<DeleteOutlined style={{ fontSize: 10 }} />}
                        style={{
                          position: 'absolute', top: 2, right: 2,
                          background: 'rgba(0,0,0,0.6)', padding: '0 3px', minWidth: 0, height: 18,
                        }}
                      />
                    </Popconfirm>
                    {att.caption && (
                      <div style={{ fontSize: 9, color: '#888', marginTop: 2, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {att.caption}
                      </div>
                    )}
                  </div>
                ))}
              </Image.PreviewGroup>
            </div>
          )}

          {/* Non-image attachments */}
          {docs.map(att => (
            <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, background: '#242424', borderRadius: 4, padding: '4px 8px' }}>
              <Text style={{ color: '#aaa', fontSize: 11, flex: 1 }} ellipsis>{att.original_filename}</Text>
              <Text style={{ color: '#555', fontSize: 10 }}>{(att.file_size / 1024).toFixed(0)} KB</Text>
              <Popconfirm title="Delete?" onConfirm={() => handleDelete(att.id)} okType="danger">
                <Button size="small" type="text" danger icon={<DeleteOutlined style={{ fontSize: 10 }} />} style={{ minWidth: 0 }} />
              </Popconfirm>
            </div>
          ))}

          {photos.length === 0 && docs.length === 0 && (
            <Empty description={<span style={{ color: '#555', fontSize: 11 }}>No attachments</span>} imageStyle={{ height: 28 }} style={{ margin: '4px 0 8px' }} />
          )}

          {/* Upload row */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
            <Input
              size="small" placeholder="Caption (optional)" value={caption}
              onChange={e => setCaption(e.target.value)}
              style={{ flex: 1, background: '#1a1a1a', borderColor: '#333', color: '#ccc', fontSize: 11 }}
            />
            <Upload
              accept="image/*,application/pdf,.doc,.docx"
              showUploadList={false}
              beforeUpload={handleUpload}
            >
              <Button
                size="small" icon={<PlusOutlined />} loading={uploading}
                style={{ background: '#1a2a3a', borderColor: '#1890ff', color: '#4fc3f7', fontSize: 11 }}
              >
                Attach
              </Button>
            </Upload>
          </div>
        </>
      )}
    </div>
  )
}
