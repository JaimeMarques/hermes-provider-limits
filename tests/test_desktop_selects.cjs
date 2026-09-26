const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const pluginPath = path.join(__dirname, '..', 'desktop', 'plugin.js')

function sdkComponent(name) {
  const component = () => null
  component.sdkName = name
  return component
}

function walk(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, output)
    return output
  }
  if (!value || typeof value !== 'object') return output
  if (value.type) output.push(value)
  walk(value.props?.children, output)
  return output
}

async function loadPluginModule() {
  const context = vm.createContext({
    Array, Date, Error, Intl, Map, Math, Number, Object, RegExp, Set, String,
    URL, URLSearchParams, clearTimeout, console, encodeURIComponent, setTimeout
  })
  const source = fs.readFileSync(pluginPath, 'utf8')
  const pluginModule = new vm.SourceTextModule(source, { context, identifier: pluginPath })
  const synthetic = (id, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const name of Object.keys(values)) this.setExport(name, values[name])
  }, { context, identifier: id })
  const noop = () => null
  await pluginModule.link(specifier => {
    if (specifier === 'react/jsx-runtime') return synthetic(specifier, { jsx: noop, jsxs: noop })
    if (specifier === 'react') return synthetic(specifier, {
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useEffect: noop, useMemo: fn => fn()
    })
    // SyntheticModule needs concrete export names, so mirror whatever the plugin imports.
    const imported = source.match(new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*'${specifier}'`))
    const names = imported
      ? imported[1].split(',').map(part => part.trim().split(/\s+as\s+/).pop()).filter(Boolean)
      : []
    return synthetic(specifier, Object.fromEntries(names.map(name => [name, noop])))
  })
  await pluginModule.evaluate()
  return pluginModule.namespace
}

async function renderPage({ legacyHost = false } = {}) {
  const stateUpdates = []
  const queries = new Map()
  let bundles = {}
  let stateIndex = 0
  const host = {
    navigate() {},
    state: { profile: {} }
  }
  if (!legacyHost) host.state.connectionId = {}
  const components = Object.fromEntries([
    'Button', 'Codicon', 'Input', 'Switch', 'Popover', 'PopoverTrigger', 'PopoverContent',
    'Select', 'SelectContent', 'SelectItem',
    'SelectTrigger', 'SelectValue', 'Tabs', 'TabsList', 'TabsTrigger'
  ].map(name => [name, sdkComponent(name)]))
  const jsx = (type, props = {}) => {
    if (typeof type === 'function') {
      if (type.sdkName) return { type: type.sdkName, props }
      return type(props)
    }
    return { type, props }
  }
  const useState = initial => {
    const index = stateIndex++
    return [initial, value => stateUpdates.push({ index, value: typeof value === 'function' ? value(initial) : value })]
  }
  const quota = {
    providers: [{ id: 'openai-codex', name: 'Codex', status: 'ok', plan: null, windows: [], facts: [], source: null, fetched_at: null, url: null }]
  }
  const history = {
    by_model: [],
    coverage: { legacy_sessions: 0, unattributed_main_tokens_in_profile: 0 },
    has_more: false,
    model_options: ['gpt-5', 'claude-sonnet', '__provider_limits_all_models__'],
    period: 'Histórico acumulado.',
    sessions: [],
    source: 'state.db',
    total_sessions: 0,
    totals: { total_tokens: 0 }
  }
  const useQuery = options => {
    queries.set(options.queryKey[0], options)
    return {
      data: options.queryKey[0] === 'provider-limits-history' ? history : quota,
      error: null,
      isFetching: false,
      isPending: false,
      refetch() {}
    }
  }
  const context = vm.createContext({
    Array, Date, Error, Intl, Map, Math, Number, Object, RegExp, Set, String,
    URLSearchParams, clearTimeout, console, encodeURIComponent, setTimeout
  })
  const jsxModule = new vm.SyntheticModule(['jsx', 'jsxs'], function () {
    this.setExport('jsx', jsx)
    this.setExport('jsxs', jsx)
  }, { context })
  const reactModule = new vm.SyntheticModule(['useEffect', 'useMemo', 'useState'], function () {
    this.setExport('useEffect', () => {})
    this.setExport('useMemo', fn => fn())
    this.setExport('useState', useState)
  }, { context })
  const t = (key, ...args) => {
    let value = bundles.en
    for (const segment of key.split('.')) value = value?.[segment]
    return typeof value === 'function' ? value(...args) : (value ?? key)
  }
  const sdkExports = {
    ...components,
    atom: initial => {
      let value = initial
      return { get: () => value, set: next => { value = next } }
    },
    PALETTE_AREA: 'palette',
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar',
    STATUSBAR_AREAS: { right: 'status-right' },
    host,
    useQuery,
    useQueryClient: () => ({ invalidateQueries() {} }),
    usePluginI18n: () => t,
    useI18n: () => ({ locale: 'en' }),
    useValue: atom => {
      if (!atom) throw new TypeError('useValue requires an atom')
      return atom === host.state.profile ? 'default' : 'local'
    }
  }
  const sdkModule = new vm.SyntheticModule(Object.keys(sdkExports), function () {
    for (const [name, value] of Object.entries(sdkExports)) this.setExport(name, value)
  }, { context })
  const pluginModule = new vm.SourceTextModule(fs.readFileSync(pluginPath, 'utf8'), {
    context,
    identifier: pluginPath
  })
  await pluginModule.link(specifier => ({
    'react/jsx-runtime': jsxModule,
    react: reactModule,
    '@hermes/plugin-sdk': sdkModule
  })[specifier])
  await pluginModule.evaluate()

  const contributions = []
  const ctx = {
    onDispose() {},
    i18n: {
      register(value) { bundles = value },
      t
    },
    registerMany(items) { contributions.push(...items) },
    rest() { throw new Error('render test must not fetch directly') }
  }
  if (!legacyHost) ctx.os = { openExternal() {} }
  pluginModule.namespace.default.register(ctx)
  const route = contributions.find(item => item.area === 'routes')
  return { nodes: walk(route.render()), stateUpdates, queries }
}

test('history filters use Hermes themed selects instead of native popups', async () => {
  const { nodes } = await renderPage()

  assert.equal(nodes.filter(node => node.type === 'Select').length, 2)
  assert.equal(nodes.filter(node => node.type === 'SelectTrigger').length, 2)
  assert.equal(nodes.filter(node => node.type === 'SelectContent').length, 2)
  assert.equal(nodes.filter(node => node.type === 'select').length, 0)
  assert.equal(nodes.filter(node => node.type === 'option').length, 0)
})

test('themed history selects preserve model and sort changes', async () => {
  const { nodes, stateUpdates } = await renderPage()
  const selects = nodes.filter(node => node.type === 'Select')
  const modelItems = walk(selects[0].props.children).filter(node => node.type === 'SelectItem')
  const gpt5 = modelItems.find(item => item.props.children === 'gpt-5')

  selects[0].props.onValueChange(gpt5.props.value)
  selects[1].props.onValueChange('recent')

  assert.equal(stateUpdates[0].value.value, 'gpt-5')
  assert.equal(stateUpdates[0].value.key, 'v1:gpt-5')
  assert.deepEqual(stateUpdates.slice(1).map(update => update.value), [0, 'recent', 0])
})

test('history selects stay compact and provide theme-safe control classes', async () => {
  const { nodes } = await renderPage()

  assert.equal(nodes.filter(node => node.type === 'div' && node.props.className === 'pl-select-wrap').length, 2)
  const triggers = nodes.filter(node => node.type === 'SelectTrigger')
  assert.equal(triggers.length, 2)
  assert.ok(triggers.every(trigger => trigger.props.className === 'pl-select-trigger'))
  const items = nodes.filter(node => node.type === 'SelectItem')
  assert.ok(items.length > 0)
  assert.ok(items.every(item => item.props.className === 'pl-select-item'))
})

test('all-models control value cannot collide with a literal model name', async () => {
  const { nodes, stateUpdates } = await renderPage()
  const modelSelect = nodes.find(node => node.type === 'Select')
  const items = walk(modelSelect.props.children).filter(node => node.type === 'SelectItem')
  const values = items.map(item => item.props.value)
  const literalSentinelModel = items.find(item => item.props.children === '__provider_limits_all_models__')
  const allModels = items.find(item => item.props.children === 'All models')

  assert.equal(new Set(values).size, values.length)
  modelSelect.props.onValueChange(literalSentinelModel.props.value)
  modelSelect.props.onValueChange(allModels.props.value)
  assert.equal(stateUpdates[0].value.value, '__provider_limits_all_models__')
  assert.equal(stateUpdates[0].value.key, 'v1:__provider_limits_all_models__')
  assert.deepEqual(stateUpdates.slice(1).map(update => update.value), [0, null, 0])
})

// Hermes releases before v2026.8.31 do not define --dt-primary-solid*. Their
// accent pair also fails normal-text AA in two shipped themes, so the fallback
// uses the palette's inverse foreground/background seeds, which already exist at
// the 0.20.3 package floor and clear both text and indicator contrast.
test('highlight tokens have a contrast-guaranteed legacy fallback', async () => {
  const { CSS } = await loadPluginModule()
  const rule = CSS.split('\n').find(line => line.includes('.pl-select-item[data-highlighted]'))

  assert.ok(rule, 'highlight rule is missing')
  assert.match(rule, /background:var\(--dt-primary-solid,var\(--theme-foreground\)\)/)
  assert.match(rule, /color:var\(--dt-primary-solid-foreground,var\(--theme-background-seed\)\)/)
  assert.match(rule, /outline:2px solid var\(--theme-foreground\)/)
  assert.match(rule, /outline-offset:-2px/)
  assert.doesNotMatch(rule, /--dt-accent/)
  assert.doesNotMatch(rule, /var\(--dt-primary-solid(-foreground)?\)/)
})

test('legacy SDK shape without connectionId or ctx.os renders without crashing', async () => {
  const { nodes, queries } = await renderPage({ legacyHost: true })

  assert.ok(nodes.length > 0)
  const quota = queries.get('provider-limits')
  assert.ok(quota, 'quota query was never registered')
  assert.equal(quota.queryKey[2], null, 'legacy host must use a neutral connection key')
})
