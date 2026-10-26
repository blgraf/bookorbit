import { api } from '@/lib/api'
import type {
  ReadingProvider,
  ReadingProviderBook,
  ReadingProviderCandidate,
  ReadingProviderConnectPayload,
  ReadingProviderSettings,
  ReadingProviderSummary,
} from '@bookorbit/types'

async function request<T>(provider: ReadingProvider, path: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await api(`/api/v1/${provider}${path}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string }
    throw new Error(typeof data.message === 'string' ? data.message : 'Provider request failed')
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T
  const text = await response.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
}
export const providerApi = {
  settings: (provider: ReadingProvider) => request<ReadingProviderSettings>(provider, '/settings'),
  connect: (provider: ReadingProvider, payload: ReadingProviderConnectPayload) =>
    request<ReadingProviderSettings>(provider, '/connect', 'POST', payload),
  validate: (provider: ReadingProvider) => request<ReadingProviderSettings>(provider, '/validate', 'POST'),
  enabled: (provider: ReadingProvider, enabled: boolean) => request<ReadingProviderSettings>(provider, '/settings', 'PATCH', { enabled }),
  disconnect: (provider: ReadingProvider) => request<void>(provider, '/settings', 'DELETE'),
  syncAll: (provider: ReadingProvider) => request<ReadingProviderSummary>(provider, '/sync', 'POST'),
  cancel: (provider: ReadingProvider) => request<ReadingProviderSummary>(provider, '/sync', 'DELETE'),
  summary: (provider: ReadingProvider) => request<ReadingProviderSummary>(provider, '/sync/status'),
  books: (provider: ReadingProvider, after = 0) => request<ReadingProviderBook[]>(provider, `/books?after=${after}`),
  book: (provider: ReadingProvider, id: number) => request<ReadingProviderBook>(provider, `/books/${id}`),
  exclude: (provider: ReadingProvider, id: number, excluded: boolean) =>
    request<ReadingProviderBook>(provider, `/books/${id}`, 'PATCH', { excluded }),
  syncBook: (provider: ReadingProvider, id: number) => request<ReadingProviderBook>(provider, `/books/${id}/sync`, 'POST'),
  link: (provider: ReadingProvider, id: number, resourceId: string) =>
    request<ReadingProviderBook>(provider, `/books/${id}/link`, 'PATCH', { resourceId }),
  candidates: (provider: ReadingProvider, id: number, query: string) =>
    request<ReadingProviderCandidate[]>(provider, `/books/${id}/candidates?q=${encodeURIComponent(query)}`),
}
