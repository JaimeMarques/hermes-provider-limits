import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// Real React effects, React Query observers and browser timers. Only the host's
// UI primitives, profile atoms, storage and REST boundary are fixtures.
const sdk = `
import React from 'react'
export { useQuery, useQueryClient } from '@tanstack/react-query'
export const atom = initial => {
  let value = initial
  const listeners = new Set()
  return { get: () => value, set: next => { value = next; listeners.forEach(fn => fn()) },
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
}
export const useValue = store => React.useSyncExternalStore(store.subscribe, store.get)
export const host = { state: { profile: atom('angel'), connectionId: atom('local') }, navigate(path) { window.navigatedTo = path } }
export const ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar', PALETTE_AREA = 'palette'
export const STATUSBAR_AREAS = { right: 'status-right' }
export const bundles = {}
export const usePluginI18n = () => (key, ...args) => {
  const value = key.split('.').reduce((v, k) => v?.[k], bundles.en)
  return typeof value === 'function' ? value(...args) : value ?? key
}
export const useI18n = () => ({ locale: 'en' })
const primitive = tag => ({ children, className, role, id, disabled, onClick, ...props }) =>
  React.createElement(tag, { className, role, id, disabled, onClick,
    ...Object.fromEntries(Object.entries(props).filter(([k]) => /^(aria-|data-)/.test(k))) }, children)
export const Button = primitive('button'), Switch = primitive('button'), Input = primitive('input')
export const Codicon = primitive('span'), Select = primitive('div'), SelectContent = primitive('div')
export const SelectItem = primitive('div'), SelectTrigger = primitive('button'), SelectValue = primitive('span')
export const Tabs = primitive('div'), TabsList = primitive('div'), TabsTrigger = primitive('button')
export const Popover = primitive('div'), PopoverTrigger = primitive('div'), PopoverContent = primitive('div')
`
const entry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import plugin, { quotaQueryOptions } from './desktop/plugin.js'
import { bundles } from '@hermes/plugin-sdk'
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const registrations = [], disposers = []
let calls = 0, age = window.fixtureOptions?.initialAge ?? 895
const ctx = {
  i18n: { register: values => Object.assign(bundles, values), t: key => key },
  registerMany: values => registrations.push(...values),
  onDispose: fn => disposers.push(fn),
  storage: { get: () => ({ version: 1, scopes: { '["local","angel"]': Object.fromEntries(
    (window.fixtureOptions?.providerIds ?? [window.fixtureOptions?.providerId ?? 'anthropic'])
      .map(id => [id, window.fixtureOptions?.enabled !== false])) } }), set() {} },
  rest: async url => {
    if (!url.startsWith('/quota?')) return { sessions: [], models: [], total_sessions: 0, totals: { total_tokens: 0 } }
    calls++
    return { schema_version: 3, profile: 'angel', profile_identity: { name: 'angel', id: 'b'.repeat(64) },
      refresh_seconds: 60, providers: (window.fixtureOptions?.providerIds ?? [window.fixtureOptions?.providerId ?? 'anthropic']).map(id => ({ id, name: 'Fixture', status: 'ok',
        fetched_at: window.fixtureOptions?.noFetchedAt ? null : new Date(Date.now() - age * 1000).toISOString(), age_seconds: age, facts: [{ value: 2, display: { label: { kind: 'message', code: 'fact.availableResets' } } }],
        windows: [{ id: 'seven_day', group: id === 'openai-codex' ? 'Codex' : 'Claude', label: 'Weekly', period_seconds: 604800,
          used_percent: 27, reset_at: new Date(Date.now() + 86400000).toISOString() }] })) }
  }
}
plugin.register(ctx)
const root = createRoot(document.getElementById('root'))
root.render(React.createElement(QueryClientProvider, { client },
  ...(window.fixtureOptions?.surfaces ?? ['page', 'status-gauges']).map(id => React.createElement('div', { key: id, id },
    React.createElement(registrations.find(item => item.id === id).render)))))
