import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const data = JSON.parse(readFileSync(new URL('../lib/data/iso-639-2.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../lib/languages.ts', import.meta.url), 'utf8')
  .replace('import languageData from "./data/iso-639-2.json"', `const languageData = ${JSON.stringify(data)}`)
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { normalizeLanguage, languageLabel, languageSummary } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)

test('official catalog has unique codes and covers languages missing from the old picker', () => {
  assert.ok(data.length > 480)
  assert.equal(new Set(data.map(item => item.code)).size, data.length)
  assert.ok(data.every(item => /^[a-z]{3}$/.test(item.code)))
  assert.equal(languageLabel('nob'), 'Norwegian Bokmål')
  for (const code of ['nld', 'pol', 'swe', 'nor', 'dan', 'fin', 'ces', 'tam', 'tel', 'ukr']) {
    assert.ok(data.some(item => item.code === code))
    assert.ok(!languageLabel(code).startsWith('Unlisted'))
  }
})

test('two-letter and bibliographic aliases resolve to the same readable language', () => {
  for (const [alias, canonical] of [['dut', 'nld'], ['nl', 'nld'], ['ger', 'deu'], ['fre', 'fra'], ['chi', 'zho'], ['cze', 'ces']]) {
    assert.equal(normalizeLanguage(alias), canonical)
    assert.equal(languageLabel(alias), languageLabel(canonical))
  }
})

test('unknown and unlisted codes always have a label and preserve custom codes', () => {
  assert.equal(normalizeLanguage('und'), '')
  assert.equal(languageLabel('und'), 'Unknown / unassigned')
  assert.equal(normalizeLanguage(' QAA '), 'qaa')
  assert.equal(languageLabel('qaa'), 'Unlisted language (qaa)')
  assert.equal(languageLabel('zxx'), 'No linguistic content')
})

test('track summaries deduplicate aliases and exclude tracks marked for removal', () => {
  assert.equal(languageSummary([{ lang: 'nl' }, { lang: 'dut' }, { lang: 'eng' }, { lang: 'pol' }, { lang: 'spa', action: 'drop' }]), 'NLD · ENG +1')
  assert.equal(languageSummary([{ lang: 'und' }]), '?')
  assert.equal(languageSummary([]), 'None')
})
