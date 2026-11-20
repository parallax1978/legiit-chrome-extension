#!/usr/bin/env node
/**
 * Writes docs/legiit-api/reference.md: a readable endpoint reference generated
 * from the OpenAPI contract (docs/legiit-api/openapi.yaml) and the example
 * files (docs/legiit-api/examples/). The contract is the single source for
 * field names, types, limits and descriptions, so the reference cannot drift
 * from it; the examples are real payloads built by the extension's own code
 * (see tests/unit/legiit-api-kit.test.ts).
 *
 *   node scripts/build-api-reference.mjs           write the file
 *   node scripts/build-api-reference.mjs --check   fail if it is out of date
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const kit = join(root, 'docs', 'legiit-api');
const contractPath = join(kit, 'openapi.yaml');
const examplesDir = join(kit, 'examples');
const target = join(kit, 'reference.md');
const bundleTarget = join(kit, 'openapi.examples.json');

const contract = parse(readFileSync(contractPath, 'utf8'));

/**
 * Follows local "$ref" pointers ("#/components/schemas/Name"). Keywords written
 * next to a $ref (a description, a tighter limit) win over the referenced ones.
 * "oneOf: [X, null]" is read as a nullable X.
 */
function deref(node) {
  let current = node;
  let name = null;
  /** A shared type whose own text the field replaced with its own: the reader is pointed to it. */
  let shared = null;
  let guard = 0;
  while (current && typeof current === 'object') {
    let ref = typeof current.$ref === 'string' ? current.$ref : null;
    let nullable = false;
    if (!ref && Array.isArray(current.oneOf) && current.oneOf.length === 2 && current.oneOf.some((s) => s.type === 'null')) {
      ref = current.oneOf.find((s) => typeof s.$ref === 'string')?.$ref ?? null;
      nullable = ref !== null;
    }
    if (!ref) break;
    const parts = ref.replace(/^#\//, '').split('/');
    name = parts.at(-1);
    const target = parts.reduce((value, part) => (value ? value[part] : undefined), contract);
    if (!target) throw new Error(`Unresolved $ref: ${ref}`);
    const { $ref: _ref, oneOf: _oneOf, ...siblings } = current;
    if (parts[1] === 'schemas' && target.description && siblings.description) shared = name;
    current = { ...target, ...siblings };
    if (nullable) current.type = [...new Set([...(Array.isArray(current.type) ? current.type : [current.type]), 'null'])];
    if (++guard > 20) throw new Error(`Circular $ref at ${ref}`);
  }
  if (!current) throw new Error(`Unresolved $ref: ${JSON.stringify(node)}`);
  return { schema: current, name, shared };
}

/** "#id" for the heading "### Id". */
const anchor = (name) => `#${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
/** Shared types that some field points to, in the order they were first used. */
const sharedUsed = new Set();
const sharedLink = (name) => {
  sharedUsed.add(name);
  return `See [${name}](${anchor(name)}).`;
};

const types = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);
/** The schemas that are one plain value (an id, an address…), used by many fields. */
const SHARED_TYPES = Object.entries(contract.components.schemas)
  .filter(([, schema]) => !types(schema).includes('object') && !schema.properties)
  .map(([name]) => name);
const code = (value) => `\`${String(value)}\``;

/** "string", "string or null", "array of string", "object"… */
function typeLabel(schema) {
  const all = types(schema);
  const nullable = all.includes('null');
  const main = all.filter((t) => t !== 'null');
  let label = main.join(' or ') || (schema.enum ? 'string' : schema.properties ? 'object' : 'any');
  if (main.includes('array')) {
    const item = schema.items ? deref(schema.items).schema : {};
    label = `array of ${typeLabel(item).replace(/ or null$/, '')}`;
  }
  return nullable ? `${label} or null` : label;
}

const count = (n) => Number(n).toLocaleString('en-US');

/** How much of a reply value the extension uses ("x-uses"): more is allowed and is cut. */
function uses(schema) {
  const u = schema['x-uses'];
  if (!u) return '';
  if (u.chars !== undefined) return `first ${count(u.chars)} chars are used`;
  if (u.items !== undefined) return `first ${count(u.items)} items are used`;
  return '';
}

function limits(schema) {
  const all = types(schema);
  const out = [];
  if (schema.const !== undefined) out.push(`always ${code(JSON.stringify(schema.const))}`);
  if (schema.format) out.push({ 'date-time': 'date and time (ISO 8601)', date: 'date (YYYY-MM-DD)', uuid: 'UUID' }[schema.format] ?? schema.format);
  if (all.includes('string')) {
    // A text with a fixed set of values, or one that must follow a pattern, cannot be empty: "at most" says it better than "0 to".
    const shaped = schema.pattern !== undefined || schema['x-values'] !== undefined;
    if (schema.minLength !== undefined && schema.minLength === schema.maxLength) out.push(`exactly ${count(schema.minLength)} char${schema.minLength === 1 ? '' : 's'}`);
    else if (schema.minLength !== undefined && schema.maxLength !== undefined) out.push(`${count(schema.minLength)} to ${count(schema.maxLength)} chars`);
    else if (schema.minLength !== undefined) out.push(`at least ${count(schema.minLength)} char${schema.minLength === 1 ? '' : 's'}`);
    else if (schema.maxLength !== undefined) out.push(shaped ? `at most ${count(schema.maxLength)} chars` : `0 to ${count(schema.maxLength)} chars`);
  }
  if (all.includes('array')) {
    if (schema.minItems !== undefined && schema.minItems === schema.maxItems) out.push(`exactly ${count(schema.minItems)} item${schema.minItems === 1 ? '' : 's'}`);
    else if (schema.minItems !== undefined && schema.maxItems !== undefined) out.push(`${count(schema.minItems)} to ${count(schema.maxItems)} items`);
    else if (schema.minItems !== undefined) out.push(`at least ${count(schema.minItems)} item${schema.minItems === 1 ? '' : 's'}`);
    else if (schema.maxItems !== undefined) out.push(`0 to ${count(schema.maxItems)} items`);
    // Limits of the items, when they are plain values.
    const item = schema.items ? deref(schema.items).schema : null;
    if (item && !item.properties) {
      const inner = limits(item);
      if (inner) out.push(`each: ${inner}`);
    }
  }
  if (all.includes('integer') || all.includes('number')) {
    // An id can be text or a number: say which limit belongs to which.
    const label = all.includes('string') ? 'as a number: ' : '';
    if (label && out.length > 0) out[out.length - 1] = `as text: ${out[out.length - 1]}`;
    if (schema.minimum !== undefined && schema.maximum !== undefined) out.push(`${label}${count(schema.minimum)} to ${count(schema.maximum)}`);
    else if (schema.minimum !== undefined) out.push(`${label}${count(schema.minimum)} or more`);
    else if (schema.maximum !== undefined) out.push(`${label}${count(schema.maximum)} or less`);
  }
  if (schema.pattern === '^https?://') out.push('starts with http:// or https://');
  else if (schema.pattern === '^https://') out.push('starts with https://');
  else if (schema.pattern === '^(https?://|mailto:)') out.push('starts with http://, https:// or mailto:');
  else if (schema.pattern !== undefined) out.push(`matches ${code(schema.pattern)}`);
  const used = uses(schema);
  if (used) out.push(used);
  return out.join('; ');
}

function describe(schema) {
  const parts = [];
  if (schema.description) parts.push(String(schema.description).trim().replace(/\s*\n\s*/g, ' '));
  const item = types(schema).includes('array') && schema.items ? deref(schema.items).schema : null;
  // A closed list ("enum") and a list that a later version may extend ("x-values") are worded differently.
  const closed = (schema.enum ?? item?.enum)?.filter((v) => v !== null);
  if (closed && closed.length > 0) parts.push(`One of: ${closed.map(code).join(', ')}.`);
  const open = schema['x-values'] ?? item?.['x-values'];
  if (open && open.length > 0) parts.push(`Values in this version: ${open.map(code).join(', ')}.`);
  const examples = schema['x-examples'] ?? item?.['x-examples'];
  if (examples) parts.push(`For example: ${examples.map(code).join(', ')}.`);
  return parts.join(' ');
}

/** Flattens a schema into table rows: one per field, nested fields as "a.b" and "a[].b". */
function rows(schemaNode, prefix = '', requiredHere = true, out = []) {
  const { schema, shared } = deref(schemaNode);
  const all = types(schema);
  if (prefix) {
    // The rules written once on a shared type (Id, HttpUrl, Fold) are not repeated in every row: the row links to them.
    const itemShared = all.includes('array') && schema.items ? deref(schema.items).name : null;
    const pointer = shared ?? (itemShared && SHARED_TYPES.includes(itemShared) ? itemShared : null);
    out.push({ path: prefix, type: typeLabel(schema), required: requiredHere, limits: limits(schema), description: [describe(schema), pointer ? sharedLink(pointer) : ''].filter(Boolean).join(' ') });
  }
  if (all.includes('object') || schema.properties) {
    const required = new Set(schema.required ?? []);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      rows(child, prefix ? `${prefix}.${name}` : name, required.has(name), out);
    }
  } else if (all.includes('array') && schema.items) {
    const item = deref(schema.items).schema;
    if (types(item).includes('object') || item.properties) {
      const required = new Set(item.required ?? []);
      for (const [name, child] of Object.entries(item.properties ?? {})) rows(child, `${prefix}[].${name}`, required.has(name), out);
    }
  }
  return out;
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(list, { request }) {
  if (list.length === 0) return '_No fields._\n';
  const head = `| Field | Type | ${request ? 'Always sent' : 'Required'} | Limits | Meaning |\n| --- | --- | --- | --- | --- |`;
  const body = list.map((r) => `| ${code(r.path)} | ${cell(r.type)} | ${r.required ? 'yes' : 'no'} | ${cell(r.limits)} | ${cell(r.description)} |`);
  return `${head}\n${body.join('\n')}\n`;
}

/** Shortens long arrays and strings so an example stays readable. Returns notes on what was cut. */
function shorten(value, notes, path = '') {
  if (Array.isArray(value)) {
    // Lists of plain values are short and are shown whole; lists of objects are cut to two.
    const plain = value.every((item) => item === null || typeof item !== 'object');
    const keep = plain ? Math.min(value.length, 12) : value.length > 3 ? 2 : value.length;
    if (keep < value.length) notes.push(`${code(path || 'array')}: ${keep} of ${value.length} items shown`);
    return value.slice(0, keep).map((item, i) => shorten(item, notes, `${path}[${i}]`.replace(/\[\d+\]$/, '[]')));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shorten(child, notes, path ? `${path}.${key}` : key)]));
  }
  if (typeof value === 'string' && value.length > 320) {
    notes.push(`${code(path)}: first 300 of ${value.length.toLocaleString('en-US')} characters shown`);
    return `${value.slice(0, 300)}…`;
  }
  return value;
}

