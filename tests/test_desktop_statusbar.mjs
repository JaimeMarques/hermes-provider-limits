import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const PROFILE_ID = 'b'.repeat(64)
const provider = (id, name) => ({ id, name, status: 'ok', windows: [], facts: [] })
const quota = {
  schema_version: 3, profile: 'angel', profile_identity: { name: 'angel', id: PROFILE_ID },
  providers: [provider('zai', 'GLM / Z.ai'), provider('openai-codex', 'Codex'), provider('anthropic', 'Claude')]
}

function translate(bundles, locale, key, ...args) {
  const resolve = bundle => key.split('.').reduce((value, segment) => value?.[segment], bundle)
  const value = resolve(bundles?.[locale]) ?? resolve(bundles?.en)
  return typeof value === 'function' ? value(...args) : typeof value === 'string' ? value : key
}

async function loadPlugin(enabled = {}, queryResult = { data: quota, error: null, isPending: false, isFetching: false, refetch() {} }, options = {}) {
  const { locale = 'en', localize = false, systemTimeZone = null } = options
  const source = await fs.readFile(new URL('desktop/plugin.js', ROOT), 'utf8')
  const state = { contributions: [], queries: [], restCalls: 0, bundles: null, dateTimeOptions: [], storageWrites: [] }
  const DateTimeFormat = systemTimeZone ? class extends Intl.DateTimeFormat {
    constructor(activeLocale, formatOptions = {}) {
      state.dateTimeOptions.push(formatOptions)
      super(activeLocale, { ...formatOptions, timeZone: formatOptions.timeZone ?? systemTimeZone })
    }
  } : Intl.DateTimeFormat
  const contextIntl = systemTimeZone ? { NumberFormat: Intl.NumberFormat, DateTimeFormat } : Intl
  const context = vm.createContext({ console, URL, URLSearchParams, Intl: contextIntl, Date, Math, Map, Set, Number, String, Object, Array, Promise, Error, RegExp, JSON, encodeURIComponent, setTimeout, clearTimeout })
  const module = new vm.SourceTextModule(source, { context })
  const synthetic = (id, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value)
  }, { context, identifier: id })
  const atom = initial => { let value = initial; return { get: () => value, set: next => { value = next } } }
  const sdkComponent = name => { const component = () => null; component.sdkName = name; return component }
  const jsx = (type, props = {}, key) => {
    if (typeof type === 'function') {
      if (type.sdkName) return { type: type.sdkName, props, key }
      return type(props)
    }
    return { type, props, key }
  }
  const host = { state: { profile: {}, connectionId: {} }, navigate() {} }
  const components = Object.fromEntries(['Button', 'Switch', 'Input', 'Codicon', 'Select', 'SelectContent', 'SelectItem', 'SelectTrigger', 'SelectValue', 'Tabs', 'TabsList', 'TabsTrigger', 'Popover', 'PopoverTrigger', 'PopoverContent'].map(name => [name, sdkComponent(name)]))
  const sdk = {
    ...components, atom, host,
    useValue: store => typeof store.get === 'function' ? store.get() : store === host.state.profile ? 'angel' : 'local',
    useQuery: options => { state.queries.push(options); return queryResult },
    useQueryClient: () => ({ invalidateQueries() {} }),
    usePluginI18n: () => (key, ...args) => localize ? translate(state.bundles, locale, key, ...args) : key,
    useI18n: () => ({ locale }),
    ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar', PALETTE_AREA: 'palette', STATUSBAR_AREAS: { right: 'status-right' }
  }
  await module.link(specifier => {
    if (specifier === 'react/jsx-runtime') return synthetic(specifier, { jsx, jsxs: jsx })
    if (specifier === 'react') return synthetic(specifier, { useState: value => [value, () => {}], useEffect: () => {}, useMemo: fn => fn() })
    return synthetic(specifier, sdk)
  })
  await module.evaluate()
  const scope = JSON.stringify(['local', 'angel'])
  const disposers = []
  const ctx = {
    onDispose: fn => disposers.push(fn),
    i18n: { register(value) { state.bundles = value }, t: key => key },
    registerMany(items) { state.contributions.push(...items) },
    storage: { get: () => ({ version: 1, scopes: { [scope]: enabled } }), set(...args) { state.storageWrites.push(args) } },
    rest: async () => { state.restCalls += 1; return quota }
  }
  module.namespace.default.register(ctx)
  return { mod: module.namespace, state, ctx, dispose: () => disposers.forEach(fn => fn()) }
}

