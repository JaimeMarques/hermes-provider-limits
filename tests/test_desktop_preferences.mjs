import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)

async function loadPlugin() {
  const source = await fs.readFile(new URL('desktop/plugin.js', ROOT), 'utf8')
  const context = vm.createContext({ console, URL, URLSearchParams, Intl, Date, Math, Map, Set, Number, String, Object, Array, Promise, Error, RegExp, JSON, encodeURIComponent, setTimeout, clearTimeout })
  const module = new vm.SourceTextModule(source, { context })
  const synthetic = (id, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value)
  }, { context, identifier: id })
  const noop = () => null
  const atom = initial => {
    let value = initial
    return { get: () => value, set: next => { value = next } }
  }
  await module.link(specifier => {
    if (specifier === 'react/jsx-runtime') return synthetic(specifier, { jsx: noop, jsxs: noop })
    if (specifier === 'react') return synthetic(specifier, { useState: noop, useEffect: noop, useMemo: fn => fn() })
    const names = source.match(/import\s*\{([^}]+)\}\s*from\s*'@hermes\/plugin-sdk'/)?.[1]
      .split(',').map(part => part.trim()).filter(Boolean) || []
    return synthetic(specifier, Object.fromEntries(names.map(name => [name, name === 'atom' ? atom : noop])))
  })
  await module.evaluate()
  return module.namespace
}

const plain = value => JSON.parse(JSON.stringify(value))

test('missing, corrupt, or mismatched preference storage fails closed', async () => {
  const { parseGaugePreferences, gaugePreferencesForScope } = await loadPlugin()
  for (const raw of [undefined, null, 'bad', [], { version: 2, scopes: { '["local","angel"]': { anthropic: true } } }]) {
    const parsed = parseGaugePreferences(raw)
    assert.deepEqual(plain(gaugePreferencesForScope(parsed, 'local', 'angel')), {
      anthropic: false, 'openai-codex': false, zai: false
    })
  }
})

test('preference scopes isolate profiles and connections', async () => {
  const { parseGaugePreferences, updateGaugePreference, gaugePreferencesForScope } = await loadPlugin()
  let prefs = parseGaugePreferences()
  prefs = updateGaugePreference(prefs, 'local', 'angel', 'anthropic', true)
  prefs = updateGaugePreference(prefs, 'local', 'phoenix', 'zai', true)
  prefs = updateGaugePreference(prefs, 'remote', 'angel', 'openai-codex', true)

  assert.deepEqual(plain(gaugePreferencesForScope(prefs, 'local', 'angel')), { anthropic: true, 'openai-codex': false, zai: false })
  assert.deepEqual(plain(gaugePreferencesForScope(prefs, 'local', 'phoenix')), { anthropic: false, 'openai-codex': false, zai: true })
  assert.deepEqual(plain(gaugePreferencesForScope(prefs, 'remote', 'angel')), { anthropic: false, 'openai-codex': true, zai: false })
})

test('parsing drops unknown keys and updating preserves siblings', async () => {
  const { parseGaugePreferences, updateGaugePreference, gaugePreferencesForScope } = await loadPlugin()
  const key = JSON.stringify(['local', 'angel'])
  let prefs = parseGaugePreferences({ version: 1, scopes: { [key]: { anthropic: true, zai: true, future: true } } })
  prefs = updateGaugePreference(prefs, 'local', 'angel', 'openai-codex', true)

  assert.deepEqual(plain(gaugePreferencesForScope(prefs, 'local', 'angel')), { anthropic: true, 'openai-codex': true, zai: true })
  assert.equal(Object.hasOwn(prefs.scopes[key], 'future'), false)
})

test('an unsupported provider update is ignored', async () => {
  const { parseGaugePreferences, updateGaugePreference } = await loadPlugin()
  const before = parseGaugePreferences()
  assert.deepEqual(plain(updateGaugePreference(before, 'local', 'angel', 'future', true)), plain(before))
})