function exampleBlock(file, title) {
  const full = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
  const notes = [];
  const shown = shorten(full, notes);
  // A list inside a list is cut once per parent ("rows[].contacts: 2 of 6", "…: 2 of 4"): say it once.
  const byPath = new Map();
  for (const note of notes) {
    const path = note.slice(0, note.indexOf(': '));
    byPath.set(path, byPath.has(path) && byPath.get(path) !== note ? `${path}: ${note.match(/: (first )?(\d+)/)[2]} ${note.includes('characters') ? 'characters' : 'items'} of each shown` : note);
  }
  const cut = notes.length > 0 ? `\n\nShortened here (${[...byPath.values()].join('; ')}). Complete file: ${code(`examples/${file}`)}.` : `\n\nFile: ${code(`examples/${file}`)}.`;
  return `**${title}**\n\n\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\`${cut}\n`;
}

const exampleFiles = existsSync(examplesDir) ? readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort() : [];
/** The example files of one operation: the typical one first, then its variants by name. */
const examplesFor = (operationId, kind) => {
  const typical = `${operationId}.${kind}.json`;
  return exampleFiles
    .filter((f) => f === typical || (f.startsWith(`${operationId}.`) && f.endsWith(`.${kind}.json`)))
    .sort((a, b) => Number(b === typical) - Number(a === typical) || a.localeCompare(b));
};
const variantOf = (file, operationId, kind) => file.slice(operationId.length + 1, -(kind.length + 6)).replace(/-/g, ' ');

