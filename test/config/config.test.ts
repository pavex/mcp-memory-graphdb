import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { loadConfig, parseConfig } from '../../src/config/Config'
import { tempFolder } from '../support/graph'


// The first argument of mcp.js: a database name or path as before, or a JSON
// config with ${NAME} from the environment, a database relative to the
// config's folder and the bootstrap switch; errors that name what to fix.

const PROJECT = resolve(tmpdir(), 'graphdb-project')
const BASE = resolve(tmpdir(), 'graphdb-config')
const NO_ENV = {}


test('a database name or path as the argument', () => {
    assert.equal(loadConfig(undefined, PROJECT, NO_ENV).database, join(PROJECT, '.var', 'memory.duckdb'))
    assert.equal(loadConfig('', PROJECT, NO_ENV).database, join(PROJECT, '.var', 'memory.duckdb'))
    assert.equal(loadConfig('work', PROJECT, NO_ENV).database, join(PROJECT, '.var', 'work.duckdb'))
    assert.equal(loadConfig('work.duckdb', PROJECT, NO_ENV).database, join(PROJECT, '.var', 'work.duckdb'))
    assert.equal(loadConfig('data/my.db', PROJECT, NO_ENV).database, resolve('data/my.db'))
    const absolute = resolve(tmpdir(), 'memory.duckdb')
    assert.equal(loadConfig(absolute, PROJECT, NO_ENV).database, absolute)
    assert.equal(loadConfig('work', PROJECT, NO_ENV).bootstrapInInstructions, true)
    assert.equal(loadConfig('work', PROJECT, { BOOTSTRAP_IN_INSTRUCTIONS: 'false' }).bootstrapInInstructions, false)
})


test('parseConfig: defaults, a path relative to the config, ${NAME} and $${NAME}, the key over the environment', () => {
    assert.deepEqual(parseConfig({}, NO_ENV, BASE), { database: join(BASE, 'memory.duckdb'), bootstrapInInstructions: true })
    assert.equal(parseConfig({}, { BOOTSTRAP_IN_INSTRUCTIONS: 'false' }, BASE).bootstrapInInstructions, false)
    assert.equal(parseConfig({ bootstrapInInstructions: true }, { BOOTSTRAP_IN_INSTRUCTIONS: 'false' }, BASE).bootstrapInInstructions, true)
    assert.equal(parseConfig({ database: '../../${DATA_DIR}/memory.duckdb' }, { DATA_DIR: 'data-x/memory' }, join(BASE, 'a', 'b')).database, join(BASE, 'data-x', 'memory', 'memory.duckdb'))
    const absolute = resolve(tmpdir(), 'memory.duckdb')
    assert.equal(parseConfig({ database: absolute }, NO_ENV, BASE).database, absolute)
    assert.equal(parseConfig({ database: 'db/$${NAME}.duckdb' }, NO_ENV, BASE).database, join(BASE, 'db', '${NAME}.duckdb'))
})


test('errors name what is wrong', () => {
    assert.throws(() => parseConfig([], NO_ENV, BASE), /^Error: Config must be a JSON object$/)
    assert.throws(() => parseConfig(null, NO_ENV, BASE), /Config must be a JSON object/)
    assert.throws(() => parseConfig({ database: '${DATA_DIR}/memory.duckdb' }, NO_ENV, BASE), /Environment variable DATA_DIR is not set \(used in config\.database\)/)
    assert.throws(() => parseConfig({ database: '' }, NO_ENV, BASE), /^Error: Invalid config: database: /)
    assert.throws(() => parseConfig({ database: 5 }, NO_ENV, BASE), /Invalid config: database: /)
    assert.throws(() => parseConfig({ bootstrapInInstructions: 'false' }, NO_ENV, BASE), /Invalid config: bootstrapInInstructions: /)
    assert.throws(() => parseConfig({ dbPath: 'x.duckdb' }, NO_ENV, BASE), /Invalid config: config: .*dbPath/)
})


test('a .json argument is read as a config file', t => {
    const folder = tempFolder(t, 'graphdb-config-test-')
    const file = join(folder, 'config.json')
    writeFileSync(file, JSON.stringify({ database: 'data/${GRAPHDB_TEST_NAME}.duckdb', bootstrapInInstructions: false }))
    assert.deepEqual(loadConfig(file, PROJECT, { GRAPHDB_TEST_NAME: 'mine' }), { database: join(folder, 'data', 'mine.duckdb'), bootstrapInInstructions: false })
    writeFileSync(join(folder, 'broken.json'), '{ "database": ')
    assert.throws(() => loadConfig(join(folder, 'broken.json'), PROJECT, NO_ENV), /^Error: Invalid JSON in .*broken\.json: /)
    assert.throws(() => loadConfig(join(folder, 'missing.json'), PROJECT, NO_ENV), /^Error: Unable to read config at .*missing\.json: /)
})


test('config.example.json is valid', () => {
    const config = loadConfig(resolve(import.meta.dirname, '..', '..', 'config.example.json'), PROJECT, NO_ENV)
    assert.equal(config.bootstrapInInstructions, true)
})
