import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ReadingProviderBookControls from '../ReadingProviderBookControls.vue'
import { providerApi } from '../../api/reading-provider.api'
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn<() => boolean>(() => true) }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission }) }))
vi.mock('../../api/reading-provider.api', () => ({
  providerApi: {
    settings: vi.fn<typeof providerApi.settings>(),
    book: vi.fn<typeof providerApi.book>(),
    exclude: vi.fn<typeof providerApi.exclude>(),
    syncBook: vi.fn<typeof providerApi.syncBook>(),
    link: vi.fn<typeof providerApi.link>(),
    candidates: vi.fn<typeof providerApi.candidates>(),
  },
}))
const state: Awaited<ReturnType<typeof providerApi.book>> = {
  bookId: 3,
  title: 'Book',
  excluded: false,
  remoteId: null,
  remoteUrl: null,
  matchMethod: null,
  lastSyncedAt: null,
  error: null,
  warning: null,
  pending: false,
}
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  vi.mocked(providerApi.settings).mockResolvedValue({
    provider: 'pagebound',
    connected: true,
    enabled: true,
    reconnectRequired: false,
    encryptionConfigured: true,
    accountId: 'fixture',
    lastSyncedAt: null,
    error: null,
    capabilities: { progress: true, ratings: false, readingDates: true, limitations: [] },
  })
  vi.mocked(providerApi.book).mockResolvedValue(state)
  vi.mocked(providerApi.exclude).mockResolvedValue({ ...state, excluded: true })
  vi.mocked(providerApi.syncBook).mockResolvedValue({ ...state, pending: true })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
describe('per-book provider controls', () => {
  it('supports exclusions without immediately synchronizing or changing links', async () => {
    wrapper = mount(ReadingProviderBookControls, { props: { provider: 'pagebound', bookId: 3 } })
    await flushPromises()
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(providerApi.exclude).toHaveBeenCalledWith('pagebound', 3, true)
    expect(providerApi.syncBook).not.toHaveBeenCalled()
    expect(providerApi.link).not.toHaveBeenCalled()
  })
  it('queues an individual book explicitly', async () => {
    wrapper = mount(ReadingProviderBookControls, { props: { provider: 'pagebound', bookId: 3 } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Sync now')!
      .trigger('click')
    await flushPromises()
    expect(providerApi.syncBook).toHaveBeenCalledWith('pagebound', 3)
  })
  it('shows match failures and preserved-progress warnings', async () => {
    vi.mocked(providerApi.book).mockResolvedValue({ ...state, error: 'Ambiguous edition', warning: 'Remote progress is ahead' })
    wrapper = mount(ReadingProviderBookControls, { props: { provider: 'pagebound', bookId: 3 } })
    await flushPromises()
    expect(wrapper.text()).toContain('Ambiguous edition')
    expect(wrapper.text()).toContain('Remote progress is ahead')
  })
  it('searches candidates and requires explicit selection and saving before relinking', async () => {
    const candidate = {
      id: '42',
      resourceId: 'exact-edition',
      title: 'Exact Edition',
      authors: ['Author'],
      isbn: '9781234567890',
      pages: 400,
      url: 'https://pagebound.co/books/exact-edition',
    }
    vi.mocked(providerApi.candidates).mockResolvedValue([candidate])
    wrapper = mount(ReadingProviderBookControls, { props: { provider: 'pagebound', bookId: 3 } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Manage book link')!
      .trigger('click')
    await wrapper.get('input[placeholder="Title and author"]').setValue('Exact Edition Author')
    await wrapper.findAll('form')[0]!.trigger('submit')
    await flushPromises()
    expect(providerApi.candidates).toHaveBeenCalledWith('pagebound', 3, 'Exact Edition Author')
    expect(providerApi.link).not.toHaveBeenCalled()
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Exact Edition'))!
      .trigger('click')
    expect(providerApi.link).not.toHaveBeenCalled()
    await wrapper.findAll('form')[1]!.trigger('submit')
    await flushPromises()
    expect(providerApi.link).toHaveBeenCalledWith('pagebound', 3, 'exact-edition')
    expect(providerApi.syncBook).not.toHaveBeenCalled()
  })
  it('ignores a previous book response after navigation', async () => {
    let resolveOld!: (value: typeof state) => void
    vi.mocked(providerApi.book).mockImplementation((_provider, id) =>
      id === 3
        ? new Promise((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve({ ...state, bookId: 4, warning: 'Current book warning' }),
    )
    wrapper = mount(ReadingProviderBookControls, { props: { provider: 'pagebound', bookId: 3 } })
    await wrapper.setProps({ bookId: 4 })
    await flushPromises()
    resolveOld({ ...state, warning: 'Old book warning' })
    await flushPromises()
    expect(wrapper.text()).toContain('Current book warning')
    expect(wrapper.text()).not.toContain('Old book warning')
  })
})