const responses = contract.components.responses;
const responseName = (node) => (typeof node.$ref === 'string' ? node.$ref.split('/').at(-1) : null);
const flat = (text) => String(text ?? '').trim().replace(/\s*\n\s*/g, ' ');

const sections = [];
const toc = [];
let number = 0;
for (const [path, methods] of Object.entries(contract.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    number++;
    const lines = [];
    const title = `${number}. ${method.toUpperCase()} ${path}`;
    toc.push(`| ${number} | ${code(`${method.toUpperCase()} ${path}`)} | ${cell(flat(op.summary))} | ${op['x-capability'] ? code(op['x-capability']) : 'always on'} |`);
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(flat(op.summary));
    lines.push('');
    const errors = Object.entries(op.responses).filter(([status]) => !status.startsWith('2'));
    const facts = [
      ['Capability', op['x-capability'] ? code(op['x-capability']) : 'none: always available'],
      ['Called when', flat(op['x-called-when'])],
      ['Success', Object.keys(op.responses).filter((status) => status.startsWith('2')).sort((a, b) => Number(b) - Number(a)).map(code).join(' or ')],
      ['Errors', `${errors.map(([status, node]) => `${code(status.replace('XX', 'xx'))}${responseName(node) === 'NotFound' ? ' (business not found, or endpoint not available)' : responseName(node) === 'Unavailable' ? ' (endpoint not available)' : ''}`).join(', ')}. See [Errors](#errors).`],
      ['Operation id', code(op.operationId)],
    ].filter(([, value]) => value);
    lines.push('| | |', '| --- | --- |', ...facts.map(([k, v]) => `| ${k} | ${cell(v)} |`));
    lines.push('');
    if (op.description) lines.push(String(op.description).trim(), '');

    const params = (op.parameters ?? []).map((p) => deref(p).schema);
    for (const [where, heading] of [['path', 'Path parameters'], ['header', 'Request headers (besides the common ones)']]) {
      const list = params.filter((p) => p.in === where);
      if (list.length === 0) continue;
      lines.push(`### ${heading}`, '');
      lines.push('| Name | Type | Always sent | Limits | Meaning |', '| --- | --- | --- | --- | --- |');
      for (const p of list) lines.push(`| ${code(p.name)} | ${typeLabel(p.schema ?? {})} | ${where === 'path' || p.name === 'Idempotency-Key' ? 'yes' : 'no'} | ${cell(limits(p.schema ?? {}))} | ${cell(flat(p.description))} |`);
      lines.push('');
    }

    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      const top = deref(body).schema;
      lines.push('### Request body', '');
      if (top.description) lines.push(flat(top.description), '');
      lines.push(table(rows(body), { request: true }));
      for (const file of examplesFor(op.operationId, 'request')) {
        const variant = variantOf(file, op.operationId, 'request');
        lines.push(exampleBlock(file, variant ? `Example request: ${variant}` : 'Example request'));
      }
    }

    const successes = Object.entries(op.responses).filter(([status]) => status.startsWith('2')).sort((a, b) => Number(b[0]) - Number(a[0]));
    const success = successes[0];
    if (success) {
      const response = deref(success[1]).schema;
      const schema = response.content?.['application/json']?.schema;
      lines.push(`### Response ${successes.map(([status]) => status).join(' or ')}`, '');
      if (response.description) lines.push(flat(response.description), '');
      if (schema) {
        const top = deref(schema).schema;
        if (top.description) lines.push(flat(top.description), '');
        lines.push(table(rows(schema), { request: false }));
      }
      for (const file of examplesFor(op.operationId, 'response')) {
        const variant = variantOf(file, op.operationId, 'response');
        lines.push(exampleBlock(file, variant ? `Example response: ${variant}` : 'Example response'));
      }
    }
    sections.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd());
  }
}

