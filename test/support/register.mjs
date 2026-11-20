// Lets node --test run the TypeScript tests and sources directly, without
// a test build: npm run test:run passes it as --import. The hooks themselves
// are in typescript-hooks.mjs.

import { register } from 'node:module'


register('./typescript-hooks.mjs', import.meta.url)
