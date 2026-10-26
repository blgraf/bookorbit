import { computed, onMounted, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  Permission,
  type ReadingProvider,
  type ReadingProviderBook,
  type ReadingProviderSettings,
  type ReadingProviderSummary,
} from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { providerApi } from '../api/reading-provider.api'

export const providerPermissions = { goodreads: Permission.GoodreadsSync, pagebound: Permission.PageboundSync }
export function useReadingProvider(provider: MaybeRefOrGetter<ReadingProvider>) {
  const { hasPermission } = usePermissions()
  const canUse = computed(() => hasPermission(providerPermissions[toValue(provider)]))
  const settings = ref<ReadingProviderSettings | null>(null)
  const summary = ref<ReadingProviderSummary | null>(null)
  const books = ref<ReadingProviderBook[]>([])
  const email = ref('')
  const password = ref('')
  const cookies = ref('')
  const error = ref<string | null>(null)
  const busy = ref(false)
  const after = ref(0)
  const previousPages = ref<number[]>([])
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let disposed = false
  async function refresh() {
    if (!canUse.value || polling || disposed) return
    polling = true
    try {
      const current = toValue(provider)
      const [nextSettings, nextSummary, nextBooks] = await Promise.all([
        providerApi.settings(current),
        providerApi.summary(current),
        providerApi.books(current, after.value),
      ])
      if (disposed || current !== toValue(provider)) return
      settings.value = nextSettings
      summary.value = nextSummary
      books.value = nextBooks
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : 'Provider request failed'
    } finally {
      polling = false
    }
  }
  async function action(operation: () => Promise<unknown>) {
    if (busy.value || !canUse.value) return
    busy.value = true
    error.value = null
    try {
      await operation()
      await refresh()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Provider request failed'
    } finally {
      busy.value = false
      password.value = ''
      cookies.value = ''
    }
  }
  const connect = () =>
    action(() =>
      providerApi.connect(
        toValue(provider),
        toValue(provider) === 'pagebound' ? { email: email.value, password: password.value } : { cookies: cookies.value },
      ),
    )
  const validate = () => action(() => providerApi.validate(toValue(provider)))
  const disconnect = () => action(() => providerApi.disconnect(toValue(provider)))
  const setEnabled = (enabled: boolean) => action(() => providerApi.enabled(toValue(provider), enabled))
  const syncAll = () => action(() => providerApi.syncAll(toValue(provider)))
  const cancel = () => action(() => providerApi.cancel(toValue(provider)))
  async function nextPage() {
    const last = books.value.at(-1)
    if (!last) return
    previousPages.value.push(after.value)
    after.value = last.bookId
    await refresh()
  }
  async function previousPage() {
    after.value = previousPages.value.pop() ?? 0
    await refresh()
  }
  watch(
    () => toValue(provider),
    () => {
      settings.value = null
      summary.value = null
      books.value = []
      email.value = ''
      password.value = ''
      cookies.value = ''
      error.value = null
      after.value = 0
      previousPages.value = []
      void refresh()
    },
  )
  onMounted(() => {
    void refresh()
    timer = setInterval(() => {
      void refresh()
    }, 5000)
  })
  onUnmounted(() => {
    disposed = true
    if (timer) clearInterval(timer)
    password.value = ''
    cookies.value = ''
  })
  return {
    canUse,
    settings,
    summary,
    books,
    email,
    password,
    cookies,
    error,
    busy,
    previousPages,
    refresh,
    connect,
    validate,
    disconnect,
    setEnabled,
    syncAll,
    cancel,
    nextPage,
    previousPage,
  }
}
