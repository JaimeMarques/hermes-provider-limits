import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)

function translate(bundles, locale, key, ...args) {
  const resolve = bundle => {
    let value = bundle
    for (const segment of key.split('.')) value = value?.[segment]
    return value
  }
  const value = resolve(bundles?.[locale]) ?? resolve(bundles?.en)
  if (typeof value === 'function') return value(...args)
  return typeof value === 'string' ? value : key
}

async function loadPlugin({
  locale = 'en',
  quotaData = { schema_version: 2, providers: [], problem: null, error: null, refresh_seconds: 60 },
  historyData = null,
  quotaError = null,
  legacyHost = false,
  transformSource = source => source
} = {}) {
  const state = {
    bundles: null, contributions: null, locale, quotaData, historyData,
    // Captured so tests can execute the real queryFn instead of trusting a stub.
    queries: new Map(), restCalls: [], restImpl: null, stored: new Map()
  }
  const context = vm.createContext({
    console, URL, URLSearchParams, Intl, Date, Math, Map, Set, Number, String, Object, Array, Promise,
    setTimeout, clearTimeout, document: { documentElement: { lang: locale } }
  })
  const source = transformSource(await fs.readFile(new URL('desktop/plugin.js', ROOT), 'utf8'))
  const module = new vm.SourceTextModule(source, { context, identifier: 'provider-limits/plugin.js' })
  const synthetic = (id, values) => {
    const names = Object.keys(values)
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, values[name])
    }, { context, identifier: id })
  }
  const hostState = { profile: { key: 'profile' } }
  if (!legacyHost) hostState.connectionId = { key: 'connection' }
  const host = {
    state: hostState,
    navigate() {}
  }
  const Passthrough = props => ({ type: 'sdk', props })
  const sdkComponent = name => props => ({ type: name, props })
  const atom = initial => {
    let value = initial
    return { get: () => value, set: next => { value = next } }
  }
  const sdk = {
    host, atom,
    useValue: store => {
      if (!store) throw new TypeError('useValue requires a store')
      if (typeof store.get === 'function') return store.get()
      return store === host.state.profile ? 'angel' : 'connection-a'
    },
    useQuery: options => {
      state.queries.set(options.queryKey[0], options)
      return options.queryKey[0] === 'provider-limits'
        ? { data: state.quotaData, isPending: false, isFetching: false, error: quotaError, refetch() {} }
        : { data: state.historyData, isPending: false, isFetching: false, error: null, refetch() {} }
    },
    useQueryClient: () => ({ invalidateQueries() {} }),
    usePluginI18n: () => (key, ...args) => translate(state.bundles, state.locale, key, ...args),
    useI18n: () => ({ locale: state.locale }),
    Button: Passthrough, Input: Passthrough, Codicon: Passthrough,
    Switch: sdkComponent('sdk-switch'),
    Popover: sdkComponent('sdk-popover'), PopoverTrigger: sdkComponent('sdk-popover-trigger'),
    PopoverContent: sdkComponent('sdk-popover-content'),
    Select: sdkComponent('Select'), SelectContent: sdkComponent('SelectContent'),
    SelectItem: sdkComponent('SelectItem'), SelectTrigger: sdkComponent('SelectTrigger'),
    SelectValue: sdkComponent('SelectValue'),
    Tabs: Passthrough, TabsList: Passthrough, TabsTrigger: Passthrough,
    ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar', PALETTE_AREA: 'palette',
    STATUSBAR_AREAS: { right: 'status-right' }
  }
  const element = (type, props, key) => ({ type, props: props || {}, key })
  await module.link(specifier => {
    if (specifier === 'react/jsx-runtime') return synthetic(specifier, { jsx: element, jsxs: element })
    if (specifier === 'react') return synthetic(specifier, {
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useEffect: () => {},
      useMemo: fn => fn()
    })
    if (specifier === '@hermes/plugin-sdk') return synthetic(specifier, sdk)
    throw new Error(`Unexpected import: ${specifier}`)
  })
  await module.evaluate()
  const ctx = {
    onDispose() {},
    rest: async (path, init) => {
      state.restCalls.push({ path, init })
      if (state.restImpl) return state.restImpl(path, init)
      return state.historyData
    },
    route: { navigate() {} },
    i18n: {
      register(value) { state.bundles = value },
      t(key, ...args) { return translate(state.bundles, state.locale, key, ...args) }
    },
    registerMany(value) { state.contributions = value },
    storage: {
      get(key, fallback) { return state.stored.has(key) ? state.stored.get(key) : fallback },
      set(key, value) { state.stored.set(key, value) }
    }
  }
  if (!legacyHost) ctx.os = { openExternal() {} }
  module.namespace.default.register(ctx)
  return { mod: module.namespace, state }
}

