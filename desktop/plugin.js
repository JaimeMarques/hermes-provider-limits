import { jsx as h, jsxs } from 'react/jsx-runtime'
import { useState, useEffect, useMemo } from 'react'
import { host, atom, useValue, useQuery, useQueryClient, usePluginI18n, useI18n, Button, Switch, Input, Codicon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsList, TabsTrigger, Popover, PopoverTrigger, PopoverContent, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, STATUSBAR_AREAS } from '@hermes/plugin-sdk'

const ID = 'provider-limits'
const PATH = '/provider-limits'
const ALL_MODELS = '__provider_limits_all_models__'
const PREFS_VERSION = 1
const PREFS_STORAGE_KEY = 'statusGaugePreferences.v1'
const GAUGE_PROVIDER_IDS = Object.freeze(['anthropic', 'openai-codex', 'zai'])
export const DEFAULT_GAUGES = Object.freeze({ anthropic: false, 'openai-codex': false, zai: false })
export const statusGaugePreferencesAtom = atom({ version: PREFS_VERSION, scopes: {} })
let preferencesRegistration = null

const preferenceScopeKey = (connection, profile) => JSON.stringify([connection, profile])
const cleanGaugeScope = value => Object.fromEntries(GAUGE_PROVIDER_IDS.map(id => [id, value?.[id] === true]))

export function parseGaugePreferences(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== PREFS_VERSION ||
      !raw.scopes || typeof raw.scopes !== 'object' || Array.isArray(raw.scopes)) {
    return { version: PREFS_VERSION, scopes: {} }
  }
  return {
    version: PREFS_VERSION,
    scopes: Object.fromEntries(Object.entries(raw.scopes)
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([key, value]) => [key, cleanGaugeScope(value)]))
  }
}

export function gaugePreferencesForScope(preferences, connection, profile) {
  return cleanGaugeScope(preferences?.scopes?.[preferenceScopeKey(connection, profile)])
}

export function updateGaugePreference(preferences, connection, profile, providerId, enabled) {
  if (!GAUGE_PROVIDER_IDS.includes(providerId)) return preferences
  const parsed = parseGaugePreferences(preferences)
  const key = preferenceScopeKey(connection, profile)
  return {
    version: PREFS_VERSION,
    scopes: { ...parsed.scopes, [key]: { ...gaugePreferencesForScope(parsed, connection, profile), [providerId]: enabled === true } }
  }
}

export function setGaugePreference(connection, profile, providerId, enabled) {
  const next = updateGaugePreference(statusGaugePreferencesAtom.get(), connection, profile, providerId, enabled)
  statusGaugePreferencesAtom.set(next)
  preferencesRegistration?.storage?.set(PREFS_STORAGE_KEY, next)
}

export const LOCALES = {
  en: {
    meta: {
      title: 'Usage and limits',
      description: 'Usage, remaining quota, and resets for active Hermes providers.'
    },
    nav: { usage: 'Usage' },
    command: { open: 'Open usage and limits' },
    action: { refresh: 'Refresh', refreshing: 'Refreshing…' },
    statusBar: {
      title: 'Status bar',
      description: 'Choose which compact quota summaries appear at the bottom of Hermes. These choices are saved separately for each connection and profile.',
      defaultOff: 'New profiles start with every gauge off. Turning a gauge off hides it; the full Usage page remains available.',
      provider: {
        anthropic: 'Claude',
        'openai-codex': 'GPT',
        zai: 'GLM / Z.ai'
      },
      backendUnavailable: 'Usage backend unavailable for this connection and profile.',
      usageTitle: provider => `${provider} usage`,
      weekly: 'Weekly window',
      weeklyShort: '7d',
      fiveHour: '5-hour window',
      unavailable: 'Usage unavailable',
      used: percent => `${percent} used`,
      lastKnownUsed: percent => `${percent} last known used`,
      paceAria: (label, used, allowance) => `${label}: ${used} used, ${allowance} pace allowance`,
      usedAria: (label, used) => `${label}: ${used} used; pace unavailable`,
      resetIn: value => `Resets in ${value}`,
      nextRefreshIn: value => `Next quota refresh in ${value}`,
      resetUnknown: 'Reset time unavailable',
      resetPending: 'Reset pending',
      freshness: { fresh: 'Fresh', stale: 'Stale', unavailable: 'Unavailable' },
      checkedAgo: value => `checked ${value} ago`,
      cachedAgo: value => `last good reading ${value} ago`,
      refreshEligible: value => `Refresh eligible in ${value}`,
      legend: { used: 'used', paceRoom: 'pace room', overPace: 'over pace' },
      provenance: (profile, connection) => `Profile ${profile} · connection ${connection ?? 'local'}`
    },
    page: {
      subtitle: 'Account quotas and Hermes usage, session by session.',
      profile: profile => `Profile ${profile}`,
      activeSummary: (providerText, providers, limitText, limits) => `${providerText} active ${providers === 1 ? 'provider' : 'providers'} · ${limitText} ${limits === 1 ? 'limit' : 'limits'}`,
      autoRefresh: (minuteText, _minutes) => `Automatic refresh · ${minuteText} min`,
      loading: 'Checking the active providers in this profile…',
      noProvidersTitle: 'No supported providers are active',
      noProvidersBody: 'Enable Codex, Claude, deepseekv4pro.com, or Z.ai in this profile’s model settings. The dashboard uses Hermes credentials and never asks for separate keys.',
      providersAria: 'Active providers',
      footer: (secondText, _seconds) => `Only providers configured and active in this profile are shown. Limits come from each provider API; a percentage cannot reveal a token ceiling. Different windows and models are never combined. Credentials remain in the backend. Refresh respects the ${secondText}-second cache.`
    },
    error: {
      backendMissingTitle: 'The backend has not loaded the plugin yet',
      backendMissingBody: 'The plugin is installed. Once active conversations finish, close and reopen Hermes Desktop to load the backend. You do not need to configure your accounts again.',
      refreshTitle: 'Unable to refresh',
      refreshBody: 'Check the Hermes connection and try Refresh. No values are being estimated.',
      historyUnavailable: 'History is not available from this backend. If you just updated the plugin, reopen Hermes Desktop after active conversations finish.'
    },
    quota: {
      status: { ok: 'Updated', stale: 'Previous data', unavailable: 'Unavailable' },
      plan: plan => `Plan ${plan}`,
      openaiPlan: 'ChatGPT subscription',
      anthropicPlan: 'Claude subscription',
      staleNotice: 'The refresh failed. The values below are from the previous successful update.',
      source: source => `Source: ${source}`,
      fetchedAt: date => `Fetched ${date}`,
      openProvider: 'Open provider',
      unlimited: 'Unlimited',
      remaining: 'remaining',
      meterAria: (group, window) => `${group} · ${window} · used`,
      meterValue: (used, remaining) => `${used} used; ${remaining} remaining`,
      used: value => `${value} used`,
      unknownUsage: 'Usage not reported',
      subscriptionQuota: 'Subscription quota',
      available: value => `Available: ${value}`,
      details: 'Usage details',
      resetUnknown: 'Reset time unavailable',
      resetDue: 'Reset was due · waiting for an update',
      resetIn: duration => `Resets in ${duration}`
    },
    duration: {
      short: (value, unit, _rawValue) => `${value} ${{ day: 'd', hour: 'hr', minute: 'min', second: 'sec', week: 'wk', month: 'mo' }[unit] || unit}`
    },
    unit: {
      call: n => n === 1 ? 'call' : 'calls',
      token: n => n === 1 ? 'token' : 'tokens',
      credit: n => n === 1 ? 'credit' : 'credits',
      api_credit: n => n === 1 ? 'API credit' : 'API credits',
      flash_credit: n => n === 1 ? 'Flash-equivalent credit' : 'Flash-equivalent credits'
    },
    protocol: {
      group: { codeReview: 'Code review', additionalLimit: 'Additional limit', tokens: 'Tokens', credits: 'Credits', toolsMcp: 'Tools / MCP' },
      window: {
        unspecified: 'Unspecified window',
        extraUsageMonthly: 'Monthly extra usage',
        modelPeriod: (model, countText, _count, unit) => `${model} · ${countText} ${unit === 'day' ? 'd' : unit}`,
        oauthAppsPeriod: (countText, _count, unit) => `OAuth apps · ${countText} ${unit === 'day' ? 'd' : unit}`
      },
      fact: {
        additionalCredits: 'Additional credits', availableResets: 'Available resets',
        individualSpendLimit: 'Individual spend limit', extraUsage: 'Extra usage',
        windowStart: 'Window start', modelChargedCredits: (plan, model) => `${plan} · ${model} · charged credits`,
        unnamedPlanModelChargedCredits: (indexText, _index, model) => `Plan ${indexText} · ${model} · charged credits`,
        periodEnd: plan => `${plan} · period end`,
        unnamedPlanPeriodEnd: (indexText, _index) => `Plan ${indexText} · period end`,
        planUnit: 'Plan unit'
      },
      value: {
        unlimited: 'Unlimited', disabled: 'Disabled', providerQuotaUnavailable: 'Provider quota unavailable',
        firstRequest: 'On first request', notIndicated: 'Not reported',
        flashEquivalentCredits: 'Flash-equivalent credits; not USD'
      },
      period: { unspecified: 'Unspecified period', units: (countText, count) => `${countText} ${count === 1 ? 'period unit' : 'period units'}` },
      detail: { tool: 'Tool' },
      plan: { unnamed: (indexText, _index) => `Plan ${indexText}` }
    },
    problem: {
      generic: 'Unable to retrieve usage with the credentials in this profile. Check the provider in Hermes.',
      auth: {
        oauthRequired: 'Claude limits require an OAuth account in Hermes; an API key does not expose subscription quota.',
        rejected: 'Authentication expired or denied. Check the provider in Hermes.',
        forbidden: 'The provider denied access to usage data.'
      },
      credentials: { missing: 'No usable credential exists for this provider in the Hermes profile.', unreadable: 'The Hermes profile credentials could not be read.' },
      network: { unreachable: 'The usage API could not be reached. Try again in a minute.' },
      upstream: { rateLimited: 'Usage requests are temporarily rate-limited by the provider.', http: (statusText, _status) => `The usage API returned HTTP ${statusText}.` },
      response: { invalidJson: 'The provider did not return valid usage JSON.', unexpectedShape: 'The provider returned an unexpected usage response.', tooLarge: 'The usage response was too large.' },
      security: { redirectBlocked: 'The usage endpoint redirected; the request was stopped for safety.', endpointNotAllowed: 'The usage endpoint is not allowed.' },
      provider: { endpointMismatch: 'The configured credential does not match this provider endpoint.', queryRejected: 'The provider rejected the quota request.', noLimits: 'The provider returned no limits or balances for this account.', fetchFailed: 'Unable to retrieve usage with the credentials in this profile. Check the provider in Hermes.', siteSessionRequired: 'Quota requires a signed-in website session; the Hermes API key cannot access this data. Open the provider to inspect it. No quota was estimated.' },
      history: { providerInactive: 'This provider is not active in the selected profile.', readFailed: 'The local Hermes usage record could not be read. Try again.' }
    },
    history: {
      title: 'Hermes usage', subtitle: 'What each session and model used, including auxiliary tasks.', refresh: 'Refresh history',
      searchAria: 'Search session or model', searchPlaceholder: 'Search session, ID, or model…',
      modelFilterAria: 'Filter model', allModels: 'All models', sortAria: 'Sort sessions',
      sortTokens: 'Most tokens', sortRecent: 'Recent activity', loading: 'Reading the Hermes usage record…',
      tokensRecorded: 'Recorded tokens', sessions: 'Sessions', models: 'Models', sessionCredits: 'Per-session credits', notRecorded: 'Not recorded',
      accumulatedPeriod: 'Accumulated session history; this is not usage for the subscription window.',
      costNote: 'USD costs: ≈ means estimated; “Included” does not mean zero credits. Hermes does not store credits charged per session.',
      unattributed: (countText, count) => `${countText} summary ${count === 1 ? 'token' : 'tokens'} in this profile cannot be safely attributed to a model or provider. They are excluded from these totals.`,
      legacySessions: (countText, count) => `${countText} older ${count === 1 ? 'session uses' : 'sessions use'} the model recorded in its summary; model switches cannot be reconstructed.`,
      modelSummary: (countText, _count) => `Summary by model (${countText})`,
      noFilteredSessions: 'No sessions match the filters.', noProviderUsage: 'No usage has been recorded for this provider in this profile yet.',
      range: (startText, _start, endText, _end, totalText, total) => `${startText}–${endText} of ${totalText} ${total === 1 ? 'session' : 'sessions'}`,
      zeroSessions: (zeroText, _zero) => `${zeroText} sessions`,
      previous: 'Previous', next: 'Next', scopeFooter: source => `${source} · This profile only · Conversations, delegations, and auxiliaries separated`,
      columns: { modelTask: 'Model / task', model: 'Model', input: 'Input¹', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write', reasoning: 'Reasoning²', total: 'Total', costUsd: 'Cost USD', sessionModels: 'Session / models', tokens: 'Tokens', calls: 'Calls', credits: 'Credits' },
      aria: { modelTasks: 'Usage by model and task', modelSummary: 'Summary by model', section: 'Usage recorded by Hermes', sessions: 'Sessions and usage' },
      task: { main: 'Conversation', approval: 'Approvals', title_generation: 'Title', vision: 'Vision', compression: 'Compression', goal_judge: 'Evaluation', background_review: 'Review' },
      included: 'Included in plan', estimated: value => `≈ ${value}`, combinedCost: (actual, estimated) => `${actual} + ${estimated}`, partial: value => `${value} (partial)`, unrecorded: 'Not recorded',
      legacySummary: 'Legacy session summary', hideDetails: 'Hide details', showModelsTasks: 'Models and tasks',
      inputOutput: (input, output) => `${input} input · ${output} output`, creditsTooltip: 'Per-session credits are not recorded by Hermes',
      footnotes: '¹ Input excludes cache; total includes cache read and write. ² Reasoning is already included in output and is not counted twice.',
      untitledSession: 'Untitled session', unrecordedModel: 'Unrecorded model'
    }
  },
}

const isNumber = value => typeof value === 'number' && Number.isFinite(value)

// Providers and schema-v1 backends sometimes echo an amount as a JSON string
// ("2219"). Localize those as numbers instead of dropping them through as raw
// text; anything that is not a finite decimal stays literal.
export function numeric(value) {
  if (isNumber(value)) return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text)) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

