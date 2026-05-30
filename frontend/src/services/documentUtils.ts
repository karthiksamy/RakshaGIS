import { message } from 'antd'
import api from './api'

/**
 * Opens a document in OnlyOffice editor in a new browser tab.
 *
 * Navigates to /api/documents/{id}/embed/?token=<jwt> — a Django-rendered HTML
 * page that initialises DocsAPI.DocEditor in the browser. The JWT is passed in
 * the query string because a window.open() tab cannot send a Bearer header.
 *
 * The document.url inside the editor config is an internal Docker URL
 * (http://nginx/media/...) used SERVER-SIDE by the OnlyOffice container to fetch
 * the file — the browser never navigates to that URL.
 */
export function openDocumentInNewTab(docId: number): void {
  const token = localStorage.getItem('access_token')
  if (!token) {
    message.error('Your session has expired. Please sign in again.')
    return
  }
  const url = `/api/documents/${docId}/embed/?token=${encodeURIComponent(token)}`
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Force-refreshes the access token, then opens the document. Use when the
 * cached token may be stale (the embed page can't transparently refresh).
 */
export async function openDocumentFresh(docId: number): Promise<void> {
  try {
    // A lightweight authenticated call triggers the api interceptor's refresh
    // logic if the current token is expired, updating localStorage.
    await api.get(`/documents/${docId}/`)
  } catch {
    /* interceptor handles 401 → refresh; ignore errors here */
  }
  openDocumentInNewTab(docId)
}