const key = quotaQueryOptions(ctx, 'local', 'angel').queryKey
window.fixture = {
  state: () => {
    const query = client.getQueryCache().find({ queryKey: key })
    return { fetchStatus: query.state.fetchStatus, error: query.state.error, calls,
      observers: query.getObserversCount(), fetchedAt: query.state.data?.providers[0].fetched_at, cachedStatus: query.state.data?.providers[0].status,
      cachedWindows: query.state.data?.providers[0].windows.length }
  },
  pause: () => { onlineManager.setOnline(false); void client.refetchQueries({ queryKey: key }) },
  resume: () => { age = 0; onlineManager.setOnline(true) },
  unmount: () => { root.unmount(); disposers.forEach(fn => fn()); client.clear() }
}
`

async function browserFixture(t, options = {}) {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: ROOT }, bundle: true, write: false,
    format: 'iife', platform: 'browser', plugins: [{ name: 'sdk-fixture', setup(builder) {
      builder.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: sdk, resolveDir: ROOT }))
    } }]
  })
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: options.viewportWidth ?? (options.narrow ? 420 : 1100), height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.install({ time: new Date('2026-09-20T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-20T12:00:00Z'))
  await page.setContent(options.narrow
    ? `<style>#root{display:flex;width:${(options.viewportWidth ?? 420) - 8}px;justify-content:space-between}#status-gauges{display:flex;width:${options.slotWidth ?? 160}px;min-width:0;overflow-x:clip;height:20px}button{cursor:pointer}</style><div id="root"></div>`
    : '<div id="root"></div>')
  await page.evaluate(options => { window.fixtureOptions = options }, options)
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.clock.runFor(10)
  await page.waitForFunction(() => fixture.state().observers > 0 &&
    (window.fixtureOptions.enabled === false || document.querySelector('[data-provider-chip]')), null, { timeout: 3000 }).catch(async error => {
    throw new Error(`${error.message}; errors: ${JSON.stringify(errors)}; DOM: ${await page.locator('#root').innerText()}`)
  })
  t.after(() => assert.deepEqual(errors, [], 'browser runtime errors'))
  return page
}

for (const providerId of ['anthropic', 'openai-codex']) for (const noFetchedAt of [false, true]) {
  test(`paused error-free observers expire both Usage and popover without requests (${providerId}, noFetchedAt=${noFetchedAt})`, async t => {
    const page = await browserFixture(t, { noFetchedAt, providerId })
    const initial = await page.evaluate(() => fixture.state())
    assert.equal(initial.calls, 1, 'both mounted surfaces share the actual request')
    assert.equal(initial.observers, 2)
    assert.equal(await page.locator('.pl-status-resets dd').innerText(), '2')
    assert.equal(await page.locator('.pl-status-resets button').count(), 0)
    assert.ok(await page.locator('.pl-status-resets').evaluate(row =>
      row.getBoundingClientRect().top > document.querySelector('.pl-status-window-list').getBoundingClientRect().bottom))
    assert.match(await page.locator('#status-gauges').innerText(), /Fresh/)
    assert.match(await page.locator('#page .pl-section').innerText(), /27%/)
    assert.equal(await page.locator('.pl-status-chip-pace').count(), 1)

    await page.evaluate(() => fixture.pause())
    await page.clock.runFor(10)
    const paused = await page.evaluate(() => fixture.state())
    assert.equal(paused.fetchStatus, 'paused')
    assert.equal(paused.error, null)
    assert.equal(paused.calls, 1)

    assert.match(await page.locator('#status-gauges').innerText(), /Stale/)
    assert.doesNotMatch(await page.locator('#status-gauges').innerText(), /Fresh/)
    assert.equal(await page.locator('.pl-status-chip-pace, .pl-pace-value').count(), 0)
    await page.clock.runFor(4000)
    assert.equal(await page.locator('.pl-status-resets dd').innerText(), '2', 'bounded stale resets remain labeled stale')
    for (const selector of ['#page .pl-section', '#status-gauges']) {
      assert.match(await page.locator(selector).innerText(), /27%/, 'bounded last-known quota is retained')
    }

    // No manual rerender, query-cache write or observer notification at expiry:
    // only time passes while the real QueryObserver's refetch remains paused.
    await page.clock.runFor(2000)
    for (const selector of ['#page .pl-section', '#status-gauges']) {
      const rendered = await page.locator(selector).innerText()
      assert.doesNotMatch(rendered, /27%/, `${selector} must remove expired quota`)
      assert.match(rendered, /Unavailable/i)
    }
    assert.equal(await page.locator('.pl-status-chip-pace, .pl-status-window, .pl-window').count(), 0)
    assert.doesNotMatch(await page.locator('#status-gauges').innerText(), /Fresh/)
    const expired = await page.evaluate(() => fixture.state())
    assert.equal(expired.calls, 1, 'age timer never polls')
    assert.equal(expired.cachedStatus, 'ok', 'display aging does not mutate shared cache')
    assert.equal(expired.cachedWindows, 1)
    assert.equal(await page.locator('.pl-status-resets dd').innerText(), 'Not reported')

    await page.evaluate(() => fixture.resume())
    await page.clock.runFor(10)
    assert.equal((await page.evaluate(() => fixture.state())).calls, 2)
    assert.match(await page.locator('#status-gauges').innerText(), /Fresh/)
    assert.match(await page.locator('#page .pl-section').innerText(), /27%/)
    await page.evaluate(() => fixture.unmount())
    await page.clock.runFor(901000)
    assert.equal(await page.locator('#root').innerText(), '')
  })
}

