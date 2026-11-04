// Text for the MCP `instructions` field. Clients load it at session start,
// before any tool definition, so this is what tells the agent what the server
// is for and how to get its identity.

export const BOOTSTRAP_ID = '_bootstrap';

// Claude Code cuts instructions past this length
export const MAX_LENGTH = 4096;

const READ_TIMEOUT_MS = 1500;

const INTRO = 'Persistent memory graph: nodes and edges that survive across sessions. Use `search` when earlier work, the user or their projects may matter, and store lasting facts with `add_node` and `add_edge`.';
const CALL_BOOTSTRAP = 'At the start of every session, call `bootstrap` to load your identity, the user context and working rules.';
const INLINE_HEADER = `Your identity, the user context and working rules follow, taken from the \`${BOOTSTRAP_ID}\` node. No \`bootstrap\` call is needed. Change them with \`update_node\`; the change applies from the next session.`;
const TRUNCATED = '\n\n[Truncated. Call `bootstrap` for the full text.]';

const nodeText = (node) => {
  const { text } = node.properties;
  return typeof text === 'string' ? text.trim() : JSON.stringify(node.properties, null, 2);
};

// Without a node the text only points at the bootstrap tool
export const renderInstructions = (node) => {
  if (!node) {
    return `${INTRO}\n\n${CALL_BOOTSTRAP}`;
  }

  const head = `${INTRO}\n\n${INLINE_HEADER}\n\n`;
  const body = nodeText(node);
  if (head.length + body.length <= MAX_LENGTH) {
    return head + body;
  }
  return head + body.slice(0, MAX_LENGTH - head.length - TRUNCATED.length) + TRUNCATED;
};

// A locked or failing database must not hold up the server start
export const buildInstructions = async (read, timeoutMs = READ_TIMEOUT_MS) => {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs, null);
  });

  const node = await Promise.race([read.catch(() => null), timeout]);
  clearTimeout(timer);
  return renderInstructions(node);
};
