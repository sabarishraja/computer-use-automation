import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Capability } from '../artifact/schema.js';

/** Emit the capability JSON Schema so reviewers and other languages can consume it. */
const schema = zodToJsonSchema(Capability, { name: 'Capability', $refStrategy: 'root' });
mkdirSync(resolve(process.cwd(), 'docs'), { recursive: true });
const out = resolve(process.cwd(), 'docs', 'capability.schema.json');
writeFileSync(out, JSON.stringify(schema, null, 2) + '\n', 'utf8');
console.log('wrote ' + out);