// One table for the error replies, which are the same for every endpoint.
const statusOf = { Unauthorised: '401', Forbidden: '403', NotFound: '404', Unavailable: '404, 405, 501', BadRequest: '400', TooLarge: '413', Invalid: '422, other 4xx', RateLimited: '429', ServerError: '5xx except 501' };
const errorRows = Object.entries(statusOf).map(([name, status]) => `| ${code(status)} | ${cell(flat(responses[name].description))} | ${cell(flat(responses[name]['x-extension-reaction']))} |`);
const errorSchema = contract.components.schemas.Error;
const errorExamples = exampleFiles.filter((f) => f.startsWith('error.'));
const errorSection = [
  '## Errors',
  '',
  'The same for every endpoint. The third column describes a save unless it says otherwise; each endpoint above says what happens when it fails. A 4xx status that is not listed is treated like a 422.',
  '',
  '| Status | Meaning | What the extension does |',
  '| --- | --- | --- |',
  ...errorRows,
  '',
  '### Error body',
  '',
  flat(errorSchema.description),
  '',
  table(rows(errorSchema), { request: false }),
  ...errorExamples.map((file) => exampleBlock(file, `Example: ${file.replace(/^error\./, '').replace(/\.json$/, '').replace(/-/g, ' ')}`)),
].join('\n');

// The types that many fields share, each described once.
const sharedSection = [
  '## Shared types',
  '',
  'Rules that are the same wherever one of these values appears. The field tables above link here.',
  '',
  ...SHARED_TYPES.filter((name) => sharedUsed.has(name) || name === 'Capability').flatMap((name) => {
    const schema = contract.components.schemas[name];
    return [`### ${name}`, '', `${typeLabel(schema)}${limits(schema) ? ` (${limits(schema)})` : ''}. ${describe(schema)}`, ''];
  }),
].join('\n');