const LEGACY_PROBLEMS = new Map([
  ['A API da Z.ai não devolveu os limites esperados.', ['response.unexpectedShape', false]],
  ['O endpoint de utilização mudou de endereço; pedido interrompido por segurança.', ['security.redirectBlocked', false]],
  ['Endpoint de utilização não autorizado.', ['security.endpointNotAllowed', false]],
  ['Resposta de utilização demasiado grande.', ['response.tooLarge', false]],
  ['Resposta de utilização inválida.', ['response.unexpectedShape', false]],
  ['Autenticação expirada ou recusada. Verifique o fornecedor no Hermes.', ['auth.rejected', false]],
  ['O fornecedor recusou acesso aos dados de utilização.', ['auth.forbidden', false]],
  ['Pedidos de utilização temporariamente limitados pelo fornecedor.', ['upstream.rateLimited', true]],
  ['Não foi possível contactar a API de utilização. Tente novamente dentro de um minuto.', ['network.unreachable', true]],
  ['O fornecedor não devolveu JSON de utilização válido.', ['response.invalidJson', false]],
  ['Não foi possível ler as credenciais do perfil Hermes.', ['credentials.unreadable', false]],
  ['Limites Claude requerem uma conta OAuth no Hermes; uma chave API não fornece a quota da subscrição.', ['auth.oauthRequired', false]],
  ['Não existe uma chave utilizável para este fornecedor no perfil Hermes.', ['credentials.missing', false]],
  ['O endereço GLM configurado não corresponde à Z.ai/Zhipu.', ['provider.endpointMismatch', false]],
  ['A Z.ai não aceitou a consulta da quota do Coding Plan.', ['provider.queryRejected', false]],
  ['A credencial não pertence ao endpoint deepseekv4pro.com configurado.', ['provider.endpointMismatch', false]],
  ['O dashboard DeepSeek não devolveu a lista de planos esperada.', ['response.unexpectedShape', false]],
  ['A quota requer sessão iniciada no site deepseekv4pro.com; a API key do Hermes não dá acesso a estes dados. Consulte «Abrir no fornecedor». Nenhuma quota foi estimada.', ['provider.siteSessionRequired', false]],
  ['O fornecedor não devolveu limites ou saldos para esta conta.', ['provider.noLimits', false]],
  ['Não foi possível obter a utilização com as credenciais deste perfil. Verifique o fornecedor no Hermes.', ['provider.fetchFailed', false]],
  ['Não foi possível ler o registo local do Hermes. Tente novamente.', ['history.readFailed', true]],
  ['Fornecedor não ativo neste perfil.', ['history.providerInactive', false]]
])

export function legacyProblem(error) {
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : null
  if (!message) return null
  const known = LEGACY_PROBLEMS.get(message)
  if (known) return { code: known[0], params: {}, retryable: known[1] }
  const http = /^A API de utilização respondeu HTTP (\d{3})\.$/.exec(message)
  if (!http) return null
  const status = Number(http[1])
  return { code: 'upstream.http', params: { status }, retryable: status === 429 || status >= 500 }
}

function useLocaleTools() {
  const t = usePluginI18n(ID)
  const { locale } = useI18n()
  return useMemo(() => ({
    t,
    locale,
    number: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    dateTime: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    statusDateTime: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long' }),
    usd: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
  }), [locale, t])
}

const numberArguments = (value, tools) => [tools.number.format(value), value]
const problemArguments = (problem, tools) => {
  const status = problem?.params?.status
  return problem?.code === 'upstream.http' && isNumber(status) ? numberArguments(status, tools) : []
}
const descriptorArguments = (descriptor, tools) => {
  const args = descriptor.args || []
  if (descriptor.code === 'fact.unnamedPlanModelChargedCredits' && isNumber(args[0])) {
    return [...numberArguments(args[0], tools), args[1]]
  }
  if (descriptor.code === 'plan.unnamed' || descriptor.code === 'period.units' ||
      descriptor.code === 'fact.unnamedPlanPeriodEnd') {
    return isNumber(args[0]) ? numberArguments(args[0], tools) : args
  }
  if (descriptor.code === 'window.modelPeriod' && isNumber(args[1])) {
    return [args[0], ...numberArguments(args[1], tools), args[2]]
  }
  if (descriptor.code === 'window.oauthAppsPeriod' && isNumber(args[0])) {
    return [...numberArguments(args[0], tools), args[1]]
  }
  return args
}

const pct = (value, tools) => isNumber(value) ? tools.percent.format(value / 100) : '—'
const unitText = (code, value, tools, fallback) => {
  if (code === 'percent') return ''
  if (code === 'unknown') return ''
  if (!code) {
    const legacy = { chamadas: 'call', tokens: 'token', créditos: 'flash_credit', 'créditos (API)': 'api_credit' }[fallback]
    return legacy ? tools.t(`unit.${legacy}`, value) : (fallback || '')
  }
  const key = `unit.${code}`
  const text = tools.t(key, value)
  return text === key ? (fallback || '') : text
}
const amount = (rawValue, unit, tools, unitCode, currencyCode, decimalPlaces) => {
  const value = numeric(rawValue)
  if (value === null) return '—'
  if (unitCode === 'currency' && /^[A-Z]{3}$/.test(currencyCode || '')) {
    const currencyDefaults = new Intl.NumberFormat(tools.locale, { style: 'currency', currency: currencyCode }).resolvedOptions()
    const places = Number.isInteger(decimalPlaces) && decimalPlaces >= 0 && decimalPlaces <= 9
      ? decimalPlaces
      : currencyDefaults.maximumFractionDigits
    return new Intl.NumberFormat(tools.locale, { style: 'currency', currency: currencyCode, minimumFractionDigits: places, maximumFractionDigits: places }).format(value / (10 ** places))
  }
  const suffix = unitText(unitCode, value, tools, unit && unit !== '%' ? unit : '')
  return `${tools.number.format(value)}${suffix ? ` ${suffix}` : ''}`
}

