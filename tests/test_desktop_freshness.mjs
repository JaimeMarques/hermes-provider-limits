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
// Tagged so the host-bar fixture can flatten them the way Radix does: Popover
// renders no element, PopoverTrigger asChild is the chip itself, and the
// content is portalled out of the status bar.
const slotted = (tag, slot) => props => primitive(tag)({ ...props, 'data-fixture': slot })
export const Popover = slotted('div', 'popover'), PopoverTrigger = slotted('div', 'popover-trigger')
export const PopoverContent = slotted('div', 'popover-content')
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
          used_percent: window.fixtureOptions?.usage?.[id]?.used ?? 27,
          reset_at: new Date(Date.now() + (window.fixtureOptions?.usage?.[id]?.resetHours ?? 24) * 3600000).toISOString() }] })) }
  }
}
plugin.register(ctx)
// The host's own context gauge (apps/desktop/src/app/shell/hooks/use-statusbar-items.tsx
// 'context-usage': label usageContextLabel(), detail contextBarLabel() from
// lib/statusbar.tsx), rendered with the same element and class shape as
// StatusbarItemView's menu variant in statusbar-controls.tsx.
const contextGauge = () => React.createElement('button', { key: 'context-usage', type: 'button',
  className: 'host-action', 'data-host-replica': 'context-usage' },
  React.createElement('span', { className: 'truncate' }, '~137.5k/1M'),
  React.createElement('span', { className: 'truncate host-detail' }, '[█░░░░░░░░░] ~14%'))
const root = createRoot(document.getElementById('root'))
root.render(React.createElement(QueryClientProvider, { client },
  ...(window.fixtureOptions?.surfaces ?? ['page', 'status-gauges']).map(id => React.createElement('div', { key: id, id },
    React.createElement(registrations.find(item => item.id === id).render),
    id === 'status-gauges' && window.fixtureOptions?.contextGauge ? contextGauge() : null))))
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

