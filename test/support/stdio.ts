import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'


/** The built server. */
export const DIST_SERVER = resolve(import.meta.dirname, '..', '..', 'dist', 'mcp.js')

// The 2026-07-28 era: no handshake, every request carries this envelope.
const MODERN_META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {}
}


/** A JSON-RPC message from the server. */
export interface RpcMessage {
    id?: number
    result?: Record<string, any>
    error?: { code: number, message: string }
}


/** A server process spoken to over stdio. */
export interface StdioServer {
    call(method: string, params?: unknown): Promise<RpcMessage>
    /** A request of the 2026-07-28 era, with the _meta envelope. */
    modern(method: string, params?: Record<string, unknown>): Promise<RpcMessage>
    notify(method: string, params?: unknown): void
    /** initialize + notifications/initialized; the initialize result. */
    initialize(protocolVersion?: string): Promise<RpcMessage>
    /** tools/call; the text of the answer parsed as JSON when it is JSON, and whether it is an error. */
    tool(name: string, args?: unknown): Promise<ToolAnswer>
    /** Everything the server wrote to stderr so far. */
    stderr(): string
    /** Every stdout line that was not JSON-RPC (should stay empty). */
    noise(): string[]
    /** Resolves with the exit code. */
    exited: Promise<number | null>
    /** Closes stdin (the server exits on EOF) and waits for the exit. */
    stop(): Promise<void>
}


/** The answer of a tools/call. */
export interface ToolAnswer {
    text: string
    data: any
    isError: boolean
}


// Spawns `node <script> <args>` and talks newline-delimited JSON-RPC on its
// stdin/stdout. Each call waits at most 30 s for its answer (a busy database
// is retried for up to 10 s).
/** Starts a server process. */
export function startStdioServer(script: string, args: string[] = [], options: { env?: NodeJS.ProcessEnv } = {}): StdioServer {
    const child: ChildProcess = spawn(process.execPath, [script, ...args], { env: options.env ?? process.env })
    const waiting = new Map<number, (message: RpcMessage) => void>()
    const noise: string[] = []
    let buffer = ''
    let errors = ''
    let nextId = 1

    child.stdout?.on('data', chunk => {
        buffer += chunk
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) {
                continue
            }
            try {
                const message = JSON.parse(line) as RpcMessage
                if (message.id !== undefined) {
                    waiting.get(message.id)?.(message)
                    waiting.delete(message.id)
                }
            }
            catch {
                noise.push(line)
            }
        }
    })
    child.stderr?.on('data', chunk => {
        errors += chunk
    })
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))

    const send = (message: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    const call = (method: string, params: unknown = {}) => new Promise<RpcMessage>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 30_000)
        waiting.set(id, message => {
            clearTimeout(timer)
            resolve(message)
        })
        send({ id, method, params })
    })

    return {
        call,
        modern: (method, params = {}) => call(method, { ...params, _meta: MODERN_META }),
        notify: (method, params = {}) => {
            send({ method, params })
        },
        async initialize(protocolVersion = '2025-11-25') {
            const answer = await call('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } })
            send({ method: 'notifications/initialized', params: {} })
            return answer
        },
        async tool(name, args = {}) {
            const answer = await call('tools/call', { name, arguments: args })
            const text = answer.result?.content?.[0]?.text ?? ''
            let data: any
            try {
                data = JSON.parse(text)
            }
            catch {
                data = undefined
            }
            return { text, data, isError: answer.result?.isError === true }
        },
        stderr: () => errors,
        noise: () => noise,
        exited,
        async stop() {
            child.stdin?.end()
            await exited
        }
    }
}