function walk(value, output = []) {
  if (Array.isArray(value)) { for (const item of value) walk(item, output); return output }
  if (!value || typeof value !== 'object') return output
  if (value.type) output.push(value)
  walk(value.props?.children, output)
  return output
}

function flattenText(value) {
  if (value == null || value === false) return []
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(flattenText)
  if (typeof value !== 'object') return []
  return flattenText(value.props?.children)
}

const text = node => flattenText(node).join(' ')

test('registers exactly one right status-bar contribution', async () => {
  const { state } = await loadPlugin()
  const status = state.contributions.filter(item => item.area === 'status-right')
  assert.equal(status.length, 1)
  assert.equal(status[0].id, 'status-gauges')
  assert.equal(status[0].order, 90)
})

test('host context disposal releases the module storage reference', async () => {
  const { mod, state, dispose } = await loadPlugin()
  mod.setGaugePreference('local', 'angel', 'anthropic', true)
  assert.equal(state.storageWrites.length, 1)

  // The supported runtime calls only ctx.onDispose registrations, not a
  // default-export dispose method (Hermes 0.21.3 runtime-loader.ts).
  dispose()
  mod.setGaugePreference('local', 'angel', 'anthropic', false)
  assert.equal(state.storageWrites.length, 1)
})

test('late disposal of an old registration cannot detach the replacement using the same storage', async () => {
  const { mod, state, ctx, dispose: disposeOld } = await loadPlugin()
  const nextDisposers = []
  // Re-enabling can reuse both the ESM module and the host storage adapter.
  mod.default.register({ ...ctx, onDispose: fn => nextDisposers.push(fn) })
  disposeOld()
  mod.setGaugePreference('local', 'angel', 'anthropic', true)
  assert.equal(state.storageWrites.length, 1, 'new registration still owns storage')
  nextDisposers.forEach(fn => fn())
  mod.setGaugePreference('local', 'angel', 'anthropic', false)
  assert.equal(state.storageWrites.length, 1, 'replacement also cleans up through its host context')
})

test('default-off status root renders null with one disabled shared query', async () => {
  const { state } = await loadPlugin()
  const status = state.contributions.find(item => item.area === 'status-right')
  assert.equal(status.render(), null)
  assert.equal(state.queries.length, 1)
  assert.equal(state.queries[0].enabled, false)
  assert.deepEqual(Array.from(state.queries[0].queryKey), ['provider-limits', 3, 'local', 'angel'])
  assert.equal(state.restCalls, 0)
})

test('one or three enabled providers still use one quota query and stable chip order', async () => {
  for (const enabled of [
    { anthropic: true },
    { anthropic: true, 'openai-codex': true, zai: true }
  ]) {
    const { state } = await loadPlugin(enabled)
    const root = state.contributions.find(item => item.area === 'status-right').render()
    assert.equal(state.queries.length, 1)
    assert.equal(state.queries[0].enabled, true)
    const chips = walk(root).filter(node => node.props?.['data-provider-chip'])
    assert.deepEqual(chips.map(node => node.props['data-provider-chip']), Object.keys(enabled).filter(id => enabled[id]))
  }
})

