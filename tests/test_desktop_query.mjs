import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { QueryClient, QueryObserver } from '@tanstack/query-core'

const ROOT = new URL('../', import.meta.url)
const PROFILE_ID = 'a'.repeat(64)

async function loadPlugin() {
  const source = await fs.readFile(new URL('desktop/plugin.js', ROOT), 'utf8')
  const context = vm.createContext({
    console, URL, URLSearchParams, Intl, Date, Math, Map, Set, Number, String,
    Object, Array, Promise, Error, RegExp, encodeURIComponent, setTimeout, clearTimeout
  })
  const module = new vm.SourceTextModule(source, { context, identifier: 'provider-limits/plugin.js' })
  const synthetic = (id, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value)
  }, { context, identifier: id })
  const noop = () => null
  await module.link(specifier => {
    if (specifier === 'react/jsx-runtime') return synthetic(specifier, { jsx: noop, jsxs: noop })
    if (specifier === 'react') return synthetic(specifier, { useState: noop, useEffect: noop, useMemo: fn => fn() })
    const names = source.match(/import\s*\{([^}]+)\}\s*from\s*'@hermes\/plugin-sdk'/)?.[1]
      .split(',').map(part => part.trim()).filter(Boolean) || []
    return synthetic(specifier, Object.fromEntries(names.map(name => [name, noop])))
  })
  await module.evaluate()
  return module.namespace
}

const response = profile => ({
  schema_version: 3,
  profile,
  profile_identity: { name: profile, id: PROFILE_ID },
  providers: [],
  refresh_seconds: 60
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('quota observers for one scope share one in-flight request and cached result', async () => {
  const { quotaQueryOptions } = await loadPlugin()
  let calls = 0
  const pending = deferred()
  const ctx = { rest: async () => { calls += 1; return pending.promise } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const options = quotaQueryOptions(ctx, 'local', 'angel')
  const page = new QueryObserver(client, options)
  const status = new QueryObserver(client, options)
  const stopPage = page.subscribe(() => {})
  const stopStatus = status.subscribe(() => {})

  assert.equal(calls, 1)
  pending.resolve(response('angel'))
  await settle()
  assert.equal(page.getCurrentResult().data.profile, 'angel')
  assert.equal(status.getCurrentResult().data.profile, 'angel')

  stopPage()
  assert.equal(status.getCurrentResult().data.profile, 'angel')
  stopStatus()
  client.clear()
})

test('disabled quota observer performs zero requests until a gauge enables the shared query', async () => {
  const { quotaQueryOptions } = await loadPlugin()
  let calls = 0
  const ctx = { rest: async () => { calls += 1; return response('angel') } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new QueryObserver(client, quotaQueryOptions(ctx, 'local', 'angel', false))
  const stop = observer.subscribe(() => {})
  await settle()
  assert.equal(calls, 0)

  observer.setOptions(quotaQueryOptions(ctx, 'local', 'angel', true))
  await settle()
  assert.equal(calls, 1)
  stop()
  client.clear()
})

test('quota query identity includes schema, connection, and profile', async () => {
  const { quotaQueryOptions } = await loadPlugin()
  const calls = []
  const ctx = { rest: async path => { calls.push(path); return response(path.includes('phoenix') ? 'phoenix' : 'angel') } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await Promise.all([
    client.fetchQuery(quotaQueryOptions(ctx, 'local', 'angel')),
    client.fetchQuery(quotaQueryOptions(ctx, 'remote', 'angel')),
    client.fetchQuery(quotaQueryOptions(ctx, 'local', 'phoenix'))
  ])
  assert.deepEqual(Array.from(quotaQueryOptions(ctx, 'local', 'angel').queryKey), ['provider-limits', 3, 'local', 'angel'])
  assert.equal(calls.length, 3)
  assert.match(calls[0], /^\/quota\?profile=/)
  client.clear()
})

test('quota query rejects a mismatched response profile identity', async () => {
  const { quotaQueryOptions } = await loadPlugin()
  const options = quotaQueryOptions({ rest: async () => response('phoenix') }, 'local', 'angel')
  await assert.rejects(() => options.queryFn(), /PROFILE_MISMATCH/)
})

for (const rejection of ['401 Unauthorized', 'forbidden', 'PROFILE_MISMATCH', 'INVALID_RESPONSE']) {
  test(`hard quota rejection revokes cached data before a later soft error: ${rejection}`, async () => {
    const { quotaQueryOptions } = await loadPlugin()
    let phase = 'success'
    const ctx = { rest: async () => {
      if (phase === 'soft') throw new Error('network disconnected')
      if (phase === 'hard') {
        if (rejection === 'PROFILE_MISMATCH') return response('phoenix')
        if (rejection === 'INVALID_RESPONSE') return { schema_version: 1 }
        throw new Error(rejection)
      }
      return { ...response('angel'), providers: [{ id: 'anthropic', windows: [{ used_percent: 12 }] }] }
    } }
    const client = new QueryClient()
    const options = quotaQueryOptions(ctx, 'local', 'angel')
    const observer = new QueryObserver(client, { ...options, retry: false })
    const stop = observer.subscribe(() => {})
    try {
      await settle()
      assert.equal(observer.getCurrentResult().data.providers[0].windows[0].used_percent, 12)
      phase = 'hard'
      await observer.refetch()
      assert.equal(observer.getCurrentResult().data, null, 'a hard failure must revoke React Query data')
      assert.equal(options.retry(0, new Error(rejection)), false)
      phase = 'soft'
      await observer.refetch()
      assert.equal(observer.getCurrentResult().data, null, 'soft failure must not resurrect revoked data')
      phase = 'success'
      await observer.refetch()
      assert.equal(observer.getCurrentResult().data.providers[0].id, 'anthropic')
    } finally { stop(); client.clear() }
  })
}

test('switching an observer to profile B cannot paint a late profile A result', async () => {
  const { quotaQueryOptions } = await loadPlugin()
  const a = deferred()
  const ctx = { rest: path => path.includes('angel') ? a.promise : Promise.resolve(response('phoenix')) }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new QueryObserver(client, quotaQueryOptions(ctx, 'local', 'angel'))
  const seen = []
  const stop = observer.subscribe(result => { if (result.data) seen.push(result.data.profile) })
  observer.setOptions(quotaQueryOptions(ctx, 'local', 'phoenix'))
  await settle()
  a.resolve(response('angel'))
  await settle()

  assert.equal(observer.getCurrentResult().data.profile, 'phoenix')
  assert.deepEqual(seen, ['phoenix'])
  stop()
  client.clear()
})
