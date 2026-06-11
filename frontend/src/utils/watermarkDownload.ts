import api from '@/services/api'

/**
 * Send a client-generated export through the backend LP-DNA/C2PA watermark
 * service (/core/watermark-file/), then trigger the browser download.
 * Throws if watermarking fails — exports must carry provenance.
 */
export async function watermarkAndDownload(
  data: Blob | string,
  filename: string,
  mime: string,
): Promise<void> {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data
  const fd = new FormData()
  fd.append('file', blob, filename)
  const res = await api.post('/core/watermark-file/', fd, {
    responseType: 'blob',
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