test('status root carries its gauge and popover styles when the route is unmounted', async () => {
  const { state } = await loadPlugin({ anthropic: true })
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const styles = walk(root).filter(node => node.type === 'style')

  assert.equal(styles.length, 1)
  assert.match(styles[0].props.children, /\.pl-status-gauges\{/)
  assert.match(styles[0].props.children, /\.pl-status-popover\{/)
  assert.doesNotMatch(styles[0].props.children, /\.pl-page\{/)
})

test('canonical selectors reject missing and ambiguous weekly windows', async () => {
  const { mod } = await loadPlugin()
  const { selectProviderWindows } = mod
  const weekly = { id: 'seven_day', group: 'Claude', period_seconds: 604800, used_percent: 20 }
  const five = { id: 'five_hour', group: 'Claude', period_seconds: 18000, used_percent: 10 }
  const fable = { id: 'weekly_scoped_fable', label: 'Fable · 7 d', group: 'Claude', period_seconds: 604800, used_percent: 0 }
  let selected = selectProviderWindows({ id: 'anthropic', windows: [five, weekly, fable] })
  assert.equal(selected.weekly.used_percent, 20)
  assert.deepEqual(JSON.parse(JSON.stringify(selected.relevant.map(item => item.id))), ['five_hour', 'seven_day', 'weekly_scoped_fable'])
  assert.equal(selectProviderWindows({ id: 'anthropic', windows: [weekly, { ...weekly }] }).weekly, null)
  assert.equal(selectProviderWindows({ id: 'anthropic', windows: [five] }).weekly, null)

  selected = selectProviderWindows({ id: 'openai-codex', windows: [
    { group: 'Code review', period_seconds: 604800 },
    { group: 'Codex', period_seconds: 604800, used_percent: 30 }
  ] })
  assert.equal(selected.weekly.used_percent, 30)
  assert.equal(selectProviderWindows({ id: 'openai-codex', windows: [
    { group: 'Codex', period_seconds: 604800 }, { group: 'Codex', period_seconds: 604800 }
  ] }).weekly, null)

  selected = selectProviderWindows({ id: 'zai', windows: [
    { unit_code: 'credit', period_seconds: 604800 },
    { unit_code: 'token', period_seconds: 604800, used_percent: 40 }
  ] })
  assert.equal(selected.weekly.used_percent, 40)
})

test('pace math honors the start threshold, stale and rolling suppression, and uncapped projection', async () => {
  const { mod } = await loadPlugin()
  const { quotaPaceState, paceSegments } = mod
  const now = Date.parse('2026-09-20T00:00:00Z')
  const make = (used, elapsed, extra = {}) => ({
    used_percent: used,
    period_seconds: 100000,
    reset_at: new Date(now + (1 - elapsed) * 100000 * 1000).toISOString(),
    ...extra
  })
  assert.equal(quotaPaceState(make(1, 0), 'ok', now).allowance, null)
  assert.equal(quotaPaceState(make(1, 0.02), 'ok', now).allowance, null)
  const over = quotaPaceState(make(60, 0.4), 'ok', now)
  assert.equal(over.allowance, 40)
  assert.equal(over.projection, 150)
  assert.equal(over.level, 'critical')
  assert.equal(quotaPaceState(make(20, 0.4, { rolling: true }), 'ok', now).allowance, null)
  assert.equal(quotaPaceState(make(20, 0.4), 'stale', now).allowance, null)
  assert.deepEqual(JSON.parse(JSON.stringify(paceSegments(60, 40))), { used: 40, paceRoom: 0, overPace: 20, remaining: 40 })
  assert.deepEqual(JSON.parse(JSON.stringify(paceSegments(20, 40))), { used: 20, paceRoom: 20, overPace: 0, remaining: 60 })
})

test('provider chips are semantic buttons inside native popovers without hover tooltips', async () => {
  const reset = new Date(Date.now() + 4 * 86400000).toISOString()
  const providers = quota.providers.map(item => ({ ...item, windows: item.id === 'anthropic'
    ? [
        { id: 'five_hour', group: 'Claude', period_seconds: 18000, used_percent: 5, reset_at: reset },
        { id: 'seven_day', group: 'Claude', period_seconds: 604800, used_percent: 20, reset_at: reset },
        { id: 'weekly_scoped_fable', label: 'Fable · 7 d', group: 'Claude', period_seconds: 604800, used_percent: 0, reset_at: reset,
          display: { label: { kind: 'message', code: 'window.modelPeriod', args: ['Fable', 7, 'day'] } } }
      ]
    : item.id === 'openai-codex'
      ? [{ id: 'weekly', group: 'Codex', period_seconds: 604800, used_percent: 30, reset_at: reset }]
      : [{ id: 'weekly', unit_code: 'token', period_seconds: 604800, used_percent: 40, reset_at: reset }]
  }))
  const result = { data: { ...quota, providers }, error: null, isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true, 'openai-codex': true, zai: true }, result, { localize: true })
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const nodes = walk(root)
  assert.equal(nodes.filter(node => node.type === 'Popover').length, 3)
  const triggers = nodes.filter(node => node.type === 'PopoverTrigger')
  assert.equal(triggers.length, 3)
  assert.ok(triggers.every(trigger => trigger.props.asChild === true))
  const buttons = nodes.filter(node => node.type === 'button' && node.props['data-provider-chip'])
  assert.deepEqual(buttons.map(node => node.props['data-provider-chip']), ['anthropic', 'openai-codex', 'zai'])
  assert.ok(buttons.every(button => button.props.type === 'button' && button.props.title === undefined))
  assert.ok(buttons.every(button => /chrome-action-hover/.test(button.props.className)))
  assert.equal(nodes.filter(node => node.type === 'Tip').length, 0)
  const contents = nodes.filter(node => node.type === 'PopoverContent')
  assert.equal(contents.length, 3)
  assert.ok(contents.every(content => content.props.side === 'top' && content.props.align === 'end'))
  assert.match(text(contents[0]), /Fable/)
})

test('Claude and GPT show one read-only reset fact below quotas; Z.ai never does', async () => {
  for (const count of [2, 0, undefined, null, -1, 0.5, true, '2']) {
    const providers = quota.providers.map(item => ({ ...item,
      windows: [{ id: 'seven_day', group: item.id === 'openai-codex' ? 'Codex' : 'Claude',
        period_seconds: 604800, used_percent: 22 }],
      facts: count === undefined ? [] : [{ value: count,
        display: { label: { kind: 'message', code: 'fact.availableResets' } } }]
    }))
    const { state } = await loadPlugin({ anthropic: true, 'openai-codex': true, zai: true }, {
      data: { ...quota, providers }, error: null, isPending: false, isFetching: false, refetch() {}
    }, { localize: true })
    const root = state.contributions.find(item => item.area === 'status-right').render()
    const contents = walk(root).filter(node => node.type === 'PopoverContent')
    for (const content of contents.slice(0, 2)) {
      const rows = walk(content).filter(node => node.type === 'dl')
      assert.equal(rows.length, 1)
      assert.equal(text(rows[0]), `Available resets ${[2, 0].includes(count) ? count : 'Not reported'}`)
      assert.ok(text(content).indexOf('Available resets') > text(content).indexOf('Weekly window'))
      assert.ok(text(content).indexOf('Available resets') < text(content).indexOf('Fresh'))
      assert.equal(walk(rows[0]).filter(node => ['button', 'Button'].includes(node.type)).length, 0)
    }
    assert.doesNotMatch(text(contents[2]), /Available resets/)
    assert.equal(state.queries.length, 1)
    assert.equal(state.restCalls, 0)
  }
})

test('status chip colors usage by pace severity and keeps allowance dim', async () => {
  const reset = new Date(Date.now() + 4 * 86400000).toISOString()
  const coloredQuota = {
    ...quota,
    providers: [{
      ...provider('anthropic', 'Claude'),
      windows: [{ id: 'seven_day', group: 'Claude', period_seconds: 604800, used_percent: 60, reset_at: reset }]
    }]
  }
  const result = { data: coloredQuota, error: null, isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true }, result)
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const nodes = walk(root)
  const value = nodes.find(node => node.props?.className === 'tabular-nums pl-status-chip-value')
  const pace = nodes.find(node => node.props?.className === 'pl-status-chip-pace')
  const styles = nodes.find(node => node.type === 'style').props.children

  assert.equal(value.props['data-level'], 'warning')
  assert.match(text(value), /60%/)
  assert.match(text(pace), /\[/)
  assert.match(styles, /\.pl-status-chip-value\[data-level=warning\]\{color:var\(--ui-orange\)\}/)
  assert.match(styles, /\.pl-status-chip-pace\{color:var\(--ui-text-quaternary\)/)
  assert.doesNotMatch(styles, /\.pl-status-chip-pace\{[^}]*margin-left/)
  assert.match(styles, /\.pl-pace-value\{color:var\(--ui-yellow\)/)
})

test('backend 404 renders the scoped unavailable state instead of provider data', async () => {
  const result = { data: undefined, error: new Error('404 not found'), isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true }, result)
  const root = state.contributions.find(item => item.area === 'status-right').render()
  assert.match(text(root), /statusBar\.backendUnavailable/)
  assert.equal(walk(root).filter(node => node.props?.['data-provider-chip']).length, 0)
})

test('backend discovery problem remains visible when no provider rows were returned', async () => {
  const result = { data: { ...quota, providers: [], problem: { code: 'credentials.unreadable' } },
    error: null, isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true }, result, { localize: true })
  const root = state.contributions.find(item => item.area === 'status-right').render()
  assert.match(text(root), /credentials could not be read/)
  assert.equal(walk(root).filter(node => node.props?.['data-provider-chip']).length, 0)
})

test('initial non-404 quota transport failure is visible and remains retryable', async () => {
  const error = new Error('connection refused')
  const result = { data: undefined, error, isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true }, result)
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const options = state.queries[0]

  assert.match(text(root), /error\.refreshBody/)
  assert.equal(walk(root).filter(node => node.props?.['data-provider-chip']).length, 0)
  assert.equal(options.refetchInterval({ state: { error } }), 60_000)
  assert.equal(options.retry(0, error), true)
  assert.equal(options.retry(1, error), true)
  assert.equal(options.retry(2, error), false)
  const notFound = new Error('404 not found')
  assert.equal(options.refetchInterval({ state: { error: notFound } }), false)
  assert.equal(options.retry(0, notFound), false)
})

test('cached quota data is marked stale when its background refetch fails', async () => {
  const reset = new Date(Date.now() + 4 * 86400000).toISOString()
  const cached = {
    ...quota,
    providers: [{
      ...provider('anthropic', 'Claude'),
      age_seconds: 75,
      windows: [{ id: 'seven_day', period_seconds: 604800, used_percent: 20, reset_at: reset }]
    }]
  }
  const result = { data: cached, error: new Error('connection refused'), isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true }, result)
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const rendered = text(root)

  assert.equal(walk(root).filter(node => node.props?.['data-provider-chip']).length, 1)
  assert.match(rendered, /statusBar\.freshness\.stale/)
  assert.match(rendered, /error\.refreshBody/)
  assert.doesNotMatch(rendered, /statusBar\.freshness\.fresh/)
})

