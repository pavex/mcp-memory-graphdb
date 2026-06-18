import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

// schema.default.yaml lives at the project root.
// In dev (src/Schema/DefaultSchema.js) that's two levels up.
// In the built bundle (dist/mcp.js) build.mjs copies it next to dist/mcp.js,
// so it's also resolved relative to this file. We try every plausible
// location and use whichever one actually exists on disk.

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDefaultSchemaPath() {
  const candidates = [
    join(__dirname, '../../schema.default.yaml'), // dev: src/Schema/ -> project root
    join(__dirname, '../schema.default.yaml'),     // bundled: dist/ -> dist/../schema.default.yaml
    join(__dirname, 'schema.default.yaml')         // bundled: copied next to dist/mcp.js
  ];

  for (const path of candidates) {
    try {
      readFileSync(path, 'utf8');
      return path;
    } catch {
      // try next candidate
    }
  }

  const tried = candidates.map((c) => `  - ${c}`).join('\n');
  throw new Error(`schema.default.yaml not found. Tried:\n${tried}`);
}

export function loadDefaultSchema() {
  const path = resolveDefaultSchemaPath();
  const raw = readFileSync(path, 'utf8');
  return load(raw);
}