// Host environment for the hostBar fixture, taken from the Desktop source
// (hermes-agent apps/desktop/src): styles.css base layer and dark tokens, the
// statusbar footer/cluster classes and STATUSBAR_ACTION_CLASS
// (app/shell/statusbar-controls.tsx:30-31, :104, :114, :119, :239-240).
const HOST_CSS = [
  ':root{--ui-base:#e4e4e6;--ui-text-primary:color-mix(in srgb,var(--ui-base) 94%,transparent);',
  '--ui-text-secondary:color-mix(in srgb,var(--ui-base) 74%,transparent);--ui-text-tertiary:color-mix(in srgb,var(--ui-base) 54%,transparent);',
  '--ui-text-quaternary:color-mix(in srgb,var(--ui-base) 36%,transparent);--ui-red:#e75e78;--ui-orange:#db704b;--ui-yellow:#c08532;',
  '--ui-stroke-secondary:color-mix(in srgb,var(--ui-base) 12%,transparent);--chrome-action-hover:color-mix(in srgb,var(--ui-base) 4%,transparent);',
  '--dt-foreground:var(--ui-text-primary);--dt-muted-foreground:var(--ui-text-tertiary);--dt-base-size:1rem;--dt-line-height:1.5;',
  "--dt-font-sans:'Segoe WPC','Segoe UI',-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif,'Apple Color Emoji','Segoe UI Emoji','Segoe UI Symbol','Noto Color Emoji',emoji;",
  '--ui-sidebar-surface-background:#121214}',
  '*,::before,::after{box-sizing:border-box;margin:0;padding:0;border:0 solid}',
  'html{font-size:var(--dt-base-size,0.875rem)}',
  'body{margin:0;background:#0d0d0e;color:var(--dt-foreground);font-family:var(--dt-font-sans);font-size:0.8125rem;line-height:var(--dt-line-height,1.55);-webkit-font-smoothing:antialiased}',
  'button{font:inherit;color:inherit;background-color:transparent;border-radius:0;cursor:pointer}',
  '#bar{display:flex;height:1.25rem;flex-shrink:0;align-items:stretch;justify-content:space-between;gap:0.5rem;padding:0 0.25rem;background:var(--ui-sidebar-surface-background);color:var(--ui-text-tertiary)}',
  '#bar>div,#status-gauges{display:flex;min-width:0;align-items:stretch;gap:0.125rem;overflow-x:clip}',
  '#left-items>span{display:inline-flex;align-items:center;padding:0 0.375rem;font-size:0.6875rem}',
  '.host-action{display:inline-flex;height:100%;align-items:center;gap:0.25rem;border-radius:0;padding:0 0.375rem;font-size:0.6875rem;color:var(--ui-text-tertiary);transition:color .15s,background-color .15s}',
  '.host-action:hover{background-color:var(--chrome-action-hover);color:var(--dt-foreground)}',
  '.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.host-detail{color:color-mix(in srgb,var(--dt-muted-foreground) 80%,transparent)}',
  // Radix: Popover renders nothing, PopoverTrigger asChild is the chip, content is portalled.
  '[data-fixture=popover],[data-fixture=popover-trigger]{display:contents}[data-fixture=popover-content]{display:none}',
  // The Tailwind utilities the plugin's chip markup names exist in the host's
  // compiled CSS (the host uses the same STATUSBAR_ACTION_CLASS), inside
  // `@layer utilities`, so unlayered plugin CSS wins over them as in the host.
  '@layer utilities{.inline-flex{display:inline-flex}.h-full{height:100%}.items-center{align-items:center}.gap-1{gap:0.25rem}',
  '.rounded-none{border-radius:0}.px-1\\.5{padding-inline:0.375rem}.text-\\[0\\.6875rem\\]{font-size:0.6875rem}',
  '.text-\\(--ui-text-tertiary\\){color:var(--ui-text-tertiary)}.text-\\(--ui-text-quaternary\\){color:var(--ui-text-quaternary)}',
  '.tabular-nums{font-variant-numeric:tabular-nums}.transition-colors{transition-property:color,background-color;transition-duration:.15s}',
  '.hover\\:bg-\\(--chrome-action-hover\\):hover{background-color:var(--chrome-action-hover)}.hover\\:text-foreground:hover{color:var(--dt-foreground)}}'
].join('')

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
  const page = await browser.newPage({ viewport: { width: options.viewportWidth ?? (options.narrow ? 420 : 1100), height: options.viewportHeight ?? 720 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.install({ time: new Date('2026-09-20T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-20T12:00:00Z'))
  await page.setContent(options.hostBar
    // Mirrors the Desktop host (apps/desktop/src/app/shell/statusbar-controls.tsx):
    // a `flex h-5 items-stretch justify-between gap-2 px-1` footer whose clusters
    // are content-sized `flex min-w-0 items-stretch gap-0.5 overflow-x-clip` rows
    // with no width, and the plugin root mounted as a direct child of the right
    // cluster. Host page typography comes from apps/desktop/src/styles.css
    // (html font-size var(--dt-base-size)=1rem, body 0.8125rem/1.5 --dt-font-sans,
    // dark-mode palette tokens) plus Tailwind preflight's button reset. The
    // `.host-action` replica is STATUSBAR_ACTION_CLASS translated to CSS
    // (inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem]
    // text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)), its detail
    // span `truncate text-muted-foreground/80`.
    ? `<style>${HOST_CSS}#bar{width:${options.viewportWidth ?? 1300}px}#left-items>span{flex:none;width:${options.hostBar.leftWidth ?? 240}px}</style><div id="bar" data-slot="statusbar"><div id="left-items"><span>left items</span></div><div id="root" style="display:contents"></div></div>`
    : options.narrow
    ? `<style>#root{display:flex;width:${(options.viewportWidth ?? 420) - 8}px;justify-content:space-between}#status-gauges{display:flex;width:${options.slotWidth ?? 160}px;min-width:0;overflow-x:clip;height:20px}button{cursor:pointer}[data-fixture=popover],[data-fixture=popover-trigger]{display:contents}[data-fixture=popover-content]{display:none}</style><div id="root"></div>`
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

test('two gauges show individual chips in a content-sized Desktop status-bar cluster', async t => {
  const page = await browserFixture(t, { hostBar: {}, viewportWidth: 1300,
    surfaces: ['status-gauges'], providerIds: ['anthropic', 'openai-codex'] })
  assert.equal(await page.locator('[data-provider-chip]:visible').count(), 2)
  assert.equal(await page.locator('.pl-status-compact').isVisible(), false)
  // Content-sized: the root receives exactly the width its one-line chips need.
  const gauges = await page.locator('.pl-status-gauges').boundingBox()
  const chips = await page.locator('.pl-status-chips').boundingBox()
  assert.ok(gauges && chips && chips.width > 0 && gauges.width + 0.5 >= chips.width,
    `gauge root keeps its requested content width (root ${gauges?.width}, chips ${chips?.width})`)
  await page.evaluate(() => fixture.unmount())
})

test('two gauges render one line each like the host context gauge at the real status-bar height', async t => {
  // Sample values: Claude 55% used at 49% pace,
  // GPT 47% at 11%. resetHours places each weekly window at that pace point.
  const screenshot = process.env.PL_GAUGES_SCREENSHOT
  const page = await browserFixture(t, { hostBar: {}, viewportWidth: 1300, viewportHeight: 40, contextGauge: true,
    deviceScaleFactor: screenshot ? 2 : 1, surfaces: ['status-gauges'], providerIds: ['anthropic', 'openai-codex'],
    usage: { anthropic: { used: 55, resetHours: 86 }, 'openai-codex': { used: 47, resetHours: 150 } } })
  assert.equal(await page.locator('[data-provider-chip]:visible').count(), 2, 'both chips are visible')
  assert.equal(await page.locator('.pl-status-compact').isVisible(), false)
  const layout = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom, height: r.height, width: r.width, centre: (r.top + r.bottom) / 2 } }
    const styleOf = el => { const s = getComputedStyle(el); return { fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight,
      height: s.height, paddingLeft: s.paddingLeft, paddingRight: s.paddingRight, columnGap: s.columnGap, borderRadius: s.borderRadius,
      backgroundColor: s.backgroundColor, display: s.display, alignItems: s.alignItems, whiteSpace: s.whiteSpace } }
    const textRects = el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const rects = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const r of range.getClientRects()) if (r.width > 0) rects.push({ text: node.textContent, top: r.top, bottom: r.bottom, centre: (r.top + r.bottom) / 2 })
      }
      return rects
    }
    const part = (chip, selector) => { const el = chip.querySelector(selector); return el && { text: el.textContent, ...rect(el) } }
    const replica = document.querySelector('[data-host-replica=context-usage]')
    const root = document.querySelector('.pl-status-gauges')
    return {
      bar: rect(document.getElementById('bar')),
      root: { ...rect(root), scrollHeight: root.scrollHeight, clientHeight: root.clientHeight },
      replica: { ...rect(replica), style: styleOf(replica), detail: replica.lastChild.textContent, text: textRects(replica) },
      chips: [...document.querySelectorAll('[data-provider-chip]')].map(chip => ({
        id: chip.dataset.providerChip, text: chip.textContent, title: chip.title, box: rect(chip), style: styleOf(chip),
        scrollHeight: chip.scrollHeight, clientHeight: chip.clientHeight, lines: textRects(chip),
        parts: { label: part(chip, '.pl-status-chip-label'), bar: part(chip, '.pl-status-chip-bar'),
          percent: part(chip, '.pl-status-chip-percent'), pace: part(chip, '.pl-status-chip-pace') }
      }))
    }
  })
  if (screenshot) {
    await page.locator('#bar').screenshot({ path: screenshot, animations: 'disabled' })
    // The host paints its grey item box on hover (hover:bg-(--chrome-action-hover)).
    await page.locator('[data-provider-chip=anthropic]').hover()
    await page.locator('#bar').screenshot({ path: screenshot.replace(/\.png$/, '-hover.png'), animations: 'disabled' })
    await page.locator('[data-host-replica=context-usage]').hover()
    await page.locator('#bar').screenshot({ path: screenshot.replace(/\.png$/, '-hover-context.png'), animations: 'disabled' })
  }
  const detail = JSON.stringify(layout.chips.map(chip => ({ id: chip.id, text: chip.text, box: chip.box, lines: chip.lines })))
  assert.equal(layout.bar.height, 20, 'host footer h-5 at the default 1rem base size')
  assert.equal(layout.chips.length, 2)
  for (const chip of layout.chips) {
    assert.ok(chip.box.height <= layout.bar.height + 0.5, `${chip.id} chip height ${chip.box.height} exceeds the ${layout.bar.height}px bar: ${detail}`)
    assert.ok(chip.box.top >= layout.bar.top - 0.5 && chip.box.bottom <= layout.bar.bottom + 0.5, `${chip.id} chip leaves the bar: ${detail}`)
    assert.ok(chip.scrollHeight <= chip.clientHeight, `${chip.id} chip overflows vertically: ${detail}`)
    assert.ok(chip.lines.length > 0)
    for (const line of chip.lines) {
      assert.ok(line.top >= layout.bar.top - 0.5 && line.bottom <= layout.bar.bottom + 0.5, `${chip.id} text "${line.text}" is clipped by the bar: ${detail}`)
      assert.ok(Math.abs(line.centre - chip.lines[0].centre) <= 1, `${chip.id} text "${line.text}" is on another line: ${detail}`)
    }
    const { label, bar, percent, pace } = chip.parts
    assert.ok(label && bar && percent && pace, `${chip.id} names label, bar, primary % and bracket %: ${detail}`)
    assert.equal(label.text, chip.id === 'anthropic' ? 'Claude' : 'GPT')
    assert.match(bar.text, /^\[[█░]{10}\]$/)
    assert.match(percent.text, /^\d+%$/)
    assert.match(pace.text, /^\[\d+%\]$/)
    for (const item of [bar, percent, pace]) assert.ok(Math.abs(item.centre - label.centre) <= 1, `${chip.id} parts share one row: ${detail}`)
    assert.ok(label.left < bar.left && bar.left < percent.left && percent.left < pace.left, `${chip.id} reads label [bar] % [%]`)
    assert.doesNotMatch(chip.text, /7d|·/, 'window label moves to the tooltip')
    assert.match(chip.title, /Weekly window/)
    // Same chrome as the host's context gauge (STATUSBAR_ACTION_CLASS).
    for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'height', 'paddingLeft', 'paddingRight', 'columnGap', 'borderRadius', 'backgroundColor', 'display', 'alignItems']) {
      assert.equal(chip.style[key], layout.replica.style[key], `${chip.id} ${key} matches the context gauge`)
    }
    assert.ok(Math.abs(chip.box.height - layout.replica.height) <= 0.5 && Math.abs(label.centre - layout.replica.text[0].centre) <= 1)
  }
  assert.deepEqual(layout.chips.map(chip => [chip.parts.percent.text, chip.parts.pace.text]), [['55%', '[49%]'], ['47%', '[11%]']])
  assert.match(layout.replica.detail, /^\[[█░]{10}\] ~\d+%$/, 'context gauge uses the same bracketed 10-cell bar')
  assert.ok(layout.root.scrollHeight <= layout.root.clientHeight, 'gauge root does not overflow vertically')
  await page.evaluate(() => fixture.unmount())
})

test('two gauges still fall back to the compact route when the Desktop status bar is crowded', async t => {
  const page = await browserFixture(t, { hostBar: { leftWidth: 1150 }, viewportWidth: 1300,
    surfaces: ['status-gauges'], providerIds: ['anthropic', 'openai-codex'] })
  assert.equal(await page.locator('[data-provider-chip]:visible').count(), 0)
  const compact = page.locator('.pl-status-compact')
  assert.equal(await compact.isVisible(), true)
  assert.match(await compact.innerText(), /Usage · 2/)
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