test('cached transport failures age from fetched_at instead of freezing server age', async () => {
  const { mod } = await loadPlugin()
  const now = Date.parse('2026-09-20T05:30:00Z')
  const fetchedAt = new Date(now - 10 * 60_000).toISOString()

  assert.equal(mod.effectiveProviderAge({ age_seconds: 0, fetched_at: fetchedAt }, now), 600)
  assert.equal(mod.effectiveProviderAge({ age_seconds: 75, fetched_at: fetchedAt }, now), 600)
  assert.equal(mod.effectiveProviderAge({ age_seconds: 75, fetched_at: null }, now), 75)
})

test('transport failures cannot display quota older than the 900-second ceiling', async () => {
  const cached = {
    ...provider('anthropic', 'Claude'),
    age_seconds: 0,
    fetched_at: new Date(Date.now() - 901_000).toISOString(),
    windows: [{ id: 'seven_day', period_seconds: 604800, used_percent: 27,
      reset_at: new Date(Date.now() + 86400000).toISOString() }]
  }
  const { state } = await loadPlugin({ anthropic: true }, {
    data: { ...quota, providers: [cached] }, error: new Error('connection refused'),
    isPending: false, isFetching: false, refetch() {}
  }, { localize: true })
  const root = state.contributions.find(item => item.area === 'status-right').render()
  assert.match(text(root), /Unavailable/)
  assert.doesNotMatch(text(root), /27%/)
  assert.equal(walk(root).filter(node => node.props?.role === 'progressbar').length, 0)
})

