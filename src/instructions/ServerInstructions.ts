import { BOOTSTRAP_ID } from '../Consts'


/** Claude Code cuts instructions past this length. */
export const MAX_LENGTH = 4096

const READ_TIMEOUT_MS = 1500
const INTRO = 'Persistent memory graph: nodes and edges that survive across sessions. Use `search` when earlier work, the user or their projects may matter, and store lasting facts with `add_node` and `add_edge`.'
const CALL_BOOTSTRAP = 'At the start of every session, call `bootstrap` to load your identity, the user context and working rules.'
const INLINE_HEADER = `Your identity, the user context and working rules follow, taken from the \`${BOOTSTRAP_ID}\` node. No \`bootstrap\` call is needed. Change them with \`update_node\`; the change applies from the next session.`
const TRUNCATED = '\n\n[Truncated. Call `bootstrap` for the full text.]'


// The MCP `instructions` field: clients load it at session start, before any
// tool definition, so it tells the agent what the server is for and how to
// get its identity. Without a node it only points at the bootstrap tool.
/** The instructions with the text of the bootstrap node, cut to MAX_LENGTH; without a node a pointer to the bootstrap tool. */
export function renderInstructions(node: { properties: Record<string, unknown> } | null): string {
    if (!node) {
        return `${INTRO}\n\n${CALL_BOOTSTRAP}`
    }
    const head = `${INTRO}\n\n${INLINE_HEADER}\n\n`
    const body = nodeText(node.properties)
    if (head.length + body.length <= MAX_LENGTH) {
        return head + body
    }
    return head + body.slice(0, MAX_LENGTH - head.length - TRUNCATED.length) + TRUNCATED
}


// A locked or failing database must not hold up the server start: after the
// timeout, or on an error, the instructions point at the bootstrap tool.
/** The instructions once `read` gives the bootstrap node, or the pointer when it fails or takes too long. */
export async function buildInstructions(read: Promise<{ properties: Record<string, unknown> } | null>, timeoutMs = READ_TIMEOUT_MS): Promise<string> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>(resolve => {
        timer = setTimeout(resolve, timeoutMs, null)
    })
    const node = await Promise.race([read.catch(() => null), timeout])
    clearTimeout(timer)
    return renderInstructions(node)
}


// The text property as it is, other properties as JSON.
function nodeText(properties: Record<string, unknown>): string {
    const { text } = properties
    return typeof text === 'string' ? text.trim() : JSON.stringify(properties, null, 2)
}
