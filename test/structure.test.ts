import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { test } from 'node:test'


// Guards the layout that a wrong import would break silently: lib/graph
// stands alone (its own files, node: built-ins, DuckDB, js-yaml and zod),
// the server uses it through its index, only the application, the tools and
// the prompts talk MCP, every tool is a class extending Tool, and the build
// makes dist/mcp.js from src/main.ts. Reads the files, runs nothing.

const ROOT = resolve(import.meta.dirname, '..')
const LIBRARY = 'src/lib/graph'
const LIBRARY_PACKAGES = ['@duckdb/node-api', 'js-yaml', 'zod']


test('lib/graph imports only its own files, node: built-ins, DuckDB, js-yaml and zod', () => {
    const wrong = imports(LIBRARY).filter(({ target, specifier }) => (target === undefined
        ? !specifier.startsWith('node:') && !LIBRARY_PACKAGES.includes(specifier)
        : !target.startsWith(`${LIBRARY}/`)))
    assert.deepEqual(wrong.map(describe), [])
    assert.deepEqual(readdirSync(join(ROOT, 'src', 'lib')), ['graph'])
})


test('the server uses lib/graph through its index only', () => {
    const wrong = imports('src')
        .filter(({ file }) => !file.startsWith(`${LIBRARY}/`))
        .filter(({ target }) => target !== undefined && target.startsWith(`${LIBRARY}/`) && target !== `${LIBRARY}/index`)
    assert.deepEqual(wrong.map(describe), [])
})


test('lib/graph has its index and README', () => {
    assert.ok(sources(LIBRARY).includes(`${LIBRARY}/index.ts`))
    assert.match(read(`${LIBRARY}/README.md`), /## API/)
})


test('only Application.ts, the tool layer and prompts/MemoryPrompts.ts know the MCP SDK; DuckDB only the datastore', () => {
    const sdk = sources('src').filter(file => /from '@modelcontextprotocol\//.test(read(file))).sort()
    assert.deepEqual(sdk, ['src/Application.ts', 'src/prompts/MemoryPrompts.ts', 'src/tools/MemoryTools.ts', 'src/tools/Tool.ts', 'src/tools/interfaces/ToolConfig.ts'])
    const duckdb = sources('src').filter(file => /from '@duckdb\//.test(read(file))).sort()
    assert.deepEqual(duckdb, [`${LIBRARY}/GraphDatastore.ts`, `${LIBRARY}/GraphDatastore/GraphTables.ts`])
})


test('every tool is a class extending Tool, with no functions outside the class', () => {
    const notTools = ['src/tools/Tool.ts', 'src/tools/MemoryTools.ts']
    const tools = sources('src/tools').filter(file => !file.startsWith('src/tools/interfaces/') && !file.startsWith('src/tools/Tool/') && !notTools.includes(file))
    assert.equal(tools.length, 12)
    for (const file of tools) {
        const text = read(file)
        assert.match(text, /export class \w+Tool extends Tool</, file)
        assert.doesNotMatch(text, /^(export )?(async )?function /m, file)
    }
})


test('the build makes dist/mcp.js from src/main.ts; the tests run from test/ directly', () => {
    const build = read('esbuild.config.mjs')
    assert.doesNotMatch(build, /dist-test|\.test\.|'test\//)
    assert.match(build, /entryPoints: \['src\/main\.ts'\],\s+outfile: 'dist\/mcp\.js'/)
})


// The .ts files under a folder, as paths relative to the project with "/".
function sources(folder: string): string[] {
    return (readdirSync(join(ROOT, folder), { recursive: true }) as string[])
        .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
        .map(file => toPosix(join(folder, file)))
}


function read(file: string): string {
    return readFileSync(join(ROOT, file), 'utf8')
}


// Every import of the files under a folder; target is the imported file
// relative to the project with "/" and without extension, undefined for
// packages and built-ins.
function imports(folder: string): { file: string, specifier: string, target: string | undefined }[] {
    return sources(folder).flatMap(file => [...read(file).matchAll(/from '([^']+)'/g)].map(match => {
        const specifier = match[1]
        const target = specifier.startsWith('.') ? toPosix(relative(ROOT, resolve(ROOT, dirname(file), specifier))) : undefined
        return { file, specifier, target }
    }))
}


function describe({ file, specifier }: { file: string, specifier: string }): string {
    return `${file} -> ${specifier}`
}


function toPosix(path: string): string {
    return path.split(/[\\/]/).join(posix.sep)
}
