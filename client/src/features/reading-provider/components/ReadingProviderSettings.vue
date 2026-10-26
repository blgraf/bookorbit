<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReadingProvider } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import ReadingProviderBookControls from './ReadingProviderBookControls.vue'
import { useReadingProvider } from '../composables/useReadingProvider'
const props = defineProps<{ provider: ReadingProvider; embedded?: boolean }>()
const { t } = useI18n()
const name = computed(() => (props.provider === 'goodreads' ? 'Goodreads' : 'Pagebound'))
const {
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
  connect,
  validate,
  disconnect,
  setEnabled,
  syncAll,
  cancel,
  nextPage,
  previousPage,
} = useReadingProvider(() => props.provider)
const selectedBookId = ref<number | null>(null)
function manageBook(bookId: number) {
  selectedBookId.value = selectedBookId.value === bookId ? null : bookId
}
</script>
<template>
  <div v-if="canUse" class="space-y-6">
    <SettingsPageHeader :title="name" :subtitle="t('readingProviders.subtitle')" />
    <section class="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-6">
      <h2 class="text-lg font-semibold">{{ t('readingProviders.connection', { provider: name }) }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('readingProviders.outboundHelp') }}</p>
      <p v-if="settings && !settings.encryptionConfigured" role="alert" class="text-sm text-destructive">
        {{ t('readingProviders.encryptionRequired') }}
      </p>
      <p v-if="settings?.reconnectRequired" role="alert" class="text-sm text-destructive">{{ t('readingProviders.reconnect') }}</p>
      <p v-if="settings?.connected" class="text-sm">{{ t('readingProviders.connected', { account: settings.accountId }) }}</p>
      <form class="space-y-3" @submit.prevent="connect">
        <template v-if="provider === 'pagebound'">
          <label for="pagebound-email" class="block text-sm font-medium">{{ t('readingProviders.email') }}</label>
          <Input id="pagebound-email" v-model="email" type="email" autocomplete="username" required />
          <label for="pagebound-password" class="block text-sm font-medium">{{ t('readingProviders.password') }}</label>
          <Input id="pagebound-password" v-model="password" type="password" autocomplete="current-password" required />
          <p class="text-xs text-muted-foreground">{{ t('readingProviders.passwordHelp') }}</p>
        </template>
        <template v-else>
          <label for="goodreads-cookies" class="block text-sm font-medium">{{ t('readingProviders.cookies') }}</label>
          <Textarea id="goodreads-cookies" v-model="cookies" autocomplete="off" required maxlength="16384" :spellcheck="false" />
          <p class="text-sm text-muted-foreground">{{ t('readingProviders.cookieHelp') }}</p>
        </template>
        <div class="flex flex-wrap gap-2">
          <Button type="submit" :disabled="busy || !settings?.encryptionConfigured">{{
            settings?.connected ? t('readingProviders.reconnectButton') : t('readingProviders.connect')
          }}</Button>
          <Button v-if="settings?.connected" type="button" variant="outline" :disabled="busy" @click="validate">{{
            t('readingProviders.validate')
          }}</Button>
          <Button v-if="settings?.connected" type="button" variant="outline" :disabled="busy" @click="disconnect">{{
            t('readingProviders.disconnect')
          }}</Button>
        </div>
      </form>
      <p v-if="error || settings?.error" role="alert" class="text-sm text-destructive">{{ error || settings?.error }}</p>
    </section>
    <section v-if="settings?.connected" class="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-6">
      <div class="flex items-center gap-3">
        <ToggleSwitch
          :model-value="settings.enabled"
          :disabled="busy || settings.reconnectRequired"
          :aria-label="t('readingProviders.enable', { provider: name })"
          @update:model-value="setEnabled"
        />
        <span class="text-sm font-medium">{{ t('readingProviders.enable', { provider: name }) }}</span>
      </div>
      <p class="text-sm text-muted-foreground">{{ t('readingProviders.scopeHelp') }}</p>
      <p class="text-sm text-muted-foreground">{{ t('readingProviders.bulkHelp') }}</p>
      <div class="flex flex-wrap gap-2">
        <Button :disabled="busy || !settings.enabled || summary?.bulkActive" @click="syncAll">{{ t('readingProviders.syncAll') }}</Button>
        <Button v-if="summary?.bulkActive || summary?.pending" variant="outline" :disabled="busy" @click="cancel">{{
          t('readingProviders.cancel')
        }}</Button>
      </div>
      <p v-if="summary" role="status" class="text-sm text-muted-foreground">
        {{ t('readingProviders.summary', { pending: summary.pending, failed: summary.failed, synced: summary.synced })
        }}<span v-if="summary.bulkActive"> {{ t('readingProviders.scanning') }}</span>
      </p>
      <p v-if="settings.lastSyncedAt" class="text-xs text-muted-foreground">
        {{ t('readingProviders.lastSync', { date: new Date(settings.lastSyncedAt).toLocaleString() }) }}
      </p>
    </section>
    <section v-if="settings" class="space-y-2 rounded-lg border border-border bg-card p-4 sm:p-6">
      <h2 class="font-semibold">{{ t('readingProviders.limitations') }}</h2>
      <ul class="list-disc space-y-2 ps-5 text-sm text-muted-foreground">
        <li v-for="limitation in settings.capabilities.limitations" :key="limitation">{{ limitation }}</li>
      </ul>
    </section>
    <section v-if="settings?.connected" class="space-y-4">
      <h2 class="font-semibold">{{ t('readingProviders.linkedBooks') }}</h2>
      <p v-if="!books.length" class="text-sm text-muted-foreground">{{ t('readingProviders.noBooks') }}</p>
      <ul class="divide-y divide-border">
        <li v-for="book in books" :key="book.bookId" class="space-y-2 py-3">
          <div class="flex items-start justify-between gap-3">
            <span class="min-w-0 break-words text-sm font-medium">{{ book.title || `#${book.bookId}` }}</span>
            <Button size="sm" variant="outline" @click="manageBook(book.bookId)">{{ t('readingProviders.manageLink') }}</Button>
          </div>
          <p v-if="book.error" class="text-sm text-destructive">{{ book.error }}</p>
          <p v-if="book.warning" class="text-sm text-muted-foreground">{{ book.warning }}</p>
          <dl v-if="selectedBookId === book.bookId"><ReadingProviderBookControls :provider="provider" :book-id="book.bookId" /></dl>
        </li>
      </ul>
      <div class="flex gap-2">
        <Button v-if="previousPages.length" variant="outline" @click="previousPage">{{ t('readingProviders.previous') }}</Button>
        <Button v-if="books.length === 50" variant="outline" @click="nextPage">{{ t('readingProviders.next') }}</Button>
      </div>
    </section>
  </div>
</template>
