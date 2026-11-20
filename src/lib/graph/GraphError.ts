// Thrown where the caller (the agent, through the tools) can do something
// about it: a missing node, an unknown type, a rejected schema change, a
// database another session keeps locked. Anything else is a plain Error.
/** An error whose message tells the caller what is wrong and what to do. */
export class GraphError extends Error {

    override name = 'GraphError'
}
