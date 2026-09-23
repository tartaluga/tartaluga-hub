// Генерирует из schema/*.schema.json:
//   src/schema/types.ts       — TypeScript-типы;
//   src/schema/validators.js  — готовые проверяльщики Ajv (standalone).
// Ajv по умолчанию собирает проверяльщики через new Function, а CSP хаба это запрещает,
// поэтому код проверки генерируется заранее.
//
//   node scripts/schema.mjs          — сгенерировать
//   node scripts/schema.mjs --check  — упасть, если сгенерированное устарело (для CI)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import Ajv2020 from 'ajv/dist/2020.js'
import standaloneCode from 'ajv/dist/standalone/index.js'
import { compile } from 'json-schema-to-typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemaDir = join(root, 'schema')
const outDir = join(root, 'src', 'schema')
const check = process.argv.includes('--check')

const NAMES = ['project', 'idea', 'settings', 'status']
const load = (name) => JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), 'utf-8'))
const defs = load('defs')
const schemas = Object.fromEntries(NAMES.map((n) => [n, load(n)]))

// --- проверяльщики ---
const ajv = new Ajv2020({ code: { source: true, esm: true }, allErrors: true, strict: true, strictRequired: false })
ajv.addSchema(defs)
for (const s of Object.values(schemas)) ajv.addSchema(s)
const exportsMap = Object.fromEntries(NAMES.map((n) => [`validate${n[0].toUpperCase()}${n.slice(1)}`, schemas[n].$id]))
// Ajv даже в режиме esm оставляет require() для рантайм-хелперов (ucs2length и т. п.). Это CommonJS-модули:
// импорт «по умолчанию» из них Vitest и Rollup понимают по-разному, и в продакшен-сборке вместо функции
// приходит объект модуля. Поэтому код хелпера встраиваем прямо в validators.js — без импортов вообще.
const require = createRequire(import.meta.url)
const runtimeHelpers = []
const standalone = standaloneCode(ajv, exportsMap).replace(
  /const (\w+) = require\("(ajv\/dist\/runtime\/[\w-]+)"\)\.default;?/g,
  (_, name, mod) => {
    const fn = require(mod).default
    const src = typeof fn === 'function' ? fn.toString() : ''
    // Встраивать можно только самодостаточную функцию: без require и без ссылок на соседей по модулю.
    if (!/^function \w+\(/.test(src) || /require\(/.test(src)) throw new Error(`Хелпер ${mod} нельзя встроить — нужен другой способ`)
    runtimeHelpers.push(`const ${name} = ${src};`)
    return ''
  },
)
if (/require\(/.test(standalone)) throw new Error('В validators.js остался require() — нужен ещё один import')
const validators =
  '/* eslint-disable */\n// Сгенерировано scripts/schema.mjs — не править руками.\n' +
  runtimeHelpers.join('\n') +
  '\n' +
  standalone.replace(/^"use strict";/, '')

// --- типы ---
// $ref на defs.schema.json подставляем заранее: так генератор не ходит по сети за $id.
function inlineDefs(node) {
  if (Array.isArray(node)) return node.map(inlineDefs)
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && node.$ref.startsWith('defs.schema.json#/$defs/')) {
      const { $ref, ...rest } = node
      const key = $ref.split('/').pop()
      return { ...inlineDefs(defs.$defs[key]), ...inlineDefs(rest) }
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inlineDefs(v)]))
  }
  return node
}

let types = '// Сгенерировано scripts/schema.mjs из schema/*.schema.json — не править руками.\n\n'
for (const n of NAMES) {
  const ts = await compile(inlineDefs(schemas[n]), schemas[n].title, {
    bannerComment: '',
    additionalProperties: false, // в типах незнакомых полей нет; в данных они сохраняются (ADR-003)
    strictIndexSignatures: true,
    format: true,
    declareExternallyReferenced: true,
  })
  types += ts + '\n'
}

// --- запись или проверка ---
const files = {
  'types.ts': types,
  'validators.js': validators,
}
let stale = false
for (const [name, content] of Object.entries(files)) {
  const path = join(outDir, name)
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  if (current === content) continue
  if (check) {
    console.error(`Устарел ${path}: запусти npm run schema`)
    stale = true
  } else {
    writeFileSync(path, content)
    console.log(`Записан ${path}`)
  }
}
if (stale) process.exit(1)
