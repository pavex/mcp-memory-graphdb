/** A node type in the schema; properties are a hint (name: type), not enforced. */
export interface NodeTypeDefinition {
    description: string
    properties?: Record<string, string>
}
