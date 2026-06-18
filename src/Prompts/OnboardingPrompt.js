export function buildOnboardingPrompt(schema) {
  const summary = schema.summarize();
  const isNew = schema.get().revision === 0;

  const intro = isNew
    ? `The graph memory database has been initialized with a default schema (revision 0).`
    : `The graph memory database is running schema revision ${schema.get().revision}.`;

  return {
    name: 'setup',
    description: 'Review and customize the graph memory schema. Run this when setting up for the first time or when the user asks to update the schema.',
    arguments: [],
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            intro,
            '',
            'Current schema:',
            '```',
            summary,
            '```',
            '',
            isNew
              ? 'Please show the user a simple diagram of this schema and ask if they want to customize it or use it as-is.'
              : 'Please show the user a diagram of the current schema and ask what they would like to add or change.',
            '',
            'Rules:',
            '- Call get_schema to fetch the exact current YAML before building changes.',
            '- Adding a new node or edge type: just include it in the YAML with a description.',
            '- Renaming a type: add a migrations entry { rename_node: { from, to } } or { rename_edge: { from, to } }. This is safe — it relabels every existing node/edge of that type in the database, no data is lost.',
            '- Removing a type: add { remove_node: { type } } or { remove_edge: { type } }. This only succeeds if no node/edge of that type currently exists — rename it elsewhere first if it does.',
            '- nodes: and edges: are patches — existing types you do not mention stay exactly as they are. The only way to rename or remove a type is the migrations section above; omitting a type from the YAML never changes or deletes it.',
            '- If the user wants no changes, call apply_schema with the current schema unchanged (still bumps the revision to confirm the review).',
            '- Keep the YAML clean: nodes section and edges section, each type with a description; migrations section only when renaming/removing.'
          ].join('\n')
        }
      }
    ]
  };
}
