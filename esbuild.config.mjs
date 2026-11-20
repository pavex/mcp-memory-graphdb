import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'


const ROOT = import.meta.dirname
const DIST = join(ROOT, 'dist')
// Linux has separate DuckDB bindings for musl (Alpine); glibc reports its version
const MUSL = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime
const BINDINGS = join(ROOT, 'node_modules', '@duckdb', `node-bindings-${process.platform}-${process.arch}${MUSL ? '-musl' : ''}`)
const NATIVE = /\.(node|dll|so|dylib)$/

// The platform package of DuckDB is replaced by a require of duckdb.node
// next to mcp.js, so dist/ carries the native binding of the build machine.
const DUCKDB_PLUGIN = {
    name: 'duckdb-local',
    setup(build) {
        build.onResolve({ filter: /node-bindings/ }, args => ({ path: args.path, namespace: 'duckdb-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'duckdb-stub' }, () => ({ contents: 'module.exports = require(\'./duckdb.node\')', loader: 'js' }))
    }
}


if (!existsSync(BINDINGS)) {
    console.error(`ERROR: DuckDB bindings not found: ${BINDINGS}`)
    process.exit(1)
}
mkdirSync(DIST, { recursive: true })

// Everything else imported is bundled - the MCP SDK, zod and js-yaml too. The
// banner gives the bundled CommonJS parts a require(). dist/ is what gets
// deployed: mcp.js, the native DuckDB files, the default schema and the
// config template. The tests run from the TypeScript sources directly
// (test/support/register.mjs).
await build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    external: ['*.node'],
    plugins: [DUCKDB_PLUGIN],
    banner: { js: 'import { createRequire } from \'node:module\'; const require = createRequire(import.meta.url);' },
    entryPoints: ['src/main.ts'],
    outfile: 'dist/mcp.js'
})
const copied = ['schema.default.yaml', 'config.example.json']
for (const file of copied) {
    copyFileSync(join(ROOT, file), join(DIST, file))
}
// A running server keeps its duckdb.dll locked on Windows; an unchanged
// file is left as it is, so the build works while sessions use dist/.
const native = readdirSync(BINDINGS).filter(file => NATIVE.test(file))
for (const file of native) {
    if (!sameFile(join(BINDINGS, file), join(DIST, file))) {
        copyFileSync(join(BINDINGS, file), join(DIST, file))
    }
}
console.log(`Built dist/ (mcp.js, ${[...copied, ...native].join(', ')})`)

if (process.argv.includes('--mcpb')) {
    pack()
}


function sameFile(source, target) {
    return existsSync(target) && statSync(source).size === statSync(target).size && readFileSync(source).equals(readFileSync(target))
}


// dist/ and manifest.json zipped into mcpb/mcp-memory-graphdb.mcpb.
function pack() {
    mkdirSync(join(ROOT, 'mcpb'), { recursive: true })
    const out = join(ROOT, 'mcpb', 'mcp-memory-graphdb.mcpb')
    if (existsSync(out)) {
        unlinkSync(out)
    }
    if (process.platform === 'win32') {
        const zip = join(ROOT, 'mcpb', 'mcp-memory-graphdb.zip')
        if (existsSync(zip)) {
            unlinkSync(zip)
        }
        execSync(`powershell -NoProfile -Command "Compress-Archive -Force -Path '${DIST}','${join(ROOT, 'manifest.json')}' -DestinationPath '${zip}'"`, { stdio: 'inherit' })
        renameSync(zip, out)
    }
    else {
        execSync(`cd "${ROOT}" && zip -r "${out}" dist/ manifest.json`, { stdio: 'inherit' })
    }
    console.log('Packed mcpb/mcp-memory-graphdb.mcpb')
}