function flattenText(node) {
  if (node == null || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(flattenText)
  if (typeof node.type === 'function') return flattenText(node.type(node.props || {}))
  return flattenText(node.props?.children)
}

function findNodes(node, predicate) {
  if (node == null || node === false) return []
  if (Array.isArray(node)) return node.flatMap(child => findNodes(child, predicate))
  if (typeof node !== 'object') return []
  if (typeof node.type === 'function') return findNodes(node.type(node.props || {}), predicate)
  return [
    ...(predicate(node) ? [node] : []),
    ...findNodes(node.props?.children, predicate)
  ]
}

const summary = {
  input_tokens: 1200, output_tokens: 300, cache_read_tokens: 40, cache_write_tokens: 10,
  reasoning_tokens: 20, total_tokens: 1550, calls: 2, credits: null,
  cost_state: 'included', actual_cost_usd: 0, estimated_cost_usd: 0, cost_partial: false
}

const quotaData = {
  schema_version: 2, problem: null, error: null, refresh_seconds: 60,
  providers: [{
    id: 'openai-codex', name: 'Codex', status: 'stale', plan: 'plus', source: 'chatgpt.com · wham/usage',
    // Localization fixtures must remain inside the display-age ceiling.
    fetched_at: new Date().toISOString(), error: 'Autenticação expirada ou recusada.',
    problem: { code: 'auth.rejected', params: {}, retryable: false },
    windows: [{
      id: 'review-primary_window', label: '5 h', group: 'Revisão de código', unit: '%', unit_code: 'percent',
      display: {
        label: { kind: 'period', value: 5, unit: 'hour' },
        group: { kind: 'message', code: 'group.codeReview' }
      },
      used: null, limit: null, remaining: null, used_percent: 12, remaining_percent: 88,
      reset_at: null, unlimited: false,
      details: [{ label: 'Reposições disponíveis', value: 2,
        display: { label: { kind: 'message', code: 'fact.availableResets' } } }]
    }],
    facts: [{ label: 'Créditos adicionais', value: 'Ilimitados',
      display: { label: { kind: 'message', code: 'fact.additionalCredits' },
        value: { kind: 'message', code: 'value.unlimited' } }, unit_code: 'api_credit' }]
  }]
}

const historyData = {
  schema_version: 2, problem: null, error: null,
  provider: 'openai-codex', period: 'Histórico acumulado das sessões.', period_code: 'accumulated_sessions',
  source: 'Hermes · state.db / session_model_usage', source_code: 'hermes_session_model_usage',
  totals: summary, by_model: [{ model: 'Não registado', ...summary }],
  by_model_v2: [{ model: 'Não registado', model_missing: true, ...summary }],
  model_options: ['Não registado'],
  model_options_v2: [{ value: '', model_missing: true }],
  total_sessions: 1, offset: 0, limit: 25, has_more: false,
  coverage: { ledger_available: true, legacy_sessions: 0, unattributed_main_tokens_in_profile: 0, credits_recorded: false },
  sessions: [{
    session_id: 'session-1', title: 'Sessão sem título', title_missing: true, source: 'unknown',
    parent_session_id: null, last_seen: 1, summary,
    models: [{ model: 'Não registado', model_missing: true, task: 'vision', attribution: 'ledger',
      first_seen: 1, last_seen: 1, ...summary }]
  }]
}

test('registers extensible locale bundles and English desktop chrome', async () => {
  const { mod, state } = await loadPlugin()

  assert.equal(state.bundles.en.meta.title, 'Usage and limits')
  assert.equal(Object.keys(state.bundles).join(','), 'en')
  assert.equal(state.contributions.find(item => item.area === 'sidebar').data.label, 'Usage')
  assert.equal(state.contributions.find(item => item.area === 'palette').data.label, 'Open usage and limits')
  assert.equal(mod.default.name, 'Usage and limits')
})

test('renders the empty provider page in English from the active Hermes locale', async () => {
  const { state } = await loadPlugin()
  const page = state.contributions.find(item => item.area === 'routes').render()
  const text = flattenText(page).join(' ')

  assert.match(text, /Usage and limits/)
  assert.match(text, /Account quotas and Hermes usage, session by session\./)
  assert.match(text, /No supported providers are active/)
  assert.doesNotMatch(text, /Utilização|fornecedor|Consulta|Nenhum destes/)
})

test('page transport failures honor the same stale ceiling and hard provider state as status gauges', async () => {
  for (const expired of [false, true]) {
    const provider = { ...quotaData.providers[0], status: expired ? 'ok' : 'unavailable',
      fetched_at: new Date(Date.now() - 901_000).toISOString(), age_seconds: 0,
      windows: expired ? quotaData.providers[0].windows : [], facts: [],
      problem: expired ? null : { code: 'auth.rejected', params: {}, retryable: false }, error: null }
    const { state } = await loadPlugin({
      quotaData: { ...quotaData, providers: [provider] }, quotaError: new Error('connection refused')
    })
    const page = state.contributions.find(item => item.area === 'routes').render()
    const text = flattenText(page).join(' ')
    assert.match(text, /Unavailable/)
    assert.equal(findNodes(page, node => node.props?.role === 'progressbar').length, 0)
    if (!expired) assert.match(text, /Authentication expired or denied/)
  }
})

test('renders three default-off accessible status gauge switches and updates shared preferences', async () => {
  const { mod, state } = await loadPlugin()
  const page = state.contributions.find(item => item.area === 'routes').render()
  const switches = findNodes(page, node => node.type === 'sdk-switch')

  assert.equal(switches.length, 3)
  assert.deepEqual(switches.map(node => node.props.checked), [false, false, false])
  assert.deepEqual(switches.map(node => node.props['aria-label']), ['Claude', 'GPT', 'GLM / Z.ai'])

  switches[0].props.onCheckedChange(true)
  assert.equal(mod.gaugePreferencesForScope(mod.statusGaugePreferencesAtom.get(), 'connection-a', 'angel').anthropic, true)
  assert.equal(state.stored.get('statusGaugePreferences.v1').version, 1)
})

test('adapts staggered legacy backend payloads to English during hot reload', async () => {
  const legacyQuota = JSON.parse(JSON.stringify(quotaData))
  delete legacyQuota.schema_version
  legacyQuota.providers[0].problem = null
  legacyQuota.providers[0].error = 'Autenticação expirada ou recusada. Verifique o fornecedor no Hermes.'
  for (const window of legacyQuota.providers[0].windows) {
    delete window.display
    delete window.unit_code
    window.used = 2
    window.limit = 10
    window.remaining = 8
    window.unit = 'chamadas'
    for (const detail of window.details) delete detail.display
  }
  for (const fact of legacyQuota.providers[0].facts) {
    delete fact.display
    delete fact.unit_code
  }
  const legacyHistory = JSON.parse(JSON.stringify(historyData))
  delete legacyHistory.schema_version
  delete legacyHistory.problem
  delete legacyHistory.period_code
  delete legacyHistory.source_code
  delete legacyHistory.sessions[0].title_missing
  delete legacyHistory.sessions[0].models[0].model_missing
  delete legacyHistory.by_model_v2
  delete legacyHistory.model_options_v2

  const { state } = await loadPlugin({ quotaData: legacyQuota, historyData: legacyHistory })
  const text = flattenText(state.contributions.find(item => item.area === 'routes').render()).join(' ')

  assert.match(text, /Code review/)
  assert.match(text, /Additional credits/)
  assert.match(text, /Unlimited/)
  assert.match(text, /Authentication expired or denied/)
  assert.match(text, /10 calls/)
  assert.match(text, /Untitled session/)
  assert.match(text, /Unrecorded model/)
  assert.doesNotMatch(text, /Revisão|Créditos|Ilimitados|Sessão sem título|Não registado/)
})

test('allowlists every known schema-v1 Portuguese error and rejects unknown copy', async () => {
  const { mod } = await loadPlugin()
  const cases = [
    ['A API da Z.ai não devolveu os limites esperados.', 'response.unexpectedShape'],
    ['O endpoint de utilização mudou de endereço; pedido interrompido por segurança.', 'security.redirectBlocked'],
    ['Endpoint de utilização não autorizado.', 'security.endpointNotAllowed'],
    ['Resposta de utilização demasiado grande.', 'response.tooLarge'],
    ['Resposta de utilização inválida.', 'response.unexpectedShape'],
    ['Autenticação expirada ou recusada. Verifique o fornecedor no Hermes.', 'auth.rejected'],
    ['O fornecedor recusou acesso aos dados de utilização.', 'auth.forbidden'],
    ['Pedidos de utilização temporariamente limitados pelo fornecedor.', 'upstream.rateLimited'],
    ['Não foi possível contactar a API de utilização. Tente novamente dentro de um minuto.', 'network.unreachable'],
    ['O fornecedor não devolveu JSON de utilização válido.', 'response.invalidJson'],
    ['Não foi possível ler as credenciais do perfil Hermes.', 'credentials.unreadable'],
    ['Limites Claude requerem uma conta OAuth no Hermes; uma chave API não fornece a quota da subscrição.', 'auth.oauthRequired'],
    ['Não existe uma chave utilizável para este fornecedor no perfil Hermes.', 'credentials.missing'],
    ['O endereço GLM configurado não corresponde à Z.ai/Zhipu.', 'provider.endpointMismatch'],
    ['A Z.ai não aceitou a consulta da quota do Coding Plan.', 'provider.queryRejected'],
    ['A credencial não pertence ao endpoint deepseekv4pro.com configurado.', 'provider.endpointMismatch'],
    ['O dashboard DeepSeek não devolveu a lista de planos esperada.', 'response.unexpectedShape'],
    ['A quota requer sessão iniciada no site deepseekv4pro.com; a API key do Hermes não dá acesso a estes dados. Consulte «Abrir no fornecedor». Nenhuma quota foi estimada.', 'provider.siteSessionRequired'],
    ['O fornecedor não devolveu limites ou saldos para esta conta.', 'provider.noLimits'],
    ['Não foi possível obter a utilização com as credenciais deste perfil. Verifique o fornecedor no Hermes.', 'provider.fetchFailed'],
    ['Não foi possível ler o registo local do Hermes. Tente novamente.', 'history.readFailed'],
    ['Fornecedor não ativo neste perfil.', 'history.providerInactive']
  ]

  for (const [message, code] of cases) assert.equal(mod.legacyProblem(message)?.code, code, message)
  assert.equal(JSON.stringify(mod.legacyProblem('A API de utilização respondeu HTTP 503.')),
    JSON.stringify({ code: 'upstream.http', params: { status: 503 }, retryable: true }))
  assert.equal(mod.legacyProblem('Autenticação expirada ou recusada!'), null)
  assert.equal(mod.legacyProblem('unknown upstream prose'), null)

  const legacyHistory = structuredClone(historyData)
  delete legacyHistory.problem
  legacyHistory.error = 'Não foi possível ler o registo local do Hermes. Tente novamente.'
  const history = await loadPlugin({ quotaData, historyData: legacyHistory })
  const historyText = flattenText(history.state.contributions.find(item => item.area === 'routes').render()).join(' ')
  assert.match(historyText, /The local Hermes usage record could not be read/)

  const unknownQuota = structuredClone(quotaData)
  unknownQuota.providers[0].problem = null
  unknownQuota.providers[0].error = 'unknown upstream prose'
  const unknown = await loadPlugin({ quotaData: unknownQuota, historyData })
  const unknownText = flattenText(unknown.state.contributions.find(item => item.area === 'routes').render()).join(' ')
  assert.match(unknownText, /Unable to retrieve usage with the credentials in this profile/)
  assert.doesNotMatch(unknownText, /unknown upstream prose/)
})

test('adapts remaining schema-v1 tool, period-unit, and timestamp values', async () => {
  const legacyQuota = {
    providers: [{
      id: 'zai', name: 'GLM · Z.ai', status: 'ok', plan: null, source: null,
      fetched_at: null, error: null,
      windows: [{
        id: 'legacy', label: '12 unid. de período', group: 'Ferramentas / MCP', unit: 'chamadas',
        used: 1234, limit: 2000, remaining: 766, used_percent: 61.7, remaining_percent: 38.3,
        reset_at: null, unlimited: false, details: [{ label: 'Ferramenta', value: 1234 }]
      }],
      facts: [{ label: 'Coding · fim do período', value: '2026-09-18T17:00:00+00:00' }]
    }],
    error: null, refresh_seconds: 60
  }
  const { state } = await loadPlugin({ quotaData: legacyQuota, historyData })
  const text = flattenText(state.contributions.find(item => item.area === 'routes').render()).join(' ')
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date('2026-09-18T17:00:00+00:00'))

  assert.match(text, /12 period units/)
  assert.match(text, /Tool/)
  assert.match(text, new RegExp(date.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(text, /unid\. de período|Ferramenta|2026-09-18T17:00:00/)
})

test('renders schema-v1 Z.ai credit limits with credit semantics', async () => {
  const legacyQuota = {
    providers: [{
      id: 'zai', name: 'GLM · Z.ai', status: 'ok', plan: null, source: null,
      fetched_at: null, error: null,
      windows: [{
        id: 'CREDIT_LIMIT-0', label: '5 h', group: 'CREDIT_LIMIT', unit: 'tokens',
        used: 25, limit: 100, remaining: 75, used_percent: 25, remaining_percent: 75,
        reset_at: null, unlimited: false, details: []
      }],
      facts: []
    }],
    error: null, refresh_seconds: 60
  }
  const { state } = await loadPlugin({ quotaData: legacyQuota, historyData })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const provider = findNodes(page, node => node.props?.className === 'pl-section')[0]
  const text = flattenText(provider).join(' ')

  assert.match(text, /Credits/)
  assert.match(text, /25 credits \/ 100 credits/)
  assert.match(text, /Available: 75 credits/)
  assert.doesNotMatch(text, /CREDIT_LIMIT|tokens/)
})

test('schema-v1 Z.ai unknown kinds do not inherit fabricated token units', async () => {
  const legacyQuota = {
    providers: [{
      id: 'zai', name: 'GLM · Z.ai', status: 'ok', plan: null, source: null,
      fetched_at: null, error: null,
      windows: [{
        id: 'FUTURE_LIMIT-0', label: '5 h', group: 'FUTURE_LIMIT', unit: 'tokens',
        used: 5, limit: 10, remaining: 5, used_percent: 50, remaining_percent: 50,
        reset_at: null, unlimited: false, details: [{ label: 'future-detail', value: 5 }]
      }], facts: []
    }], error: null, refresh_seconds: 60
  }
  const { state } = await loadPlugin({ quotaData: legacyQuota, historyData })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const meter = flattenText(findNodes(page, node => node.props?.className === 'pl-window')[0]).join(' ')

  assert.match(meter, /5 \/ 10/)
  assert.match(meter, /future-detail 5/)
  assert.doesNotMatch(meter, /tokens/)
})

test('renders schema-v2 Z.ai semantic detail units and no suffix for unknown kinds', async () => {
  const makeWindow = (id, group, unitCode, value) => ({
    id, label: '5 h', group, unit: group === 'Ferramentas / MCP' ? 'chamadas' : 'tokens',
    unit_code: unitCode,
    display: { label: { kind: 'period', value: 5, unit: 'hour' }, group: { kind: 'literal', value: group } },
    used: value, limit: 10, remaining: 10 - value, used_percent: value * 10,
    remaining_percent: 100 - value * 10, reset_at: null, unlimited: false,
    details: [{ label: `${id}-detail`, value, display: { label: { kind: 'literal', value: `${id}-detail` } }, unit_code: unitCode }]
  })
  const data = structuredClone(quotaData)
  data.providers[0] = {
    ...data.providers[0], id: 'zai', name: 'GLM · Z.ai', status: 'ok', plan: null,
    problem: null, error: null, facts: [], windows: [
      makeWindow('time', 'Ferramentas / MCP', 'call', 2),
      makeWindow('credit', 'Credits', 'credit', 3),
      makeWindow('token', 'Tokens', 'token', 4),
      makeWindow('unknown', 'FUTURE_LIMIT', 'unknown', 5)
    ]
  }
  const { state } = await loadPlugin({ quotaData: data, historyData })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const meters = findNodes(page, node => node.props?.className === 'pl-window')
    .map(node => flattenText(node).join(' '))

  assert.match(meters[0], /2 calls \/ 10 calls/)
  assert.match(meters[0], /time-detail 2 calls/)
  assert.match(meters[1], /3 credits \/ 10 credits/)
  assert.match(meters[1], /credit-detail 3 credits/)
  assert.match(meters[2], /4 tokens \/ 10 tokens/)
  assert.match(meters[2], /token-detail 4 tokens/)
  assert.match(meters[3], /5 \/ 10/)
  assert.match(meters[3], /unknown-detail 5/)
  assert.doesNotMatch(meters[3], /token|call|credit|unknown unit/)
})

test('renders schema-v2 Claude minor-unit currency amounts at the declared scale', async () => {
  const data = structuredClone(quotaData)
  data.providers[0] = {
    id: 'anthropic', name: 'Claude', status: 'ok', plan: null, source: null,
    fetched_at: null, error: null, problem: null, facts: [],
    windows: [{
      id: 'extra_usage', label: 'Utilização extra mensal', group: 'Claude', unit: 'USD',
      unit_code: 'currency', currency_code: 'USD', decimal_places: 2,
      display: { label: { kind: 'message', code: 'window.extraUsageMonthly' }, group: { kind: 'literal', value: 'Claude' } },
      used: 2219, limit: 10000, remaining: 7781, used_percent: 22.19, remaining_percent: 77.81,
      reset_at: null, unlimited: false, details: []
    }]
  }
  const { state } = await loadPlugin({ quotaData: data, historyData })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const meter = flattenText(findNodes(page, node => node.props?.className === 'pl-window')[0]).join(' ')
  const usd = value => new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)

  assert.ok(meter.includes(`${usd(22.19)} / ${usd(100)}`))
  assert.ok(meter.includes(`Available: ${usd(77.81)}`))
  assert.doesNotMatch(meter, /2,219|10,000|7,781/)
})

test('localizes schema-v1 mixed DeepSeek unnamed plan composites', async () => {
  const legacyQuota = {
    providers: [{
      id: 'deepseekv4pro', name: 'DeepSeek V4 Pro', status: 'ok',
      plan: 'Coding / Plano 1234', source: null, fetched_at: null, error: null,
      windows: [{
        id: 'plan-1-fiveHour', label: '5 h', group: 'Plano 1234', unit: 'créditos',
        used: 12, limit: 100, remaining: 88, used_percent: 12, remaining_percent: 88,
        reset_at: null, unlimited: false, details: []
      }],
      facts: [
        { label: 'Plano 1234', value: 'Quota indisponível no fornecedor' },
        { label: 'Plano 1234 · deepseek-flash · créditos debitados', value: 12 },
        { label: 'Plano 1234 · fim do período', value: '2026-09-18T17:00:00+00:00' }
      ]
    }],
    error: null, refresh_seconds: 60
  }
  const { state } = await loadPlugin({ quotaData: legacyQuota, historyData })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const provider = findNodes(page, node => node.props?.className === 'pl-section')[0]
  const text = flattenText(provider).join(' ')

  assert.match(text, /Plan Coding \/ Plan 1,234/)
  assert.match(text, /Plan 1,234 Provider quota unavailable/)
  assert.match(text, /Plan 1,234 · deepseek-flash · charged credits/)
  assert.match(text, /Plan 1,234 · period end/)
  assert.doesNotMatch(text, /Plano|créditos debitados|fim do período/)
})

test('uses English fallback copy with Arabic formatting for every visible numeric interpolation', async () => {
  const arabicQuota = structuredClone(quotaData)
  arabicQuota.refresh_seconds = 180
  arabicQuota.providers[0].plan = 'Plano 1234'
  arabicQuota.providers[0].plan_display = {
    kind: 'list', items: [{ kind: 'message', code: 'plan.unnamed', args: [1234] }]
  }
  arabicQuota.providers[0].windows.push({
    ...structuredClone(arabicQuota.providers[0].windows[0]),
    id: 'review-secondary_window',
    label: '1234 unid. de período',
    display: { label: { kind: 'message', code: 'period.units', args: [1234] }, group: { kind: 'message', code: 'group.codeReview' } }
  })
  const arabicHistory = structuredClone(historyData)
  arabicHistory.total_sessions = 9876
  arabicHistory.coverage.legacy_sessions = 1234
  arabicHistory.coverage.unattributed_main_tokens_in_profile = 5678

  // 'ar' is the locale id Hermes actually registers; a region subtag would exercise
  // formatting this plugin never receives in production.
  const { state } = await loadPlugin({ locale: 'ar', quotaData: arabicQuota, historyData: arabicHistory })
  const text = flattenText(state.contributions.find(item => item.area === 'routes').render()).join(' ')
  const nf = new Intl.NumberFormat('ar', { maximumFractionDigits: 2 })
  const [n0, n1, n2, n3, n5, n180, n1234, n1550, n5678, n9876] =
    [0, 1, 2, 3, 5, 180, 1234, 1550, 5678, 9876].map(value => nf.format(value))

  assert.match(text, /Usage and limits/)
  assert.ok(text.includes(`${n1} active provider · ${n2} limits`))
  assert.ok(text.includes(`Automatic refresh · ${n3} min`))
  assert.ok(text.includes(`${n180}-second cache`))
  assert.ok(text.includes(`Plan ${n1234}`))
  assert.ok(text.includes(`${n5} hr`))
  assert.ok(text.includes(`${n1234} period units`))
  assert.ok(text.includes(n1550))
  assert.ok(text.includes(`${n5678} summary tokens`))
  assert.ok(text.includes(`${n1234} older sessions use`))
  assert.ok(text.includes(`Summary by model (${n1})`))
  assert.ok(text.includes(`${n1}–${n1} of ${n9876} sessions`))
  assert.doesNotMatch(text, /Utilização|Sessão|Não registado/)

  const zeroHistory = structuredClone(historyData)
  zeroHistory.total_sessions = 0
  zeroHistory.sessions = []
  zeroHistory.by_model = []
  const zero = await loadPlugin({ locale: 'ar', quotaData, historyData: zeroHistory })
  const zeroText = flattenText(zero.state.contributions.find(item => item.area === 'routes').render()).join(' ')
  assert.ok(zeroText.includes(`${n0} sessions`))
})

test('renders schema-v2 quota and history semantics in English without leaking legacy Portuguese', async () => {
  const { state } = await loadPlugin({ quotaData, historyData })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const text = flattenText(page).join(' ')

  assert.equal(state.bundles.en.history.task.vision, 'Vision')
  for (const expected of [
    'Previous data', 'Code review', 'Additional credits', 'Unlimited', 'Authentication expired or denied',
    'Hermes usage', 'Untitled session', 'Unrecorded model', 'Accumulated session history'
  ]) assert.match(text, new RegExp(expected))
  assert.doesNotMatch(text, /Revisão|Créditos|Ilimitados|Utilização|Sessão|Não registado|Histórico acumulado|Entrada|Saída|Raciocínio|Atualizar/)
})

test('schema-v2 missing flags override sentinel-looking literal data', async () => {
  const literalHistory = structuredClone(historyData)
  literalHistory.by_model_v2 = [
    { model: 'Não registado', model_missing: true, ...summary },
    { model: 'Não registado', model_missing: false, ...summary }
  ]
  literalHistory.sessions[0].title_missing = false
  literalHistory.sessions[0].models[0].model_missing = false
  literalHistory.model_options_v2 = [
    { value: '', model_missing: true },
    { value: 'Não registado', model_missing: false }
  ]

  const { state } = await loadPlugin({ quotaData, historyData: literalHistory })
  const page = state.contributions.find(item => item.area === 'routes').render()
  const text = flattenText(page).join(' ')
  const modelSelect = findNodes(page, node => node.type === 'Select').find(select =>
    findNodes(select, node => node.type === 'SelectTrigger' && node.props['aria-label'] === 'Filter model').length > 0
  )
  const options = findNodes(modelSelect, node => node.type === 'SelectItem').map(node => flattenText(node).join(' '))

  assert.match(text, /Sessão sem título/)
  assert.ok(text.match(/Não registado/g).length >= 2)
  assert.match(text, /Summary by model \(2\)/)
  assert.match(text, /Unrecorded model/)
  assert.deepEqual(options, ['All models', 'Unrecorded model', 'Não registado'])
})

test('renders unnamed and named schema-v2 DeepSeek plan descriptors once', async () => {
  const renderPlan = async (plan, planDisplay) => {
    const data = structuredClone(quotaData)
    data.providers[0] = {
      ...data.providers[0], id: 'deepseekv4pro', name: 'DeepSeek V4 Pro', status: 'ok',
      plan, plan_display: planDisplay, problem: null, error: null, windows: [], facts: []
    }
    const { state } = await loadPlugin({ quotaData: data, historyData })
    const page = state.contributions.find(item => item.area === 'routes').render()
    return flattenText(findNodes(page, node => node.props?.className === 'pl-plan')[0]).join(' ')
  }

  assert.equal(await renderPlan('Plano 1', {
    kind: 'list', items: [{ kind: 'message', code: 'plan.unnamed', args: [1] }]
  }), 'Plan 1')
  assert.equal(await renderPlan('Plano 1', undefined), 'Plan 1')
  assert.equal(await renderPlan('Coding', {
    kind: 'list', items: [{ kind: 'literal', value: 'Coding' }]
  }), 'Plan Coding')
})

test('renders schema-v2 unnamed DeepSeek composite facts without Portuguese in English or Arabic', async () => {
  const render = async locale => {
    const data = structuredClone(quotaData)
    data.providers[0] = {
      ...data.providers[0], id: 'deepseekv4pro', name: 'DeepSeek V4 Pro', status: 'ok',
      plan: 'Plano 1234',
      plan_display: { kind: 'list', items: [{ kind: 'message', code: 'plan.unnamed', args: [1234] }] },
      problem: null, error: null, windows: [], facts: [
        {
          label: 'Plano 1234 · deepseek-flash · créditos debitados', value: 12,
          display: { label: { kind: 'message', code: 'fact.unnamedPlanModelChargedCredits', args: [1234, 'deepseek-flash'] } },
          unit_code: 'flash_credit'
        },
        {
          label: 'Plano 1234 · fim do período', value: '2026-09-18T17:00:00+00:00',
          display: {
            label: { kind: 'message', code: 'fact.unnamedPlanPeriodEnd', args: [1234] },
            value: { kind: 'timestamp', value: '2026-09-18T17:00:00+00:00' }
          }
        },
        {
          label: 'Coding · deepseek-chat · créditos debitados', value: 7,
          display: { label: { kind: 'message', code: 'fact.modelChargedCredits', args: ['Coding', 'deepseek-chat'] } },
          unit_code: 'flash_credit'
        }
      ]
    }
    const { state } = await loadPlugin({ locale, quotaData: data, historyData })
    const page = state.contributions.find(item => item.area === 'routes').render()
    return flattenText(findNodes(page, node => node.props?.className === 'pl-section')[0]).join(' ')
  }

  const english = await render('en')
  const arabic = await render('ar')
  const arabicIndex = new Intl.NumberFormat('ar', { maximumFractionDigits: 2 }).format(1234)

  assert.match(english, /Plan 1,234 · deepseek-flash · charged credits/)
  assert.match(english, /Plan 1,234 · period end/)
  assert.match(english, /Coding · deepseek-chat · charged credits/)
  assert.ok(arabic.includes(`Plan ${arabicIndex} · deepseek-flash · charged credits`))
  assert.ok(arabic.includes(`Plan ${arabicIndex} · period end`))
  assert.doesNotMatch(`${english} ${arabic}`, /Plano|créditos debitados|fim do período/)
})

// The previous backend describes Anthropic's extra-usage window only as
// unit: "USD" with minor-unit amounts, so a new Desktop paired with it must
// recover the currency semantics or it renders 2219 as "2,219 USD".
const legacyAnthropicQuota = (unit = 'USD') => ({
  schema_version: 1,
  refresh_seconds: 60,
  providers: [{
    id: 'anthropic', name: 'Claude', plan: 'Max', source: 'api.anthropic.com · oauth/usage',
    windows: [{
      // Key names match the real schema-v1 backend `window()` helper.
      id: 'extra_usage', label: 'Utilização extra mensal', group: 'Claude',
      used: 2219, limit: 10000, remaining: 7781,
      used_percent: 22.19, remaining_percent: 77.81, unit
    }],
    facts: []
  }]
})

const renderProviderText = async options => {
  const { state } = await loadPlugin(options)
  const page = state.contributions.find(item => item.area === 'routes').render()
  return flattenText(findNodes(page, node => node.props?.className === 'pl-section')[0]).join(' ')
}

test('schema-v1 Anthropic extra usage renders as currency, not bare minor units', async () => {
  const text = await renderProviderText({ quotaData: legacyAnthropicQuota() })

  assert.match(text, /\$22\.19/)
  assert.match(text, /\$100\.00/)
  assert.doesNotMatch(text, /2,219\s*USD/)
  assert.doesNotMatch(text, /10,000\s*USD/)
})

test('schema-v1 Anthropic currency localizes per active locale', async () => {
  const text = await renderProviderText({ locale: 'ar', quotaData: legacyAnthropicQuota() })
  const expected = new Intl.NumberFormat('ar', { style: 'currency', currency: 'USD' }).format(22.19)

  assert.ok(text.includes(expected), `expected ${expected} in: ${text}`)
  assert.doesNotMatch(text, /2,219\s*USD/)
})

test('schema-v1 non-currency units are left untouched by the currency adapter', async () => {
  const text = await renderProviderText({ quotaData: legacyAnthropicQuota('créditos (API)') })

  assert.doesNotMatch(text, /\$22\.19/)
  assert.match(text, /2,219/)
})

test('numeric strings from either schema are localized rather than printed raw', async () => {
  const data = legacyAnthropicQuota()
  // Every amount arrives as a JSON string, which is the case that previously
  // collapsed the whole readout behind the subscription-quota fallback.
  data.providers[0].windows[0].used = '2219'
  data.providers[0].windows[0].limit = '10000'
  data.providers[0].windows[0].remaining = '7781'
  // Currency values are minor units, so 123450 renders as $1,234.50.
  data.providers[0].facts = [{ label: 'Saldo', value: '123450', unit: 'USD', unit_code: 'currency', currency_code: 'USD' }]

  const text = await renderProviderText({ quotaData: data })

  assert.match(text, /\$22\.19/)
  assert.match(text, /\$100\.00/)
  assert.match(text, /\$77\.81/)
  assert.match(text, /\$1,234\.50/)
  assert.doesNotMatch(text, /Subscription quota/)
})

function assertHistoryRequest(call) {
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.timeoutMs, 15000)
  const url = new URL(call.path, 'https://plugin.invalid')
  assert.equal(url.pathname, '/history')
  const params = url.searchParams
  assert.equal(params.get('provider'), 'openai-codex')
  assert.equal(params.get('q'), '')
  assert.equal(params.get('profile'), 'angel')
  assert.equal(params.get('limit'), '25')
  assert.equal(params.get('offset'), '0')
  assert.equal(params.get('sort'), 'tokens')
  assert.equal(params.get('model'), '')
  assert.equal(params.has('model_missing'), false)
}