test('already expired successful responses are unavailable even with an idle error-free observer', async t => {
  const page = await browserFixture(t, { initialAge: 901 })
  const state = await page.evaluate(() => fixture.state())
  assert.equal(state.fetchStatus, 'idle')
  assert.equal(state.error, null)
  for (const selector of ['#page .pl-section', '#status-gauges']) {
    assert.match(await page.locator(selector).innerText(), /Unavailable/i)
    assert.doesNotMatch(await page.locator(selector).innerText(), /27%/)
  }
  await page.evaluate(() => fixture.unmount())
})

for (const viewportWidth of [420, 800]) {
  test(`three gauges retain a visible route at a clipped 160px status slot (${viewportWidth}px viewport)`, async t => {
    const page = await browserFixture(t, { narrow: true, viewportWidth, surfaces: ['status-gauges'],
      providerIds: ['anthropic', 'openai-codex', 'zai'] })
    assert.equal(await page.locator('[data-provider-chip]:visible').count(), 0)
    const compact = page.locator('.pl-status-compact')
    assert.equal(await compact.isVisible(), true)
    assert.match(await compact.innerText(), /Usage · 3/)
    const bounds = await compact.boundingBox()
    const slot = await page.locator('#status-gauges').boundingBox()
    assert.ok(bounds && slot && bounds.x >= slot.x && bounds.x + bounds.width <= slot.x + slot.width,
      'fallback must fit the clipped host slot')
    await compact.click()
    assert.equal(await page.evaluate(() => window.navigatedTo), '/provider-limits')
    await page.evaluate(() => fixture.unmount())
  })
}

test('three gauges retain individual chips when the host grants enough status-bar width', async t => {
  const page = await browserFixture(t, { narrow: true, viewportWidth: 1100, slotWidth: 620,
    surfaces: ['status-gauges'], providerIds: ['anthropic', 'openai-codex', 'zai'] })
  assert.equal(await page.locator('[data-provider-chip]:visible').count(), 3)
  assert.equal(await page.locator('.pl-status-compact').isVisible(), false)
  await page.evaluate(() => fixture.unmount())
})

test('default-off mounted status root makes zero quota requests while time advances', async t => {
  const page = await browserFixture(t, { enabled: false, surfaces: ['status-gauges'] })
  await page.clock.runFor(901000)
  const state = await page.evaluate(() => fixture.state())
  assert.equal(state.observers, 1)
  assert.equal(state.calls, 0)
  assert.equal(await page.locator('#status-gauges').innerText(), '')
  await page.evaluate(() => fixture.unmount())
})