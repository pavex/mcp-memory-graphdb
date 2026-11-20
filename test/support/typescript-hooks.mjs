// Module hooks for the tests: extensionless relative imports ('../src/Application',
// './GeminiApi') resolve to .ts or /index.ts like in the bundler, and .ts
// files are turned into JavaScript by esbuild on load.

import { transform } from 'esbuild'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'


const RELATIVE = /^\.{1,2}\//
const HAS_EXTENSION = /\.[a-z]+$/i


export async function resolve(specifier, context, next) {
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier) && context.parentURL?.startsWith('file:')) {
        for (const suffix of ['.ts', '/index.ts']) {
            const url = new URL(specifier + suffix, context.parentURL)
            if (await isFile(url)) {
                return { url: url.href, shortCircuit: true }
            }
        }
    }
    return next(specifier, context)
}


export async function load(url, context, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) {
        return next(url, context)
    }
    const { code } = await transform(await readFile(new URL(url), 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'node22',
        sourcemap: 'inline',
        sourcefile: fileURLToPath(url)
    })
    return { format: 'module', source: code, shortCircuit: true }
}


async function isFile(url) {
    return stat(url).then(info => info.isFile(), () => false)
}