function legacyDescriptor(value, role) {
  if (value == null) return null
  const unnamedPlan = /^Plano (\d+)$/.exec(String(value))
  if ((role === 'group' || role === 'factLabel') && unnamedPlan) {
    return { kind: 'message', code: 'plan.unnamed', args: [Number(unnamedPlan[1])] }
  }
  const messages = {
    group: {
      'Geral': 'group.additionalLimit',
      'Revisão de código': 'group.codeReview',
      'Limite adicional': 'group.additionalLimit',
      'Tokens': 'group.tokens',
      'CREDIT_LIMIT': 'group.credits',
      'Ferramentas / MCP': 'group.toolsMcp'
    },
    window: {
      'Janela não indicada': 'window.unspecified',
      'Utilização extra mensal': 'window.extraUsageMonthly',
      'Período não indicado': 'period.unspecified'
    },
    factLabel: {
      'Créditos adicionais': 'fact.additionalCredits',
      'Reposições disponíveis': 'fact.availableResets',
      'Limite individual de despesa': 'fact.individualSpendLimit',
      'Utilização extra': 'fact.extraUsage',
      'Início da janela': 'fact.windowStart',
      'Ferramenta': 'detail.tool',
      'Unidade do plano': 'fact.planUnit'
    },
    factValue: {
      'Ilimitados': 'value.unlimited',
      'Desativada': 'value.disabled',
      'Quota indisponível no fornecedor': 'value.providerQuotaUnavailable',
      'No primeiro pedido': 'value.firstRequest',
      'Não indicado': 'value.notIndicated',
      'Créditos Flash-equivalentes; não USD': 'value.flashEquivalentCredits'
    }
  }
  const code = messages[role]?.[value]
  if (code) return { kind: 'message', code }
  if (role === 'window') {
    const periodUnits = String(value).match(/^(\d+(?:[.,]\d+)?)\s+unid\. de período$/)
    if (periodUnits) return { kind: 'message', code: 'period.units', args: [Number(periodUnits[1].replace(',', '.'))] }
    const period = String(value).match(/^(\d+(?:[.,]\d+)?)\s*(d|h|min|s|mês|semana)$/)
    if (period) return { kind: 'period', value: Number(period[1].replace(',', '.')), unit: { d: 'day', h: 'hour', min: 'minute', s: 'second', mês: 'month', semana: 'week' }[period[2]] }
    const modelPeriod = String(value).match(/^(.+) · (\d+) d$/)
    if (modelPeriod) return { kind: 'message', code: modelPeriod[1] === 'Apps OAuth' ? 'window.oauthAppsPeriod' : 'window.modelPeriod', args: modelPeriod[1] === 'Apps OAuth' ? [Number(modelPeriod[2]), 'day'] : [modelPeriod[1], Number(modelPeriod[2]), 'day'] }
  }
  if (role === 'factLabel') {
    const charged = String(value).match(/^(.+) · (.+) · créditos debitados$/)
    if (charged) {
      const unnamed = /^Plano (\d+)$/.exec(charged[1])
      return unnamed
        ? { kind: 'message', code: 'fact.unnamedPlanModelChargedCredits', args: [Number(unnamed[1]), charged[2]] }
        : { kind: 'message', code: 'fact.modelChargedCredits', args: [charged[1], charged[2]] }
    }
    const periodEnd = String(value).match(/^(.+) · fim do período$/)
    if (periodEnd) {
      const unnamed = /^Plano (\d+)$/.exec(periodEnd[1])
      return unnamed
        ? { kind: 'message', code: 'fact.unnamedPlanPeriodEnd', args: [Number(unnamed[1])] }
        : { kind: 'message', code: 'fact.periodEnd', args: [periodEnd[1]] }
    }
  }
  if (role === 'periodEndValue') {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(String(value))
    if (iso && Number.isFinite(new Date(value).getTime())) return { kind: 'timestamp', value }
  }
  return { kind: 'literal', value }
}

function displayText(descriptor, legacy, tools, role) {
  descriptor ||= legacyDescriptor(legacy, role)
  if (!descriptor) return legacy ?? '—'
  if (descriptor.kind === 'literal') return descriptor.value ?? legacy ?? '—'
  if (descriptor.kind === 'period') return tools.t('duration.short', tools.number.format(descriptor.value), descriptor.unit, descriptor.value)
  if (descriptor.kind === 'timestamp') return descriptor.value ? tools.dateTime.format(new Date(descriptor.value)) : '—'
  if (descriptor.kind === 'message') {
    const key = `protocol.${descriptor.code}`
    const value = tools.t(key, ...descriptorArguments(descriptor, tools))
    return value === key ? legacy ?? '—' : value
  }
  return legacy ?? '—'
}

function problemText(problem, tools) {
  if (!problem?.code) return tools.t('problem.generic')
  const key = `problem.${problem.code}`
  const value = tools.t(key, ...problemArguments(problem, tools))
  return value === key ? tools.t('problem.generic') : value
}

function localizedError(problem, error, tools, fallback = 'problem.generic') {
  const resolved = problem?.code ? problem : legacyProblem(error)
  return resolved ? problemText(resolved, tools) : tools.t(fallback)
}

export function resetText(value, tools, now = Date.now()) {
  const end = value ? new Date(value).getTime() : NaN
  if (!Number.isFinite(end)) return tools.t('quota.resetUnknown')
  const minutes = Math.ceil((end - now) / 60000)
  if (minutes <= 0) return tools.t('quota.resetDue')
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const duration = days
    ? `${tools.t('duration.short', tools.number.format(days), 'day', days)} ${tools.t('duration.short', tools.number.format(hours), 'hour', hours)}`
    : hours
      ? `${tools.t('duration.short', tools.number.format(hours), 'hour', hours)} ${tools.t('duration.short', tools.number.format(mins), 'minute', mins)}`
      : tools.t('duration.short', tools.number.format(mins), 'minute', mins)
  return tools.t('quota.resetIn', duration)
}

export function validateQuotaResponse(data, profile) {
  if (!data || data.schema_version !== 3 || !Array.isArray(data.providers)) {
    throw new Error('INVALID_RESPONSE')
  }
  const identity = data.profile_identity
  if (data.profile !== profile || identity?.name !== profile ||
      typeof identity.id !== 'string' || !/^[a-f0-9]{64}$/.test(identity.id)) {
    throw new Error('PROFILE_MISMATCH')
  }
}

const isBackendUnavailableError = error => /404|not found/i.test(String(error))
const isHardQuotaError = error => [401, 403].includes(error?.status) ||
  /\b401\b|\b403\b|unauthorized|forbidden|PROFILE_MISMATCH|INVALID_RESPONSE/i.test(String(error))

