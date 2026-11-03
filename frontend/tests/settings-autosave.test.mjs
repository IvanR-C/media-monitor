import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../lib/settings-autosave.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { SettingsAutosave } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const ok = () => new Response('{}', { status: 200 })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('no initial write; batches only edited fields and debounces typing', async () => {
  const calls = []
  const saver = new SettingsAutosave(() => {}, async (url, options) => { calls.push([url, JSON.parse(options.body)]); return ok() })
  assert.equal(saver.hasUnsavedChanges, false)
  saver.change('ntfy_topic', 'm')
  saver.change('ntfy_topic', 'media')
  saver.change('openai_model', 'custom-model')
  assert.equal(calls.length, 0)
  await new Promise(r => setTimeout(r, 650))
  assert.deepEqual(calls, [['/api/config', { ntfy_topic: 'media', openai_model: 'custom-model' }]])
  assert.equal(saver.hasUnsavedChanges, false)
})

test('immediate changes start a request without a save button', async () => {
  const calls = []
  const saver = new SettingsAutosave(() => {}, async (url, options) => { calls.push(JSON.parse(options.body)); return ok() })
  saver.change('enable_ntfy', false, true)
  assert.deepEqual(calls, [{ enable_ntfy: false }])
  await saver.flush()
})

test('serializes edits made during a slow request and never overwrites newer values', async () => {
  const first = deferred()
  const calls = []
  const saver = new SettingsAutosave(() => {}, async (url, options) => {
    calls.push(JSON.parse(options.body))
    return calls.length === 1 ? first.promise : ok()
  })
  saver.change('ntfy_topic', 'old', true)
  saver.change('ntfy_topic', 'latest')
  saver.change('enable_discord', true)
  const flushing = saver.flush()
  assert.equal(calls.length, 1)
  first.resolve(ok())
  assert.equal(await flushing, true)
  assert.deepEqual(calls, [{ ntfy_topic: 'old' }, { ntfy_topic: 'latest', enable_discord: true }])
  assert.equal(saver.hasUnsavedChanges, false)
})

test('failed HTTP writes stay unsaved; retry keeps the latest edits', async () => {
  const first = deferred()
  const calls = []
  const states = []
  const saver = new SettingsAutosave((...state) => states.push(state), async (url, options) => {
    calls.push(JSON.parse(options.body))
    return calls.length === 1 ? first.promise : ok()
  })
  saver.change('ntfy_topic', 'old', true)
  saver.change('ntfy_topic', 'latest')
  const flushing = saver.flush()
  first.resolve(new Response('{"error":"backend rejected the change"}', { status: 400 }))
  assert.equal(await flushing, false)
  assert.equal(saver.hasUnsavedChanges, true)
  assert.deepEqual(states.at(-1), ['error', 'backend rejected the change'])
  assert.equal(await saver.flush(), true)
  assert.deepEqual(calls.at(-1), { ntfy_topic: 'latest' })
})

test('rule changes refresh statuses; failed refresh retries without rewriting config', async () => {
  const calls = []
  let refreshes = 0
  const saver = new SettingsAutosave(() => {}, async (url, options) => {
    calls.push(url)
    if (url.includes('recalculate') && ++refreshes === 1) return new Response('{}', { status: 500 })
    return ok()
  })
  saver.change('required_sub_langs', ['eng'])
  assert.equal(await saver.flush(), false)
  assert.equal(saver.hasUnsavedChanges, true)
  assert.equal(await saver.flush(), true)
  assert.deepEqual(calls, ['/api/config', '/api/media/recalculate-status', '/api/media/recalculate-status'])
})

test('network failures retain edits for retry', async () => {
  let attempts = 0
  const saver = new SettingsAutosave(() => {}, async () => { if (++attempts === 1) throw new TypeError('offline'); return ok() })
  saver.change('enable_posters', false)
  assert.equal(await saver.flush(), false)
  assert.equal(saver.hasUnsavedChanges, true)
  assert.equal(await saver.flush(), true)
  assert.equal(saver.hasUnsavedChanges, false)
})
