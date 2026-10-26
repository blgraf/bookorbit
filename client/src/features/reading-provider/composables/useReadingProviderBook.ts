import { computed, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { ReadingProvider, ReadingProviderBook, ReadingProviderCandidate, ReadingProviderSettings } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { providerApi } from '../api/reading-provider.api'
import { providerPermissions } from './useReadingProvider'

export function useReadingProviderBook(provider: MaybeRefOrGetter<ReadingProvider>, bookId: MaybeRefOrGetter<number>) {
  const { hasPermission } = usePermissions()
  const permitted = computed(() => hasPermission(providerPermissions[toValue(provider)]))
  const settings = ref<ReadingProviderSettings | null>(null)
  const state = ref<ReadingProviderBook | null>(null)
  const candidates = ref<ReadingProviderCandidate[]>([])
  const query = ref('')
  const resourceId = ref('')
  const error = ref<string | null>(null)
  const busy = ref(false)
  let generation = 0
  let timer: ReturnType<typeof setInterval> | undefined
  async function refresh() {
    const version = ++generation
    if (!permitted.value) {
      state.value = null
      settings.value = null
      return
    }
    try {
      const [nextSettings, nextState] = await Promise.all([
        providerApi.settings(toValue(provider)),
        providerApi.book(toValue(provider), toValue(bookId)),
      ])
      if (version !== generation) return
      settings.value = nextSettings
      state.value = nextState
      if (nextState.pending && !timer)
        timer = setInterval(() => {
          void refresh()
        }, 5000)
      else if (!nextState.pending && timer) {
        clearInterval(timer)
        timer = undefined
      }
    } catch (cause) {
      if (version === generation) error.value = cause instanceof Error ? cause.message : 'Provider request failed'
    }
  }
  async function action(operation: () => Promise<unknown>) {
    if (busy.value || !permitted.value) return
    busy.value = true
    error.value = null
    const originalProvider = toValue(provider)
    const originalId = toValue(bookId)
    try {
      await operation()
      if (originalProvider === toValue(provider) && originalId === toValue(bookId)) await refresh()
    } catch (cause) {
      if (originalProvider === toValue(provider) && originalId === toValue(bookId))
        error.value = cause instanceof Error ? cause.message : 'Provider request failed'
    } finally {
      busy.value = false
    }
  }
  const setIncluded = (included: boolean) => action(() => providerApi.exclude(toValue(provider), toValue(bookId), !included))
  const syncNow = () => action(() => providerApi.syncBook(toValue(provider), toValue(bookId)))
  const link = () =>
    action(async () => {
      await providerApi.link(toValue(provider), toValue(bookId), resourceId.value.trim())
      candidates.value = []
      resourceId.value = ''
    })
  const selectCandidate = (candidate: ReadingProviderCandidate) => {
    resourceId.value = candidate.resourceId
  }
  const search = () =>
    action(async () => {
      candidates.value = await providerApi.candidates(toValue(provider), toValue(bookId), query.value)
    })
  watch(
    [() => toValue(provider), () => toValue(bookId), permitted],
    () => {
      generation++
      candidates.value = []
      query.value = ''
      resourceId.value = ''
      error.value = null
      state.value = null
      settings.value = null
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      void refresh()
    },
    { immediate: true },
  )
  onUnmounted(() => {
    generation++
    if (timer) clearInterval(timer)
  })
  return {
    settings,
    state,
    candidates,
    query,
    resourceId,
    error,
    busy,
    visible: computed(() => permitted.value && settings.value?.connected),
    canSync: computed(() => settings.value?.enabled && !settings.value.reconnectRequired && !state.value?.excluded),
    setIncluded,
    syncNow,
    link,
    selectCandidate,
    search,
  }
}