test('transport failure preserves an unavailable provider hard-auth state and problem', async () => {
  const hardAuth = {
    ...provider('anthropic', 'Claude'),
    status: 'unavailable',
    problem: { code: 'auth.rejected', params: {}, retryable: false },
    age_seconds: null,
    facts: [{ value: 2, display: { label: { kind: 'message', code: 'fact.availableResets' } } }]
  }
  const result = {
    data: { ...quota, providers: [hardAuth] },
    error: new Error('connection refused'),
    isPending: false,
    isFetching: false,
    refetch() {}
  }
  const { state } = await loadPlugin({ anthropic: true }, result, { localize: true })
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const rendered = text(root)

  assert.equal(walk(root).filter(node => node.props?.['data-provider-chip']).length, 1)
  assert.match(rendered, /Unavailable/)
  assert.match(rendered, /Authentication expired or denied/)
  assert.match(rendered, /Available resets Not reported/)
  assert.doesNotMatch(rendered, /Stale/)
  assert.doesNotMatch(rendered, /Check the Hermes connection and try Refresh/)
})

test('Arabic status gauges localize percentages and use the system time zone', async () => {
  const reset = '2026-09-24T01:00:00.000Z'
  const localizedQuota = {
    ...quota,
    providers: [{
      ...provider('anthropic', 'Claude'),
      age_seconds: 30,
      facts: [{ value: 1234, display: { label: { kind: 'message', code: 'fact.availableResets' } } }],
      windows: [{
        id: 'seven_day', period_seconds: 604800, used_percent: 42,
        reset_at: reset, rolling: true
      }]
    }]
  }
  const result = { data: localizedQuota, error: null, isPending: false, isFetching: false, refetch() {} }
  const { state } = await loadPlugin({ anthropic: true }, result, {
    locale: 'ar', localize: true, systemTimeZone: 'UTC'
  })
  const root = state.contributions.find(item => item.area === 'status-right').render()
  const rendered = text(root)
  const percent = new Intl.NumberFormat('ar', { style: 'percent', maximumFractionDigits: 1 }).format(0.42)
  const expectedDate = new Intl.DateTimeFormat('ar', {
    dateStyle: 'medium', timeStyle: 'long', timeZone: 'UTC'
  }).format(new Date(reset))
  const pace = walk(root).find(node => node.props?.className === 'pl-pace-track')
  const time = walk(root).find(node => node.type === 'time')

  assert.ok(rendered.includes(percent), `expected ${percent} in ${rendered}`)
  assert.doesNotMatch(rendered, /42%/)
  assert.ok(rendered.includes(`Available resets ${new Intl.NumberFormat('ar').format(1234)}`))
  assert.ok(pace.props['aria-label'].includes(percent), pace.props['aria-label'])
  assert.equal(time.props.children, expectedDate)
  assert.ok(state.dateTimeOptions.every(options => !Object.hasOwn(options, 'timeZone')))
})
