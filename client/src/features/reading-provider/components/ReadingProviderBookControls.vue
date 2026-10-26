<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReadingProvider } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useReadingProviderBook } from '../composables/useReadingProviderBook'
const props = defineProps<{ provider: ReadingProvider; bookId: number }>()
const { t } = useI18n()
const name = computed(() => (props.provider === 'goodreads' ? 'Goodreads' : 'Pagebound'))
const { visible, settings, state, candidates, query, resourceId, error, busy, canSync, setIncluded, syncNow, search, link, selectCandidate } =
  useReadingProviderBook(
    () => props.provider,
    () => props.bookId,
  )
const editing = ref(false)
function toggleEditing() {
  editing.value = !editing.value
}
</script>
<template>
  <div v-if="visible" class="min-w-0 space-y-2">
    <dt class="text-[10px] uppercase tracking-wider font-medium text-muted-foreground">{{ t('readingProviders.bookSync', { provider: name }) }}</dt>
    <dd class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <ToggleSwitch
          :model-value="!state?.excluded"
          :disabled="busy"
          :aria-label="t('readingProviders.includeBook', { provider: name })"
          @update:model-value="setIncluded"
        />
        <span class="text-sm text-muted-foreground">{{ state?.excluded ? t('readingProviders.excluded') : t('readingProviders.included') }}</span>
        <Button v-if="canSync" size="sm" variant="outline" :disabled="busy || state?.pending" @click="syncNow">{{
          state?.pending ? t('readingProviders.queued') : t('readingProviders.syncNow')
        }}</Button>
        <Button size="sm" variant="ghost" @click="toggleEditing">{{ t('readingProviders.manageLink') }}</Button>
      </div>
      <a v-if="state?.remoteUrl" :href="state.remoteUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-primary underline">{{
        t('readingProviders.openEdition')
      }}</a>
      <p v-if="settings?.reconnectRequired" class="text-sm text-destructive">{{ t('readingProviders.reconnect') }}</p>
      <p v-if="error || state?.error" role="alert" class="text-sm text-destructive">{{ error || state?.error }}</p>
      <p v-if="state?.warning" class="text-sm text-muted-foreground">{{ state.warning }}</p>
      <p v-if="state?.lastSyncedAt" class="text-xs text-muted-foreground">
        {{ t('readingProviders.lastSync', { date: new Date(state.lastSyncedAt).toLocaleString() }) }}
      </p>
      <div v-if="editing" class="space-y-3 rounded-md border border-border p-3">
        <p class="text-sm text-muted-foreground">{{ t('readingProviders.matchHelp') }}</p>
        <form class="flex flex-wrap gap-2" @submit.prevent="search">
          <Input
            v-model="query"
            :aria-label="t('readingProviders.searchLabel')"
            :placeholder="t('readingProviders.searchLabel')"
            class="min-w-0 flex-1"
            required
            maxlength="300"
          />
          <Button type="submit" size="sm" variant="outline" :disabled="busy">{{ t('readingProviders.search') }}</Button>
        </form>
        <ul v-if="candidates.length" class="space-y-2">
          <li v-for="candidate in candidates" :key="candidate.resourceId">
            <Button variant="outline" class="h-auto w-full justify-start whitespace-normal text-start" @click="selectCandidate(candidate)">
              <span
                >{{ candidate.title }} · {{ candidate.authors.join(', ') }}<span v-if="candidate.isbn"> · {{ candidate.isbn }}</span
                ><span v-if="candidate.pages"> · {{ t('readingProviders.pages', { count: candidate.pages }) }}</span> ·
                {{ candidate.resourceId }}</span
              >
            </Button>
          </li>
        </ul>
        <form class="space-y-2" @submit.prevent="link">
          <label :for="`${provider}-edition-${bookId}`" class="text-sm font-medium">{{ t('readingProviders.editionId', { provider: name }) }}</label>
          <Input :id="`${provider}-edition-${bookId}`" v-model="resourceId" required maxlength="128" />
          <Button type="submit" size="sm" :disabled="busy">{{ t('readingProviders.linkEdition') }}</Button>
        </form>
      </div>
    </dd>
  </div>
</template>
