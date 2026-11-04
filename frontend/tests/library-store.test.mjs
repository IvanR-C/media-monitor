import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../lib/library-store.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const store = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)

const snap = (over = {}) => ({ version: 'v1', encode: [], translate: [], ...over })

test('applyProgress returns the same array when nothing is active or nothing moved', () => {
  const files = [{ id: 1, encode_progress: 40, encode_job_type: 'encode' }, { id: 2 }]
  assert.equal(store.applyProgress(files, snap()), files)
  assert.equal(store.applyProgress(files, snap({ encode: [{ id: 1, progress: 40, job_type: 'encode' }] })), files)
})

test('applyProgress replaces only the rows whose progress changed', () => {
  const files = [{ id: 1, encode_progress: 40, encode_job_type: 'encode' }, { id: 2 }, { id: 3, translate_status: 'pending', translate_progress: 0 }]
  const next = store.applyProgress(files, snap({
    encode: [{ id: 1, progress: 55.5, job_type: 'encode' }],
    translate: [{ id: 3, status: 'translating', progress: 12 }],
  }))
  assert.notEqual(next, files)
  assert.deepEqual(next[0], { id: 1, encode_progress: 55.5, encode_job_type: 'encode' })
  assert.equal(next[1], files[1])
  assert.deepEqual(next[2], { id: 3, translate_status: 'translating', translate_progress: 12 })
  assert.equal(files[0].encode_progress, 40, 'input rows are not mutated')
})

test('applyProgress: newest job sets job_type, first reported progress wins', () => {
  const files = [{ id: 1, encode_job_type: null }]
  const next = store.applyProgress(files, snap({
    encode: [{ id: 1, progress: 0, job_type: 'remux' }, { id: 1, progress: 30, job_type: 'encode' }],
  }))
  assert.deepEqual(next[0], { id: 1, encode_job_type: 'remux', encode_progress: 30 })
})

test('fetchLibrary revalidates with the cached version and handles 304', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (init.headers['If-None-Match'] === '"v1"') return new Response(null, { status: 304 })
    return new Response(JSON.stringify({ files: [{ id: 1 }], total: 1 }), {
      status: 200, headers: { 'X-Library-Version': 'v1' },
    })
  }

  const first = await store.fetchLibrary()
  assert.equal(first.status, 'updated')
  assert.equal(first.version, 'v1')
  assert.equal(calls[0].init.headers['If-None-Match'], undefined, 'no cache yet → plain request')
  assert.equal(calls[0].init.cache, 'no-store')

  store.setCachedLibrary(first.files, first.version)
  assert.deepEqual(await store.fetchLibrary(), { status: 'unchanged' })
  assert.equal(calls[1].init.headers['If-None-Match'], '"v1"')

  // Overwriting files without a version keeps the known version.
  store.setCachedLibrary([{ id: 1, encode_progress: 5 }])
  assert.equal(store.getCachedLibrary().version, 'v1')
})
