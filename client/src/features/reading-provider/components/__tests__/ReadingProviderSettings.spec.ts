import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ReadingProviderSettings from '../ReadingProviderSettings.vue'
import { providerApi } from '../../api/reading-provider.api'
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn<() => boolean>(() => true) }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission }) }))
vi.mock('../../api/reading-provider.api', () => ({
  providerApi: {
    settings: vi.fn<typeof providerApi.settings>(),
    summary: vi.fn<typeof providerApi.summary>(),
    books: vi.fn<typeof providerApi.books>(),
    connect: vi.fn<typeof providerApi.connect>(),
    validate: vi.fn<typeof providerApi.validate>(),
    enabled: vi.fn<typeof providerApi.enabled>(),
    disconnect: vi.fn<typeof providerApi.disconnect>(),
    syncAll: vi.fn<typeof providerApi.syncAll>(),
    cancel: vi.fn<typeof providerApi.cancel>(),
  },
}))
const settings: Awaited<ReturnType<typeof providerApi.settings>> = {
  provider: 'pagebound',
  connected: true,
  enabled: false,
  reconnectRequired: false,
  encryptionConfigured: true,
  accountId: 'fixture-account',
  lastSyncedAt: null,
  error: null,
  capabilities: { progress: true, ratings: false, readingDates: true, limitations: ['Ratings require manual entry.'] },
}
let wrapper: VueWrapper | undefined
beforeEach(() => {
  vi.clearAllMocks()
  hasPermission.mockReturnValue(true)
  vi.mocked(providerApi.settings).mockResolvedValue(settings as Awaited<ReturnType<typeof providerApi.settings>>)
  vi.mocked(providerApi.summary).mockResolvedValue({ pending: 0, failed: 0, synced: 0, bulkActive: false })
  vi.mocked(providerApi.books).mockResolvedValue([])
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})
describe('provider settings controls', () => {
  it('shows connection state, provider limitations, and explicit enablement without automatically starting a bulk sync', async () => {
    wrapper = mount(ReadingProviderSettings, { props: { provider: 'pagebound' } })
    await flushPromises()
    expect(wrapper.text()).toContain('fixture-account')
    expect(wrapper.text()).toContain('Ratings require manual entry')
    expect(wrapper.get('[role="switch"]').attributes('aria-checked')).toBe('false')
    expect(providerApi.syncAll).not.toHaveBeenCalled()
    await wrapper.get('[role="switch"]').trigger('click')
    await flushPromises()
    expect(providerApi.enabled).toHaveBeenCalledWith('pagebound', true)
    expect(providerApi.syncAll).not.toHaveBeenCalled()
  })
  it('uses password only for connecting and clears it afterward', async () => {
    wrapper = mount(ReadingProviderSettings, { props: { provider: 'pagebound' } })
    await flushPromises()
    await wrapper.get('#pagebound-email').setValue('test@example.com')
    await wrapper.get('#pagebound-password').setValue('test-password')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(providerApi.connect).toHaveBeenCalledWith('pagebound', { email: 'test@example.com', password: 'test-password' })
    expect((wrapper.get('#pagebound-password').element as HTMLInputElement).value).toBe('')
  })
  it('shows Goodreads cookie reconnection guidance and clears pasted cookies on failed connection', async () => {
    vi.mocked(providerApi.settings).mockResolvedValue({ ...settings, provider: 'goodreads', reconnectRequired: true })
    vi.mocked(providerApi.connect).mockRejectedValue(new Error('Session expired. Reconnect.'))
    wrapper = mount(ReadingProviderSettings, { props: { provider: 'goodreads' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Cookie request-header')
    expect(wrapper.text()).toContain('Reconnect')
    await wrapper.get('#goodreads-cookies').setValue('test=session')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(providerApi.connect).toHaveBeenCalledWith('goodreads', { cookies: 'test=session' })
    expect((wrapper.get('#goodreads-cookies').element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.text()).toContain('Session expired')
  })
  it('does not fetch or render a provider for a user without its permission', async () => {
    hasPermission.mockReturnValue(false)
    wrapper = mount(ReadingProviderSettings, { props: { provider: 'pagebound' } })
    await flushPromises()
    expect(providerApi.settings).not.toHaveBeenCalled()
    expect(wrapper.find('form').exists()).toBe(false)
  })
  it('starts bulk sync only through its explicit action', async () => {
    vi.mocked(providerApi.settings).mockResolvedValue({ ...settings, enabled: true })
    wrapper = mount(ReadingProviderSettings, { props: { provider: 'pagebound' } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Sync all eligible books')!
      .trigger('click')
    await flushPromises()
    expect(providerApi.syncAll).toHaveBeenCalledExactlyOnceWith('pagebound')
  })
})
