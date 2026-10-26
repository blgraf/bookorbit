import { Permission } from '@bookorbit/types'

export const INTEGRATION_TABS = ['hardcover', 'readwise', 'storygraph', 'pagebound', 'goodreads'] as const

export type IntegrationTab = (typeof INTEGRATION_TABS)[number]

type IntegrationTabInfo = {
  labelKey: string
  titleKey: string
  permission: Permission
}

export const INTEGRATION_TAB_INFO: Record<IntegrationTab, IntegrationTabInfo> = {
  hardcover: {
    labelKey: 'settings.integrations.tabs.hardcover',
    titleKey: 'settings.integrations.tabs.hardcover',
    permission: Permission.HardcoverSync,
  },
  readwise: {
    labelKey: 'settings.integrations.tabs.readwise',
    titleKey: 'settings.integrations.tabs.readwise',
    permission: Permission.ReadwiseSync,
  },
  pagebound: {
    labelKey: 'settings.integrations.tabs.pagebound',
    titleKey: 'settings.integrations.tabs.pagebound',
    permission: Permission.PageboundSync,
  },
  goodreads: {
    labelKey: 'settings.integrations.tabs.goodreads',
    titleKey: 'settings.integrations.tabs.goodreads',
    permission: Permission.GoodreadsSync,
  },
  storygraph: {
    labelKey: 'settings.integrations.tabs.storygraph',
    titleKey: 'settings.integrations.tabs.storygraph',
    permission: Permission.StorygraphSync,
  },
}

export function normalizeIntegrationTab(value: unknown): IntegrationTab {
  if (typeof value === 'string' && INTEGRATION_TABS.includes(value as IntegrationTab)) {
    return value as IntegrationTab
  }
  return 'hardcover'
}