export function quotaQueryOptions(ctx, connection, profile, enabled = true) {
  const queryKey = ['provider-limits', 3, connection, profile]
  return {
    queryKey,
    queryFn: async ({ client } = {}) => {
      try {
        const data = await ctx.rest(`/quota?profile=${encodeURIComponent(profile)}`, {
          method: 'GET', timeoutMs: 55_000
        })
        validateQuotaResponse(data, profile)
        return data
      } catch (error) {
        // Revoke the shared cache itself, not just one observer's render. A
        // later transport failure must not resurrect an unauthorized snapshot.
        if (isHardQuotaError(error) || isBackendUnavailableError(error)) client?.setQueryData(queryKey, null)
        throw error
      }
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: query => isBackendUnavailableError(query.state.error) ? false : 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => !isBackendUnavailableError(error) && !isHardQuotaError(error) && failureCount < 2
  }
}

export const CSS = `
.pl-page{height:100%;overflow:auto;container-type:inline-size;color:var(--ui-text-primary);font:inherit;scrollbar-color:var(--ui-stroke-primary) transparent}
.pl-content{padding:clamp(20px,4vw,48px);max-width:1160px;margin:0 auto}
.pl-header{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.pl-header h1{font-size:clamp(24px,3vw,32px);font-weight:650;letter-spacing:-.025em;line-height:1.18;margin:0 0 9px}
.pl-description{color:var(--ui-text-secondary);font-size:13px;line-height:1.6;margin:0;max-width:65ch}
.pl-meta{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;font-size:12px;color:var(--ui-text-secondary);padding-bottom:28px}
.pl-profile{display:inline-flex;align-items:center;gap:7px;color:var(--ui-text-primary)}
.pl-section{border-top:1px solid var(--ui-stroke-tertiary);padding:28px 0 30px}
.pl-section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}
.pl-identity{display:flex;align-items:center;gap:12px;min-width:0}
.pl-identity h2{font-size:19px;font-weight:600;letter-spacing:-.015em;margin:0}
.pl-mark{font-weight:650;letter-spacing:-.05em;font-size:20px;color:var(--ui-text-secondary);width:34px;flex-shrink:0}
.pl-plan{font-size:12px;color:var(--ui-text-secondary);margin-top:5px}
.pl-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ui-text-secondary)}
.pl-status-dot{width:6px;height:6px;border-radius:50%;background:var(--ui-accent)}
.pl-group+.pl-group{margin-top:28px}
.pl-group-title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--ui-text-secondary);margin:0 0 14px}
.pl-windows{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:22px 36px}
.pl-window{min-width:0}
.pl-window-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px}
.pl-window-label{font-size:14px;font-weight:550}
.pl-rest{font-size:20px;letter-spacing:-.035em;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.pl-rest small{font-size:11px;letter-spacing:normal;font-weight:400;color:var(--ui-text-secondary);margin-left:5px}
.pl-track{height:7px;background:var(--ui-bg-quaternary);border-radius:4px;overflow:hidden;position:relative}
.pl-fill{height:100%;width:100%;transform-origin:left;border-radius:4px;background:var(--ui-accent);transition:transform .5s cubic-bezier(.16,1,.3,1)}
.pl-window[data-severity=warn] .pl-fill{background:var(--ui-warning,var(--ui-accent))}
.pl-window[data-severity=danger] .pl-fill{background:var(--destructive,var(--ui-accent))}
.pl-track[data-unknown=true]{background:repeating-linear-gradient(110deg,var(--ui-bg-quaternary) 0 8px,transparent 8px 12px);border:1px solid var(--ui-stroke-tertiary)}
.pl-measure{display:flex;justify-content:space-between;gap:14px;margin-top:10px;font-size:12px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.pl-renewal{font-size:12px;margin-top:16px;line-height:1.65;color:var(--ui-text-secondary)}
.pl-renewal time{display:block;color:var(--ui-text-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.pl-note{margin:10px 0 0;font-size:11px;color:var(--ui-text-tertiary);line-height:1.6}
.pl-facts{display:flex;flex-wrap:wrap;gap:14px 32px;margin:22px 0 0;font-size:12px}
.pl-fact dt{color:var(--ui-text-secondary);margin-bottom:5px}.pl-fact dd{margin:0;font-weight:550;font-variant-numeric:tabular-nums}
.pl-source{font-size:11px;color:var(--ui-text-tertiary);margin-top:20px;display:flex;flex-wrap:wrap;gap:6px 18px;overflow-wrap:anywhere}
.pl-alert{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;background:var(--ui-bg-quaternary);border-radius:6px;font-size:13px;line-height:1.65;margin:0 0 20px;color:var(--ui-text-secondary)}
.pl-alert strong{display:block;color:var(--ui-text-primary);font-weight:550}
.pl-empty{padding:46px 0;max-width:65ch}.pl-empty h2{font-size:20px;font-weight:550;margin:14px 0 10px}
.pl-empty p{font-size:13px;line-height:1.7;color:var(--ui-text-secondary)}
.pl-loading{padding:32px 0;color:var(--ui-text-secondary);font-size:13px}
.pl-loading-lines{display:grid;gap:18px;margin-top:24px}.pl-loading-lines span{display:block;height:8px;background:var(--ui-bg-quaternary);border-radius:3px;width:100%}
.pl-footer{border-top:1px solid var(--ui-stroke-tertiary);padding-top:20px;font-size:11px;line-height:1.7;color:var(--ui-text-tertiary);max-width:75ch}
.pl-gauge-settings{border-top:1px solid var(--ui-stroke-tertiary);padding:24px 0 28px}.pl-gauge-settings h2{font-size:19px;font-weight:600;margin:0 0 7px}.pl-gauge-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px}.pl-gauge-option{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--ui-stroke-tertiary);border-radius:6px;font-size:12px}.pl-gauge-note{margin:12px 0 0;color:var(--ui-text-tertiary);font-size:11px;line-height:1.5}
.pl-details{margin-top:12px;color:var(--ui-text-secondary);font-size:12px}.pl-details summary{cursor:pointer;padding:4px 0;list-style-position:inside}.pl-details dl{margin:8px 0;display:grid;gap:9px}.pl-details .pl-fact{display:flex;gap:16px;justify-content:space-between}.pl-details dt{margin:0}
.pl-page :focus-visible{outline:2px solid var(--ui-accent);outline-offset:4px;border-radius:3px}
.pl-page ::selection{background:var(--ui-accent);color:var(--ui-bg-primary)}
.pl-tabs-list{margin-bottom:8px;max-width:100%;overflow-x:auto}
.pl-history{border-top:1px solid var(--ui-stroke-tertiary);padding:26px 0 28px}
.pl-history h2{font-size:19px;font-weight:600;letter-spacing:-.015em;margin:0 0 8px}
.pl-history-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.pl-stat-strip{display:flex;flex-wrap:wrap;gap:20px 36px;margin:24px 0}
.pl-stat-strip dt{font-size:12px;color:var(--ui-text-secondary);margin-bottom:8px}.pl-stat-strip dd{font-size:22px;font-weight:550;font-variant-numeric:tabular-nums;margin:0;letter-spacing:-.025em}
.pl-history-tools{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:24px 0 16px}
.pl-search{flex:1;min-width:180px}.pl-select-wrap{flex:0 1 170px;min-width:0;max-width:100%}.pl-select-trigger{font-size:12px;overflow:hidden}.pl-select-trigger [data-slot=select-value]{display:block;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
/* --dt-primary-solid* only exist from Hermes v2026.8.31. The older SDK's accent
   pair falls below AA in Everforest light and Solarized dark, so the compatibility
   path inverts the palette's foreground/background seeds. Across v2026.8.27 this
   clears 4.5:1 text and 3:1 highlighted-row contrast in every built-in palette.
   Newer primary-solid fills can sit below 3:1 against dark popovers, so keep an
   explicit inset focus outline using the palette foreground in every generation. */
.pl-select-item:focus,.pl-select-item[data-highlighted]{background:var(--dt-primary-solid,var(--theme-foreground));color:var(--dt-primary-solid-foreground,var(--theme-background-seed));outline:2px solid var(--theme-foreground);outline-offset:-2px}
.pl-table-wrap{max-width:100%;overflow:auto;scrollbar-color:var(--ui-stroke-primary) transparent}
.pl-table{width:100%;min-width:740px;border-collapse:collapse;text-align:left;font-size:12px;line-height:1.6}
.pl-table th{font-weight:500;color:var(--ui-text-secondary);padding:9px 12px;border-bottom:1px solid var(--ui-stroke-tertiary);white-space:nowrap}
.pl-table td{padding:14px 12px;vertical-align:top;border-bottom:1px solid var(--ui-stroke-tertiary)}
.pl-table th:first-child,.pl-table td:first-child{padding-left:0}.pl-table th:last-child,.pl-table td:last-child{padding-right:0}
.pl-table tbody tr:hover{background:var(--chrome-action-hover)}
.pl-session-title{font-size:13px;font-weight:550;max-width:360px;overflow-wrap:anywhere;color:var(--ui-text-primary)}
.pl-session-id{font-size:11px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.pl-session-models{display:flex;flex-wrap:wrap;gap:3px 9px;margin-top:5px;font-size:11px;color:var(--ui-text-secondary);max-width:360px;overflow-wrap:anywhere}
.pl-numeric{font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:550}.pl-submeasure{font-size:11px;font-weight:400;color:var(--ui-text-secondary);margin-top:4px;white-space:normal}
.pl-model-details summary{cursor:pointer;color:var(--ui-text-secondary);margin-top:10px;font-size:12px;list-style-position:inside}
.pl-model-details .pl-table{font-size:11px;margin-top:10px;min-width:600px}.pl-model-details .pl-table td{padding-top:8px;padding-bottom:8px}
.pl-detail-row td{padding-top:0}.pl-task{font-weight:400;font-size:11px;color:var(--ui-text-secondary)}
.pl-pagination{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap;font-size:12px;color:var(--ui-text-secondary)}
.pl-pagination-actions{display:flex;gap:8px}.pl-model-summary{margin:20px 0}
.pl-history-warning{font-size:12px;color:var(--ui-text-secondary);padding:12px 0;line-height:1.7}
@container (max-width:550px){.pl-content{padding:22px 20px}.pl-meta{padding-bottom:16px}.pl-section-head{align-items:flex-start}.pl-section{padding-top:24px}.pl-windows{grid-template-columns:1fr;gap:26px}.pl-gauge-grid{grid-template-columns:1fr}.pl-status{font-size:11px}.pl-rest{font-size:21px}}
@media(prefers-reduced-motion:reduce){.pl-fill{transition:none}}
`

export const STATUS_CSS = `
.pl-status-resets{border-block:1px solid var(--ui-stroke-secondary);padding:10px 0;margin:16px 0 10px}.pl-status-resets .pl-fact{display:flex;justify-content:space-between;gap:14px}.pl-status-resets dt{margin:0;color:var(--ui-text-secondary)}.pl-status-resets dd{margin:0;font-weight:550;font-variant-numeric:tabular-nums}
.pl-status-gauges{display:flex;height:100%;align-items:center;min-width:80px;max-width:100%;flex:0 1 calc(var(--pl-gauge-count) * 180px);container-type:inline-size}.pl-status-compact{display:none;align-items:center;height:100%;padding:0 6px;font-size:11px;white-space:nowrap;color:var(--ui-text-tertiary)}@media(max-width:650px){.pl-status-gauges [data-provider-chip]{display:none}.pl-status-compact{display:inline-flex}}@container(max-width:179px){.pl-status-gauges[data-gauge-count="1"] [data-provider-chip]{display:none}.pl-status-gauges[data-gauge-count="1"] .pl-status-compact{display:inline-flex}}@container(max-width:359px){.pl-status-gauges[data-gauge-count="2"] [data-provider-chip]{display:none}.pl-status-gauges[data-gauge-count="2"] .pl-status-compact{display:inline-flex}}@container(max-width:539px){.pl-status-gauges[data-gauge-count="3"] [data-provider-chip]{display:none}.pl-status-gauges[data-gauge-count="3"] .pl-status-compact{display:inline-flex}}.pl-status-popover{width:288px;max-width:calc(100vw - 24px);padding:12px;font-size:12px}.pl-status-popover-head{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:14px}.pl-status-popover-head h3{font-size:12px;font-weight:600;margin:0}.pl-status-popover-head span{color:var(--ui-text-tertiary);font-size:11px}.pl-status-window-list{display:grid;gap:14px}.pl-status-window{display:grid;gap:6px}.pl-status-window-head{display:flex;justify-content:space-between;gap:10px}.pl-status-window-head>:last-child{font-variant-numeric:tabular-nums}.pl-status-chip-value[data-level=caution]{color:var(--ui-yellow)}.pl-status-chip-value[data-level=warning]{color:var(--ui-orange)}.pl-status-chip-value[data-level=critical]{color:var(--ui-red)}.pl-status-chip-pace{color:var(--ui-text-quaternary);font-weight:400}.pl-pace-value{color:var(--ui-yellow);font-weight:500;margin-left:6px}.pl-pace-track{display:flex;height:7px;overflow:hidden;border-radius:4px;background:var(--ui-stroke-secondary)}.pl-pace-track i{height:100%}.pl-pace-track [data-segment=used]{background:var(--ui-text-secondary)}.pl-pace-track [data-segment=pace-room]{background:var(--ui-yellow)}.pl-pace-track [data-segment=over-pace]{background:var(--ui-orange)}.pl-status-reset,.pl-status-window time,.pl-status-freshness,.pl-status-provenance{color:var(--ui-text-tertiary);font-size:11px}.pl-status-window time{color:var(--ui-text-quaternary)}.pl-pace-legend{display:flex;gap:12px;margin:14px 0;color:var(--ui-text-tertiary);font-size:10px}.pl-pace-legend i{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:4px}.pl-pace-legend [data-legend=used]{background:var(--ui-text-secondary)}.pl-pace-legend [data-legend=paceRoom]{background:var(--ui-yellow)}.pl-pace-legend [data-legend=overPace]{background:var(--ui-orange)}.pl-status-freshness{margin-bottom:8px}.pl-status-provenance{margin-top:8px;color:var(--ui-text-quaternary);font-size:10px}
`

function Fact({ fact, tools, inheritedUnitCode, inheritedUnit, inheritedCurrencyCode }) {
  const label = displayText(fact.display?.label, fact.label, tools, 'factLabel')
  const valueRole = fact.display?.value == null && /^.+ · fim do período$/.test(String(fact.label))
    ? 'periodEndValue'
    : 'factValue'
  const value = fact.display?.value
    ? displayText(fact.display.value, fact.value, tools, valueRole)
    : numeric(fact.value) !== null
      ? amount(fact.value, fact.unit || inheritedUnit, tools, fact.unit_code || inheritedUnitCode,
               fact.currency_code || inheritedCurrencyCode, fact.decimal_places)
      : displayText(null, fact.value, tools, valueRole)
  return jsxs('div', { className: 'pl-fact', children: [h('dt', { children: label }), h('dd', { children: value })] })
}

// Schema-v1 backends describe units only through the free-text `unit` string, so a
// staggered hot reload (new Desktop, previous backend) must recover the semantics the
// v2 payload states explicitly. Anthropic's extra-usage window carries an ISO currency
// there and minor-unit amounts, so without this it renders 2219 as "2,219 USD" rather
// than "$22.19". Leaving decimal_places undefined lets the currency's own default
// fraction digits scale it, which is what the v1 backend assumed.
export function legacyWindowUnits(window, providerId) {
  if (window.unit_code) {
    return { unitCode: window.unit_code, currencyCode: window.currency_code, decimalPlaces: window.decimal_places }
  }
  const currency = typeof window.unit === 'string' && /^[A-Za-z]{3}$/.test(window.unit.trim())
    ? window.unit.trim().toUpperCase()
    : null
  if (providerId === 'anthropic' && window.id === 'extra_usage' && currency) {
    return { unitCode: 'currency', currencyCode: currency, decimalPlaces: undefined }
  }
  if (providerId !== 'zai') return { unitCode: undefined, currencyCode: undefined, decimalPlaces: undefined }
  const zai = window.group === 'CREDIT_LIMIT' ? 'credit'
    : window.group === 'Ferramentas / MCP' ? 'call'
      : window.group === 'Tokens' ? 'token' : 'unknown'
  return { unitCode: zai, currencyCode: undefined, decimalPlaces: undefined }
}

function Meter({ value: w, tools, providerId }) {
  const known = isNumber(w.used_percent)
  const severity = known && w.used_percent >= 95 ? 'danger' : known && w.used_percent >= 80 ? 'warn' : 'normal'
  // Gate on numeric() rather than isNumber() so an all-string schema-v1 payload
  // still renders its amounts instead of collapsing to the subscription fallback.
  const absolute = numeric(w.limit) !== null || numeric(w.used) !== null || numeric(w.remaining) !== null
  const label = displayText(w.display?.label, w.label, tools, 'window')
  const group = displayText(w.display?.group, w.group, tools, 'group')
  const usedPercent = pct(w.used_percent, tools)
  const remainingPercent = pct(w.remaining_percent, tools)
  const units = legacyWindowUnits(w, providerId)
  const formatAmount = value => amount(value, w.unit, tools, units.unitCode, units.currencyCode, units.decimalPlaces)
  return jsxs('div', { className: 'pl-window', 'data-severity': severity, children: [
    jsxs('div', { className: 'pl-window-top', children: [h('span', { className: 'pl-window-label', children: label }), jsxs('span', { className: 'pl-rest', children: [w.unlimited ? tools.t('quota.unlimited') : remainingPercent, !w.unlimited && h('small', { children: tools.t('quota.remaining') })] })] }),
    h('div', { className: 'pl-track', 'data-unknown': !known, role: known ? 'progressbar' : undefined, 'aria-label': tools.t('quota.meterAria', group, label), 'aria-valuemin': known ? 0 : undefined, 'aria-valuemax': known ? 100 : undefined, 'aria-valuenow': known ? Math.max(0, Math.min(100, w.used_percent)) : undefined, 'aria-valuetext': known ? tools.t('quota.meterValue', usedPercent, remainingPercent) : undefined, children: known && h('div', { className: 'pl-fill', style: { transform: `scaleX(${Math.min(100, Math.max(0, w.used_percent)) / 100})` } }) }),
    jsxs('div', { className: 'pl-measure', children: [h('span', { children: known ? tools.t('quota.used', usedPercent) : tools.t('quota.unknownUsage') }), h('span', { children: absolute ? `${formatAmount(w.used)} / ${formatAmount(w.limit)}` : tools.t('quota.subscriptionQuota') })] }),
    absolute && numeric(w.remaining) !== null && h('p', { className: 'pl-note', children: tools.t('quota.available', formatAmount(w.remaining)) }),
    jsxs('div', { className: 'pl-renewal', children: [resetText(w.reset_at, tools), w.reset_at && h('time', { dateTime: w.reset_at, children: tools.dateTime.format(new Date(w.reset_at)) })] }),
    w.details?.length > 0 && jsxs('details', { className: 'pl-details', children: [h('summary', { children: tools.t('quota.details') }), h('dl', { children: w.details.map((fact, i) => h(Fact, { fact, tools, inheritedUnitCode: units.unitCode, inheritedUnit: w.unit, inheritedCurrencyCode: units.currencyCode }, i)) })] })
  ] })
}

function providerPlanText(provider, tools, fallback) {
  const items = provider.plan_display?.kind === 'list' && Array.isArray(provider.plan_display.items)
    ? provider.plan_display.items
    : null
  if (items?.length) {
    return items.map(item => {
      const value = displayText(item, null, tools, 'plan')
      return item?.kind === 'message' && item.code === 'plan.unnamed'
        ? value
        : tools.t('quota.plan', value)
    }).join(' / ')
  }
  const legacyPlans = String(provider.plan || '').split(' / ')
  const legacyUnnamed = legacyPlans.map(value => /^Plano (\d+)$/.exec(value))
  if (legacyUnnamed.some(Boolean)) {
    return legacyPlans.map((value, index) => {
      const match = legacyUnnamed[index]
      if (!match) return tools.t('quota.plan', value)
      const planIndex = Number(match[1])
      return tools.t('protocol.plan.unnamed', ...numberArguments(planIndex, tools))
    }).join(' / ')
  }
  if (provider.plan) return tools.t('quota.plan', provider.plan)
  return fallback
}

function Provider({ provider: p, ctx, tools }) {
  const groups = new Map()
  for (const w of p.windows) {
    const group = displayText(w.display?.group, w.group, tools, 'group')
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(w)
  }
  const statusKey = `quota.status.${p.status}`
  const statusValue = tools.t(statusKey)
  const status = statusValue === statusKey ? p.status : statusValue
  const defaultPlan = { 'openai-codex': tools.t('quota.openaiPlan'), anthropic: tools.t('quota.anthropicPlan'), deepseekv4pro: 'deepseekv4pro.com', zai: 'Coding Plan' }[p.id]
  const plan = providerPlanText(p, tools, defaultPlan)
  return jsxs('section', { className: 'pl-section', 'aria-labelledby': `pl-${p.id}`, children: [
    jsxs('div', { className: 'pl-section-head', children: [
      jsxs('div', { className: 'pl-identity', children: [h('span', { className: 'pl-mark', 'aria-hidden': true, children: { 'openai-codex': '>_', anthropic: 'Cl', deepseekv4pro: 'ds', zai: 'Z' }[p.id] }), jsxs('div', { children: [h('h2', { id: `pl-${p.id}`, children: p.name }), h('div', { className: 'pl-plan', children: plan })] })] }),
      jsxs('div', { className: 'pl-status', children: [p.status === 'ok' && h('span', { className: 'pl-status-dot' }), status] })
    ] }),
    (p.problem || p.error) && jsxs('div', { className: 'pl-alert', role: 'status', children: [h(Codicon, { name: 'warning' }), jsxs('div', { children: [p.status === 'stale' && h('strong', { children: tools.t('quota.staleNotice') }), localizedError(p.problem, p.error, tools)] })] }),
    ...Array.from(groups, ([group, windows]) => jsxs('div', { className: 'pl-group', children: [h('h3', { className: 'pl-group-title', children: group }), h('div', { className: 'pl-windows', children: windows.map(w => h(Meter, { value: w, tools, providerId: p.id }, w.id)) })] }, group)),
    p.facts?.length > 0 && h('dl', { className: 'pl-facts', children: p.facts.map((fact, i) => h(Fact, { fact, tools }, i)) }),
    jsxs('div', { className: 'pl-source', children: [p.source && h('span', { children: tools.t('quota.source', p.source) }), p.fetched_at && h('time', { dateTime: p.fetched_at, children: tools.t('quota.fetchedAt', tools.dateTime.format(new Date(p.fetched_at))) }), p.url && ctx.os?.openExternal && h(Button, { variant: 'link', size: 'inline', onClick: () => ctx.os.openExternal(p.url), children: tools.t('quota.openProvider') })] })
  ] })
}

function costText(row, tools) {
  if (row.cost_state === 'included') return tools.t('history.included')
  const parts = []
  if (isNumber(row.actual_cost_usd)) parts.push(tools.usd.format(row.actual_cost_usd))
  if (isNumber(row.estimated_cost_usd)) parts.push(tools.t('history.estimated', tools.usd.format(row.estimated_cost_usd)))
  if (!parts.length) return tools.t('history.unrecorded')
  const value = parts.length === 2 ? tools.t('history.combinedCost', parts[0], parts[1]) : parts[0]
  return row.cost_state === 'mixed' ? tools.t('history.partial', value) : value
}

const modelName = (row, tools) => (
  row.model_missing === true || (row.model_missing == null && row.model === 'Não registado')
    ? tools.t('history.unrecordedModel')
    : row.model
)
const taskName = (task, tools) => {
  const key = `history.task.${task}`
  const value = tools.t(key)
  return value === key ? task : value
}

function ModelTable({ rows, tasks = false, tools }) {
  const headings = [tasks ? tools.t('history.columns.modelTask') : tools.t('history.columns.model'), tools.t('history.columns.input'), tools.t('history.columns.output'), tools.t('history.columns.cacheRead'), tools.t('history.columns.cacheWrite'), tools.t('history.columns.reasoning'), tools.t('history.columns.total'), tools.t('history.columns.costUsd')]
  return h('div', { className: 'pl-table-wrap', tabIndex: 0, role: 'region', 'aria-label': tasks ? tools.t('history.aria.modelTasks') : tools.t('history.aria.modelSummary'), children: jsxs('table', { className: 'pl-table', children: [
    h('thead', { children: h('tr', { children: headings.map(label => h('th', { scope: 'col', children: label }, label)) }) }),
    h('tbody', { children: rows.map((r, index) => jsxs('tr', { children: [jsxs('td', { children: [modelName(r, tools), tasks && h('div', { className: 'pl-task', children: taskName(r.task, tools) }), r.attribution === 'session_summary' && h('div', { className: 'pl-task', children: tools.t('history.legacySummary') })] }), ...['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens'].map(k => h('td', { className: 'pl-numeric', children: tools.number.format(r[k] || 0) }, k)), h('td', { children: costText(r, tools) })] }, `${r.model}-${index}`)) })
  ] }) })
}

function SessionRows({ session: s, tools }) {
  const [open, setOpen] = useState(false)
  const row = s.summary
  const titleMissing = s.title_missing === true || (s.title_missing == null && s.title === 'Sessão sem título')
  const title = titleMissing ? tools.t('history.untitledSession') : s.title
  return [jsxs('tr', { children: [
    jsxs('td', { children: [h('div', { className: 'pl-session-title', children: title }), h('div', { className: 'pl-session-id', children: `${s.session_id} · ${s.source}` }), h('div', { className: 'pl-session-models', children: [...new Set(s.models.map(m => modelName(m, tools)))].map(name => h('span', { children: name }, name)) }), h(Button, { variant: 'link', size: 'inline', 'aria-expanded': open, 'aria-controls': `pl-detail-${s.session_id}`, onClick: () => setOpen(v => !v), children: open ? tools.t('history.hideDetails') : tools.t('history.showModelsTasks') })] }),
    jsxs('td', { className: 'pl-numeric', children: [tools.number.format(row.total_tokens), h('div', { className: 'pl-submeasure', children: tools.t('history.inputOutput', tools.number.format(row.input_tokens + row.cache_read_tokens + row.cache_write_tokens), tools.number.format(row.output_tokens)) })] }),
    h('td', { className: 'pl-numeric', children: tools.number.format(row.api_call_count ?? row.calls ?? 0) }),
    h('td', { children: costText(row, tools) }),
    h('td', { title: tools.t('history.creditsTooltip'), children: '—' })
  ] }, s.session_id), open && h('tr', { className: 'pl-detail-row', id: `pl-detail-${s.session_id}`, children: jsxs('td', { colSpan: 5, children: [h(ModelTable, { rows: s.models, tasks: true, tools }), h('p', { className: 'pl-note', children: tools.t('history.footnotes') })] }) }, `${s.session_id}-details`)]
}
function UsageHistory({ ctx, provider, profile, connection, tools }) {
  const [search, setSearch] = useState('')
  const [needle, setNeedle] = useState('')
  const [modelFilter, setModelFilter] = useState(null)
  const [sort, setSort] = useState('tokens')
  const [offset, setOffset] = useState(0)
  useEffect(() => { const timer = setTimeout(() => { setNeedle(search); setOffset(0) }, 300); return () => clearTimeout(timer) }, [search])
  const query = useQuery({
    queryKey: ['provider-limits-history', 2, connection, profile, provider, needle,
      modelFilter?.value ?? '', modelFilter?.model_missing ?? null, sort, offset],
    queryFn: () => {
      const params = { provider, profile, q: needle, model: modelFilter?.value ?? '', sort, offset: String(offset), limit: '25' }
      if (modelFilter?.model_missing != null) params.model_missing = String(modelFilter.model_missing)
      return ctx.rest(`/history?${new URLSearchParams(params)}`, { method: 'GET', timeoutMs: 15000 })
    },
    staleTime: 10000, refetchInterval: q => q.state.error ? false : 60000, refetchIntervalInBackground: false, retry: false
  })
  const d = query.data
  const problem = query.error || d?.problem || d?.error
  const historyErrorText = localizedError(d?.problem, d?.error || query.error, tools, 'error.historyUnavailable')
  const coverage = d?.coverage || {}
  const byModel = Array.isArray(d?.by_model_v2) ? d.by_model_v2 : d?.by_model || []
  const modelOptions = Array.isArray(d?.model_options_v2)
    ? d.model_options_v2.map(option => ({
        key: `v2:${option.model_missing ? 'missing' : 'model'}:${option.value}`,
        value: option.value,
        model_missing: option.model_missing,
        label: option.model_missing ? tools.t('history.unrecordedModel') : option.value
      }))
    : (d?.model_options || (modelFilter ? [modelFilter.value] : [])).map(value => ({
        key: `v1:${value}`, value, model_missing: null,
        label: value === 'Não registado' ? tools.t('history.unrecordedModel') : value
      }))
  return jsxs('section', { className: 'pl-history', 'aria-label': tools.t('history.aria.section'), children: [
    jsxs('div', { className: 'pl-history-top', children: [jsxs('div', { children: [h('h2', { children: tools.t('history.title') }), h('p', { className: 'pl-description', children: tools.t('history.subtitle') })] }), h(Button, { variant: 'ghost', size: 'sm', disabled: query.isFetching, onClick: () => query.refetch(), children: tools.t('history.refresh') })] }),
    jsxs('div', { className: 'pl-history-tools', children: [h('div', { className: 'pl-search', children: h(Input, { 'aria-label': tools.t('history.searchAria'), placeholder: tools.t('history.searchPlaceholder'), value: search, onChange: e => setSearch(e.target.value) }) }),
      h('div', { className: 'pl-select-wrap', children: h(Select, { value: modelFilter?.key || ALL_MODELS, onValueChange: value => { setModelFilter(value === ALL_MODELS ? null : (modelOptions.find(option => option.key === value) || null)); setOffset(0) }, children: [h(SelectTrigger, { className: 'pl-select-trigger', 'aria-label': tools.t('history.modelFilterAria'), children: h(SelectValue, {}) }), h(SelectContent, { children: [h(SelectItem, { className: 'pl-select-item', value: ALL_MODELS, children: tools.t('history.allModels') }), ...modelOptions.map(option => h(SelectItem, { className: 'pl-select-item', value: option.key, children: option.label }, option.key))] })] }) }),
      h('div', { className: 'pl-select-wrap', children: h(Select, { value: sort, onValueChange: value => { setSort(value); setOffset(0) }, children: [h(SelectTrigger, { className: 'pl-select-trigger', 'aria-label': tools.t('history.sortAria'), children: h(SelectValue, {}) }), h(SelectContent, { children: [h(SelectItem, { className: 'pl-select-item', value: 'tokens', children: tools.t('history.sortTokens') }), h(SelectItem, { className: 'pl-select-item', value: 'recent', children: tools.t('history.sortRecent') })] })] }) })] }),
    query.isPending && h('p', { className: 'pl-loading', role: 'status', children: tools.t('history.loading') }),
    problem && h('div', { className: 'pl-alert', role: 'alert', children: historyErrorText }),
    d && !problem && jsxs('div', { children: [
      h('dl', { className: 'pl-stat-strip', children: [{ label: tools.t('history.tokensRecorded'), value: d.totals.total_tokens }, { label: tools.t('history.sessions'), value: d.total_sessions }, { label: tools.t('history.models'), value: byModel.length }, { label: tools.t('history.sessionCredits'), value: tools.t('history.notRecorded') }].map(f => h(Fact, { fact: f, tools }, f.label)) }),
      h('p', { className: 'pl-note', children: `${tools.t('history.accumulatedPeriod')} ${tools.t('history.costNote')}` }),
      coverage.unattributed_main_tokens_in_profile > 0 && h('p', { className: 'pl-history-warning', children: tools.t('history.unattributed', ...numberArguments(coverage.unattributed_main_tokens_in_profile, tools)) }),
      coverage.legacy_sessions > 0 && h('p', { className: 'pl-note', children: tools.t('history.legacySessions', ...numberArguments(coverage.legacy_sessions, tools)) }),
      byModel.length > 0 && jsxs('details', { className: 'pl-model-details pl-model-summary', children: [h('summary', { children: tools.t('history.modelSummary', ...numberArguments(byModel.length, tools)) }), h(ModelTable, { rows: byModel, tools })] }),
      d.sessions.length > 0 ? h('div', { className: 'pl-table-wrap', tabIndex: 0, role: 'region', 'aria-label': tools.t('history.aria.sessions'), children: jsxs('table', { className: 'pl-table', children: [h('thead', { children: h('tr', { children: [tools.t('history.columns.sessionModels'), tools.t('history.columns.tokens'), tools.t('history.columns.calls'), tools.t('history.columns.costUsd'), tools.t('history.columns.credits')].map(label => h('th', { scope: 'col', children: label }, label)) }) }), h('tbody', { children: d.sessions.map(s => h(SessionRows, { session: s, tools }, s.session_id)) })] }) }) : h('p', { className: 'pl-empty', children: needle || modelFilter ? tools.t('history.noFilteredSessions') : tools.t('history.noProviderUsage') }),
      jsxs('div', { className: 'pl-pagination', children: [h('span', { children: d.total_sessions
        ? tools.t('history.range', ...numberArguments(offset + 1, tools), ...numberArguments(Math.min(offset + d.sessions.length, d.total_sessions), tools), ...numberArguments(d.total_sessions, tools))
        : tools.t('history.zeroSessions', ...numberArguments(0, tools)) }), jsxs('div', { className: 'pl-pagination-actions', children: [h(Button, { variant: 'secondary', size: 'sm', disabled: offset === 0 || query.isFetching, onClick: () => setOffset(Math.max(0, offset - 25)), children: tools.t('history.previous') }), h(Button, { variant: 'secondary', size: 'sm', disabled: !d.has_more || query.isFetching, onClick: () => setOffset(offset + 25), children: tools.t('history.next') })] })] }),
      h('p', { className: 'pl-source', children: tools.t('history.scopeFooter', d.source) })
    ] })
  ] })
}

const FIVE_HOURS = 18_000
const SEVEN_DAYS = 604_800
const clampPercent = value => Math.max(0, Math.min(100, value))
const roundPercent = value => Math.round(clampPercent(value))
const statusPercent = (value, tools) => tools.percent.format(roundPercent(value) / 100)

export function selectProviderWindows(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : []
  let relevant
  let weeklyMatches
  if (provider?.id === 'anthropic') {
    relevant = windows.filter(item =>
      (item.id === 'five_hour' && item.period_seconds === FIVE_HOURS) ||
      (item.id === 'seven_day' && item.period_seconds === SEVEN_DAYS) ||
      (item.id?.startsWith('weekly_scoped_') && item.period_seconds === SEVEN_DAYS))
    weeklyMatches = relevant.filter(item => item.id === 'seven_day' && item.period_seconds === SEVEN_DAYS)
  } else if (provider?.id === 'openai-codex') {
    relevant = windows.filter(item => item.group === 'Codex')
    weeklyMatches = relevant.filter(item => item.period_seconds === SEVEN_DAYS)
  } else if (provider?.id === 'zai') {
    relevant = windows.filter(item => item.unit_code === 'token')
    weeklyMatches = relevant.filter(item => item.period_seconds === SEVEN_DAYS)
  } else {
    relevant = []
    weeklyMatches = []
  }
  relevant = [...relevant].sort((a, b) => (a.period_seconds || Infinity) - (b.period_seconds || Infinity))
  return { weekly: weeklyMatches.length === 1 ? weeklyMatches[0] : null, relevant }
}

export function quotaPaceState(window, providerStatus = 'ok', now = Date.now()) {
  const used = numeric(window?.used_percent)
  const periodSeconds = numeric(window?.period_seconds)
  const resetAt = Date.parse(window?.reset_at || '')
  const base = { used, allowance: null, projection: null, level: 'normal', resetAt: Number.isFinite(resetAt) ? resetAt : null }
  if (used === null || periodSeconds === null || periodSeconds <= 0 || !Number.isFinite(resetAt) ||
      resetAt <= now || window?.rolling === true || providerStatus !== 'ok') return base
  const elapsed = 1 - ((resetAt - now) / (periodSeconds * 1000))
  if (elapsed <= 0.020000001 || elapsed > 1) return base
  const allowance = Math.round(clampPercent(elapsed * 100))
  const projection = Math.round(used / elapsed)
  const level = projection >= 150 ? 'critical' : projection >= 125 ? 'warning' : projection > 100 ? 'caution' : 'normal'
  return { ...base, allowance, projection, level }
}

export function paceSegments(usedValue, allowanceValue) {
  const used = clampPercent(numeric(usedValue) ?? 0)
  const allowance = clampPercent(numeric(allowanceValue) ?? 0)
  return {
    used: Math.min(used, allowance),
    paceRoom: Math.max(0, allowance - used),
    overPace: Math.max(0, used - allowance),
    remaining: Math.max(0, 100 - Math.max(used, allowance))
  }
}

const compactQuotaBar = value => {
  const cells = Math.round(clampPercent(value) / 10)
  return `[${'█'.repeat(cells)}${'░'.repeat(10 - cells)}]`
}
const compactDuration = (seconds, tools) => {
  const total = Math.max(0, Math.floor(seconds))
  const part = (value, unit) => tools.t('duration.short', tools.number.format(value), unit, value)
  if (total >= 86400) return `${part(Math.floor(total / 86400), 'day')} ${part(Math.floor((total % 86400) / 3600), 'hour')}`
  if (total >= 3600) return `${part(Math.floor(total / 3600), 'hour')} ${part(Math.floor((total % 3600) / 60), 'minute')}`
  if (total >= 60) return part(Math.floor(total / 60), 'minute')
  return part(total, 'second')
}

export function effectiveProviderAge(provider, now = Date.now(), dataUpdatedAt) {
  const reportedAge = numeric(provider?.age_seconds)
  const sinceReceipt = Number.isFinite(dataUpdatedAt) && dataUpdatedAt > 0
    ? Math.max(0, (now - dataUpdatedAt) / 1000) : 0
  const reported = reportedAge === null ? null : reportedAge + sinceReceipt
  const fetchedAt = Date.parse(provider?.fetched_at || '')
  const elapsed = Number.isFinite(fetchedAt) ? Math.max(0, (now - fetchedAt) / 1000) : null
  if (reported === null) return elapsed
  if (elapsed === null) return reported
  return Math.max(reported, elapsed)
}

const MAX_QUOTA_AGE_SECONDS = 900

function providerForDisplay(provider, interrupted, now, dataUpdatedAt) {
  if (!['ok', 'stale'].includes(provider.status)) return provider
  const age = effectiveProviderAge(provider, now, dataUpdatedAt)
  if (age > MAX_QUOTA_AGE_SECONDS || (age === null && interrupted)) return {
    ...provider, status: 'unavailable', windows: [], facts: [], plan: null, plan_display: null,
    age_seconds: age, problem: { code: 'provider.fetchFailed', params: {}, retryable: true }
  }
  return { ...provider, status: interrupted ? 'stale' : provider.status, age_seconds: age }
}

function useQuotaProviders(query, enabled = true) {
  const [revision, setRevision] = useState(0)
  // A paused observer need not emit again. Expire its display at the age
  // ceiling even while offline; this timeout never fetches or mutates cache.
  useEffect(() => {
    if (!enabled) return
    const now = Date.now()
    const delays = (query.data?.providers || []).flatMap(provider => {
      if (!['ok', 'stale'].includes(provider.status)) return []
      const age = effectiveProviderAge(provider, now, query.dataUpdatedAt)
      return age !== null && age <= MAX_QUOTA_AGE_SECONDS
        ? [Math.max(1, Math.ceil((MAX_QUOTA_AGE_SECONDS - age) * 1000) + 1)] : []
    })
    if (!delays.length) return
    const timer = setTimeout(() => setRevision(value => value + 1), Math.min(...delays))
    return () => clearTimeout(timer)
  }, [query.data, query.dataUpdatedAt, enabled, revision])
  const now = Date.now()
  const interrupted = Boolean(query.error) || query.fetchStatus === 'paused'
  return (query.data?.providers || []).map(provider => providerForDisplay(provider, interrupted, now, query.dataUpdatedAt))
}

const statusWindowLabel = (window, tools) => window.id?.startsWith('weekly_scoped_')
  ? displayText(window.display?.label, window.label, tools, 'window')
  : window.period_seconds === FIVE_HOURS
  ? tools.t('statusBar.fiveHour')
  : window.period_seconds === SEVEN_DAYS ? tools.t('statusBar.weekly') : displayText(window.display?.label, window.label, tools, 'window')

function PaceBar({ state, label, tools }) {
  const used = clampPercent(state.used ?? 0)
  const segments = state.allowance === null ? { used, paceRoom: 0, overPace: 0, remaining: 100 - used } : paceSegments(used, state.allowance)
  const usedText = statusPercent(used, tools)
  const aria = state.allowance === null
    ? tools.t('statusBar.usedAria', label, usedText)
    : tools.t('statusBar.paceAria', label, usedText, statusPercent(state.allowance, tools))
  return h('div', { className: 'pl-pace-track', role: 'progressbar', 'aria-label': aria,
    'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': used,
    children: Object.entries(segments).map(([name, width]) => width > 0 && h('i', {
      'data-segment': name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`),
      style: { width: `${width}%` }
    }, name)) })
}

function StatusWindow({ window, provider, tools, now }) {
  const state = quotaPaceState(window, provider.status, now)
  const label = statusWindowLabel(window, tools)
  const used = state.used === null ? null : roundPercent(state.used)
  const usedText = used === null ? null : statusPercent(used, tools)
  const resetText = state.resetAt === null ? tools.t('statusBar.resetUnknown')
    : state.resetAt <= now ? tools.t('statusBar.resetPending')
      : tools.t(window.rolling === true ? 'statusBar.nextRefreshIn' : 'statusBar.resetIn', compactDuration((state.resetAt - now) / 1000, tools))
  return jsxs('section', { className: 'pl-status-window', children: [
    jsxs('div', { className: 'pl-status-window-head', children: [
      h('span', { children: label }),
      used === null ? h('span', { children: tools.t('statusBar.unavailable') }) : jsxs('span', { children: [
        provider.status === 'stale' ? tools.t('statusBar.lastKnownUsed', usedText) : tools.t('statusBar.used', usedText),
        state.allowance !== null && h('b', { className: 'pl-pace-value', children: `[${statusPercent(state.allowance, tools)}]` })
      ] })
    ] }),
    used !== null && h(PaceBar, { state, label, tools }),
    h('div', { className: 'pl-status-reset', children: resetText }),
    state.resetAt !== null && h('time', { dateTime: new Date(state.resetAt).toISOString(), children: tools.statusDateTime.format(new Date(state.resetAt)) })
  ] })
}

function ProviderGauge({ provider, query, profile, connection, tools, transportError = false }) {
  const now = Date.now()
  const { weekly, relevant } = selectProviderWindows(provider)
  const weeklyState = weekly ? quotaPaceState(weekly, provider.status, now) : null
  const used = weeklyState?.used === null || weeklyState?.used === undefined ? null : roundPercent(weeklyState.used)
  const usedText = used === null ? null : statusPercent(used, tools)
  const providerLabel = tools.t(`statusBar.provider.${provider.id}`)
  const title = tools.t('statusBar.usageTitle', providerLabel)
  const nextRefresh = Date.parse(provider.next_refresh_at || '')
  const cooldown = Number.isFinite(nextRefresh) ? Math.max(0, (nextRefresh - now) / 1000) : 0
  const refreshDisabled = query.isFetching || cooldown > 0
  const age = effectiveProviderAge(provider, now)
  const baseFreshness = provider.status === 'stale'
    ? `${tools.t('statusBar.freshness.stale')} · ${tools.t('statusBar.cachedAgo', compactDuration(age ?? 0, tools))}`
    : provider.status === 'ok'
      ? `${tools.t('statusBar.freshness.fresh')} · ${tools.t('statusBar.checkedAgo', compactDuration(age ?? 0, tools))}`
      : tools.t('statusBar.freshness.unavailable')
  const providerIssue = provider.problem || provider.error ? localizedError(provider.problem, provider.error, tools) : null
  const issue = providerIssue || (transportError ? tools.t('error.refreshBody') : null)
  const freshness = issue ? `${baseFreshness} · ${issue}` : baseFreshness
  const resetFact = ['ok', 'stale'].includes(provider.status) ? provider.facts?.find(fact =>
    (fact.display?.label || legacyDescriptor(fact.label, 'factLabel'))?.code === 'fact.availableResets') : null
  const resets = Number.isSafeInteger(resetFact?.value) && resetFact.value >= 0 ? resetFact.value : null
  return h(Popover, { children: [
    h(PopoverTrigger, { asChild: true, children: h('button', {
      type: 'button', 'aria-label': title, 'data-provider-chip': provider.id,
      className: 'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
      children: used === null
        ? `${providerLabel} · ${tools.t('statusBar.unavailable')}`
        : [
            h('span', { className: 'text-(--ui-text-tertiary)', children: `${providerLabel} · ${tools.t('statusBar.weeklyShort')}` }),
            h('span', { className: 'tabular-nums pl-status-chip-value', 'data-level': weeklyState.level, children: `${compactQuotaBar(used)} ${usedText}` }),
            weeklyState.allowance !== null && h('span', { className: 'pl-status-chip-pace', children: `[${statusPercent(weeklyState.allowance, tools)}]` }),
            provider.status === 'stale' && h('span', { className: 'text-(--ui-text-quaternary)', children: '∗' })
          ]
    }) }),
    h(PopoverContent, { side: 'top', align: 'end', 'aria-label': title, className: 'pl-status-popover', children: [
      jsxs('div', { className: 'pl-status-popover-head', children: [h('h3', { children: title }), provider.plan && h('span', { children: provider.plan })] }),
      relevant.length ? h('div', { className: 'pl-status-window-list', children: relevant.map(window => h(StatusWindow, { window, provider, tools, now }, `${window.id}:${window.period_seconds}`)) }) : h('p', { children: tools.t('statusBar.unavailable') }),
      h('div', { className: 'pl-pace-legend', children: ['used', 'paceRoom', 'overPace'].map(name => jsxs('span', { children: [h('i', { 'data-legend': name }), tools.t(`statusBar.legend.${name}`)] }, name)) }),
      ['anthropic', 'openai-codex'].includes(provider.id) && h('dl', { className: 'pl-status-resets', children: h(Fact, {
        tools, fact: { value: resets, display: {
          label: { kind: 'message', code: 'fact.availableResets' },
          ...(resets === null ? { value: { kind: 'message', code: 'value.notIndicated' } } : {})
        } }
      }) }),
      h('div', { className: 'pl-status-freshness', children: freshness }),
      h(Button, { variant: 'secondary', size: 'sm', disabled: refreshDisabled, onClick: () => { if (!refreshDisabled) query.refetch() }, children: query.isFetching ? tools.t('action.refreshing') : cooldown > 0 ? tools.t('statusBar.refreshEligible', compactDuration(cooldown, tools)) : tools.t('action.refresh') }),
      h('div', { className: 'pl-status-provenance', children: tools.t('statusBar.provenance', profile, connection) })
    ] })
  ] })
}

export function StatusGaugeRoot({ ctx }) {
  const tools = useLocaleTools()
  const profile = useValue(host.state.profile) || 'default'
  const hasConnectionState = Boolean(host.state.connectionId)
  const connectionValue = useValue(host.state.connectionId || host.state.profile)
  const connection = hasConnectionState ? connectionValue : null
  const preferences = useValue(statusGaugePreferencesAtom)
  const scoped = gaugePreferencesForScope(preferences, connection, profile)
  const enabledIds = GAUGE_PROVIDER_IDS.filter(id => scoped[id])
  const query = useQuery(quotaQueryOptions(ctx, connection, profile, enabledIds.length > 0))
  const displayProviders = useQuotaProviders(query, enabledIds.length > 0)

  if (!enabledIds.length) return null
  if (query.error && isBackendUnavailableError(query.error)) {
    return h('span', { role: 'status', children: tools.t('statusBar.backendUnavailable') })
  }
  if (query.data?.problem || query.data?.error) {
    return h('span', { role: 'alert', children: localizedError(query.data.problem, query.data.error, tools) })
  }
  if (query.error && !query.data) {
    return h('span', { role: 'alert', children: tools.t('error.refreshBody') })
  }
  const providers = new Map(displayProviders.map(item => [item.id, item]))
  const chips = enabledIds.flatMap(providerId => {
    const provider = providers.get(providerId)
    if (!provider) return []
    return [h(ProviderGauge, { provider, query, profile, connection, tools, transportError: Boolean(query.error) }, providerId)]
  })
  return chips.length ? h('div', { className: 'pl-status-gauges', 'data-gauge-count': chips.length,
    style: { '--pl-gauge-count': chips.length }, children: [
    h('style', { children: STATUS_CSS }),
    h('button', { type: 'button', className: 'pl-status-compact',
      'aria-label': tools.t('command.open'), onClick: () => host.navigate(PATH),
      children: `${tools.t('nav.usage')} · ${enabledIds.length}` }),
    ...chips
  ] }) : null
}

function StatusGaugeSettings({ connection, profile, tools }) {
  const preferences = useValue(statusGaugePreferencesAtom)
  const scoped = gaugePreferencesForScope(preferences, connection, profile)
  return jsxs('section', { className: 'pl-gauge-settings', 'aria-labelledby': 'pl-statusbar-title', children: [
    h('h2', { id: 'pl-statusbar-title', children: tools.t('statusBar.title') }),
    h('p', { className: 'pl-description', children: tools.t('statusBar.description') }),
    h('div', { className: 'pl-gauge-grid', children: GAUGE_PROVIDER_IDS.map(providerId => {
      const label = tools.t(`statusBar.provider.${providerId}`)
      return jsxs('label', { className: 'pl-gauge-option', children: [
        h('span', { children: label }),
        h(Switch, { checked: scoped[providerId], 'aria-label': label, onCheckedChange: checked => setGaugePreference(connection, profile, providerId, checked) })
      ] }, providerId)
    }) }),
    h('p', { className: 'pl-gauge-note', children: tools.t('statusBar.defaultOff') })
  ] })
}

export function QuotaPage({ ctx }) {
  const tools = useLocaleTools()
  const t = tools.t
  const profile = useValue(host.state.profile) || 'default'
  // Old Desktop plugin hosts ignored requires_hermes and can still evaluate a
  // copied plugin.js. Keep the hook shape stable while avoiding useValue(undefined)
  // when their SDK predates host.state.connectionId.
  const hasConnectionState = Boolean(host.state.connectionId)
  const connectionValue = useValue(host.state.connectionId || host.state.profile)
  const connection = hasConnectionState ? connectionValue : null
  const client = useQueryClient()
  const [preferred, setPreferred] = useState('')
  const query = useQuery(quotaQueryOptions(ctx, connection, profile))
  const providers = useQuotaProviders(query)
  const selected = providers.some(p => p.id === preferred) ? preferred : providers[0]?.id || ''
  const count = providers.reduce((n, p) => n + p.windows.length, 0)
  const refreshSeconds = query.data?.refresh_seconds || 60
  const refreshMinutes = Math.max(1, Math.round(refreshSeconds / 60))
  const backendMissing = query.error && isBackendUnavailableError(query.error)
  return jsxs('div', { className: 'pl-page', children: [h('style', { children: CSS }), jsxs('div', { className: 'pl-content', children: [
    jsxs('header', { className: 'pl-header', children: [jsxs('div', { children: [h('h1', { children: t('meta.title') }), h('p', { className: 'pl-description', children: t('page.subtitle') })] }), jsxs(Button, { variant: 'secondary', size: 'sm', disabled: query.isFetching, onClick: () => { query.refetch(); client.invalidateQueries({ queryKey: ['provider-limits-history', 2, connection, profile] }) }, children: [h(Codicon, { name: 'refresh' }), query.isFetching ? t('action.refreshing') : t('action.refresh')] })] }),
    jsxs('div', { className: 'pl-meta', children: [jsxs('span', { className: 'pl-profile', children: [h(Codicon, { name: 'account' }), t('page.profile', profile)] }), query.data && h('span', { children: t('page.activeSummary', ...numberArguments(providers.length, tools), ...numberArguments(count, tools)) }), h('span', { children: t('page.autoRefresh', ...numberArguments(refreshMinutes, tools)) })] }),
    h(StatusGaugeSettings, { connection, profile, tools }),
    query.isPending && h('div', { className: 'pl-loading', role: 'status', 'aria-live': 'polite', children: jsxs('div', { children: [t('page.loading'), h('div', { className: 'pl-loading-lines', 'aria-hidden': true, children: [h('span', {}), h('span', {}), h('span', {})] })] }) }),
    (query.error || query.data?.problem || query.data?.error) && jsxs('div', { className: 'pl-alert', role: 'alert', children: [h(Codicon, { name: 'info' }), jsxs('div', { children: [h('strong', { children: backendMissing ? t('error.backendMissingTitle') : t('error.refreshTitle') }), backendMissing ? t('error.backendMissingBody') : localizedError(query.data?.problem, query.data?.error || query.error, tools, 'error.refreshBody')] })] }),
    !query.isPending && !query.error && !query.data?.problem && !query.data?.error && providers.length === 0 && jsxs('div', { className: 'pl-empty', children: [h(Codicon, { name: 'plug' }), h('h2', { children: t('page.noProvidersTitle') }), h('p', { children: t('page.noProvidersBody') })] }),
    providers.length > 0 && jsxs(Tabs, { value: selected, onValueChange: setPreferred, children: [
      h(TabsList, { className: 'pl-tabs-list', 'aria-label': t('page.providersAria'), children: providers.map(p => h(TabsTrigger, { value: p.id, id: `pl-tab-${p.id}`, 'aria-controls': `pl-panel-${p.id}`, children: p.name }, p.id)) }),
      ...providers.filter(p => p.id === selected).map(p => jsxs('div', { role: 'tabpanel', id: `pl-panel-${p.id}`, 'aria-labelledby': `pl-tab-${p.id}`, tabIndex: 0, children: [h(Provider, { provider: p, ctx, tools }), h(UsageHistory, { ctx, provider: p.id, profile, connection, tools }, `${connection}:${profile}:${p.id}`)] }, p.id))
    ] }),
    h('footer', { className: 'pl-footer', children: t('page.footer', ...numberArguments(refreshSeconds, tools)) })
  ] })] })
}

export default {
  id: ID,
  name: 'Usage and limits',
  description: 'Usage, remaining quota, and resets for active Hermes providers.',
  register(ctx) {
    const registration = { storage: ctx.storage || null }
    preferencesRegistration = registration
    ctx.onDispose(() => {
      // A late old disposer must not detach a newer activation, even when
      // both contexts use the same storage adapter.
      if (preferencesRegistration === registration) preferencesRegistration = null
      registration.storage = null
    })
    statusGaugePreferencesAtom.set(parseGaugePreferences(ctx.storage?.get(PREFS_STORAGE_KEY, null)))
    ctx.i18n.register(LOCALES)
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => h(QuotaPage, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 75, data: { path: PATH, label: ctx.i18n.t('nav.usage'), codicon: 'graph' } },
      { id: 'open', area: PALETTE_AREA, data: { id: 'provider-limits.open', label: ctx.i18n.t('command.open'), keywords: ['quota', 'codex', 'spark', 'claude', 'deepseek', 'glm', 'zai'], run: () => host.navigate(PATH) } },
      { id: 'status-gauges', area: STATUSBAR_AREAS.right, order: 90, render: () => h(StatusGaugeRoot, { ctx }) }
    ])
  }
}