test('history queryFn builds the request and surfaces transport errors', async () => {
  // UsageHistory only mounts inside a provider tab panel.
  const { state } = await loadPlugin({ quotaData, historyData })
  // flattenText walks into function components, which is what actually invokes
  // UsageHistory and therefore registers its query.
  flattenText(state.contributions.find(item => item.area === 'routes').render())

  const history = state.queries.get('provider-limits-history')
  assert.ok(history, 'history query was never registered')

  const result = await history.queryFn()
  assert.equal(result, historyData)
  assert.equal(state.restCalls.length, 1)

  const [call] = state.restCalls
  assertHistoryRequest(call)

  state.restImpl = () => { throw new Error('connection refused') }
  await assert.rejects(() => history.queryFn(), /connection refused/)
  assert.equal(history.retry, false)
})


for (const [name, before, after] of [
  ['wrong route', '`/history?', '`/quota?'],
  ['missing provider', 'const params = { provider, profile, q: needle', 'const params = { profile, q: needle'],
  ['missing q', 'q: needle, model:', 'model:'],
]) {
  test(`history request assertions reject mutation: ${name}`, async () => {
    const { state } = await loadPlugin({ quotaData, historyData, transformSource: source => {
      assert.ok(source.includes(before), `mutation target missing: ${name}`)
      return source.replace(before, after)
    } })
    flattenText(state.contributions.find(item => item.area === 'routes').render())
    await state.queries.get('provider-limits-history').queryFn()
    assert.throws(() => assertHistoryRequest(state.restCalls[0]), assert.AssertionError)
  })
}

test('legacy SDK shape without connectionId or ctx.os renders without crashing', async () => {
  const legacyQuota = structuredClone(quotaData)
  legacyQuota.providers[0].url = 'https://example.com/provider'
  const { state } = await loadPlugin({ quotaData: legacyQuota, historyData, legacyHost: true })

  const text = flattenText(state.contributions.find(item => item.area === 'routes').render()).join(' ')
  assert.match(text, /Usage and limits/)
  assert.doesNotMatch(text, /Open provider/)

  const quota = state.queries.get('provider-limits')
  assert.ok(quota, 'quota query was never registered')
  assert.equal(quota.queryKey[2], null, 'legacy host must use a neutral connection key')
})