const output = `${[
  '# Endpoint reference',
  '',
  '<!-- Generated by scripts/build-api-reference.mjs from openapi.yaml and examples/. Do not edit by hand: change the contract, then run "npm run api:reference". -->',
  '',
  `Generated from ${code('openapi.yaml')}, version ${contract.info.version}. Read [README.md](README.md) first: it has the rules that apply to every endpoint.`,
  '',
  'How to read the tables:',
  '',
  `- ${code('a.b')} is field ${code('b')} of object ${code('a')}. ${code('a[].b')} is field ${code('b')} of every item of list ${code('a')}.`,
  '- Request tables describe what the extension sends. "Always sent: yes" means the key is in every request, possibly with the value null, "" or [] where its row allows that.',
  '- Response tables describe what you return. "Required: no" means the key may be left out or be null. "First N chars are used" is not a limit for you: longer text is fine, the extension cuts it.',
  '- "One of" is a closed list. "Values in this version" is a list that a later extension version may extend: store the value as text and accept one you do not know.',
  '- Sentences such as "null exactly when…" or "always the number of…" describe what the extension sends. You can rely on them; do not reject a request because of them.',
  '- "See Id", "See HttpUrl" and "See Fold" lead to [Shared types](#shared-types): rules that hold wherever such a value appears.',
  '- Lengths are in UTF-16 code units, the "length" of a JavaScript string. One unit is at most 3 bytes of UTF-8.',
  '- The examples are real: requests were built by the extension\'s own code from its test pages, responses come from the mock server. Long lists are shortened here; the files in `examples/` are complete.',
  '',
  '| # | Endpoint | What it does | Capability |',
  '| --- | --- | --- | --- |',
  ...toc,
  '',
  sections.join('\n\n'),
  '',
  sharedSection,
  '',
  errorSection,
].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

/**
 * openapi.examples.json: the contract as JSON with the example files built in, for tools that show or send
 * example requests (Postman, Insomnia, Swagger UI). The hand-written openapi.yaml stays free of generated text.
 */
function bundle() {
  const doc = structuredClone(contract);
  const load = (file) => JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
  const named = (files, operationId, kind) =>
    Object.fromEntries(files.map((file) => [variantOf(file, operationId, kind).replace(/ /g, '-') || 'typical', { summary: variantOf(file, operationId, kind) || 'typical', value: load(file) }]));
  for (const methods of Object.values(doc.paths)) {
    for (const op of Object.values(methods)) {
      const requests = examplesFor(op.operationId, 'request');
      const media = op.requestBody?.content?.['application/json'];
      if (media && requests.length > 0) media.examples = named(requests, op.operationId, 'request');
      const replies = examplesFor(op.operationId, 'response');
      const status = Object.keys(op.responses).filter((code) => code.startsWith('2')).sort((a, b) => Number(b) - Number(a))[0];
      if (status && replies.length > 0) {
        // A reply that is shared between endpoints is copied into this one, so that it can carry this endpoint's examples.
        const response = structuredClone(deref(op.responses[status]).schema);
        response.content['application/json'].examples = named(replies, op.operationId, 'response');
        op.responses[status] = response;
      }
    }
  }
  const errors = { Unauthorised: 'error.401-bad-token.json', NotFound: 'error.404-business-not-found.json', Unavailable: 'error.404-feature-not-available.json', Invalid: 'error.422-invalid-body.json' };
  for (const [name, file] of Object.entries(errors)) {
    if (exampleFiles.includes(file)) doc.components.responses[name].content['application/json'].example = load(file);
  }
  doc.info.description = `Generated from openapi.yaml and examples/ by scripts/build-api-reference.mjs. Do not edit: change openapi.yaml.\n\n${doc.info.description}`;
  return `${JSON.stringify(doc, null, 1)}\n`;
}
const bundled = bundle();

if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== output || !existsSync(bundleTarget) || readFileSync(bundleTarget, 'utf8') !== bundled) {
    console.error('docs/legiit-api/reference.md or openapi.examples.json is out of date. Run: npm run api:reference');
    process.exit(1);
  }
  console.log('docs/legiit-api/reference.md and openapi.examples.json are up to date');
} else {
  writeFileSync(bundleTarget, bundled);
  writeFileSync(target, output);
  console.log(`wrote docs/legiit-api/reference.md (${number} endpoints, ${exampleFiles.length} example files, ${(output.length / 1024).toFixed(1)} KB)`);
}
