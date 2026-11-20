#!/usr/bin/env node
/**
 * Writes the generated files of the handoff kit in docs/legiit-api, from the
 * OpenAPI contract (openapi.yaml) and the example files (examples/):
 *
 *   reference.md            a readable endpoint reference
 *   openapi.examples.json   the contract as JSON with the examples built in
 *   schemas/                every request body as a standalone JSON Schema file
 *
 * The contract is the single source for field names, types, limits and
 * descriptions, so none of these files can drift from it. The examples are
 * built and checked by tests/unit/legiit-api-kit.test.ts.
 *
 *   node scripts/build-api-reference.mjs           write the files
 *   node scripts/build-api-reference.mjs --check   fail if one of them is out of date
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const kit = join(root, 'docs', 'legiit-api');
const contractPath = join(kit, 'openapi.yaml');
const examplesDir = join(kit, 'examples');
const schemasDir = join(kit, 'schemas');

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

/** "a, b and c". */
const listOf = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
/**
 * The id GitHub gives a heading: lower case, punctuation removed, each space a hyphen.
 * "4. POST /v1/workspaces/from-brief" becomes "4-post-v1workspacesfrom-brief".
 */
const slug = (heading) => String(heading).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
const linkTo = (heading, text = heading) => `[${text}](#${slug(heading)})`;
/** Shared types that some field points to, in the order they were first used. */
const sharedUsed = new Set();
const sharedLink = (name) => {
  sharedUsed.add(name);
  return `See ${linkTo(name)}.`;
};

const types = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);
/** The schemas that are one plain value (an id, a URL…), used by many fields. */
const SHARED_TYPES = Object.entries(contract.components.schemas)
  .filter(([, schema]) => !types(schema).includes('object') && !schema.properties)
  .map(([name]) => name);
const code = (value) => `\`${String(value)}\``;
const flat = (text) => String(text ?? '').trim().replace(/\s*\n\s*/g, ' ');
/** The paragraphs of a description, each on one line. */
const paragraphs = (text) => String(text ?? '').trim().split(/\n\s*\n/).map(flat).filter(Boolean);

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

/** Everything about a value that a server can check: the "Limits" column. */
function limits(schema) {
  const all = types(schema);
  const out = [];
  if (schema.const !== undefined) out.push(`must be ${code(JSON.stringify(schema.const))}`);
  // A closed list ("enum"). null is not listed: the type says "or null".
  const closed = schema.enum?.filter((v) => v !== null);
  if (closed && closed.length > 0) out.push(`one of: ${closed.map(code).join(', ')}`);
  // Only requests have a date and time, and the extension writes every one with Date.toISOString() (the kit test checks the examples).
  if (schema.format) out.push({ 'date-time': 'date and time (ISO 8601, UTC with milliseconds)', date: 'date (YYYY-MM-DD)', uuid: 'UUID' }[schema.format] ?? schema.format);
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
  // "\\S" is the rule for an id (not only white space): the shared type says it in words, the limits stay short.
  else if (schema.pattern !== undefined && schema.pattern !== '\\S') out.push(`matches ${code(schema.pattern)}`);
  const used = uses(schema);
  if (used) out.push(used);
  return out.join('; ');
}

/** The "Meaning" column: the description, an open list of values, examples. A closed list is a limit and is not repeated here. */
function describe(schema) {
  const parts = [];
  if (schema.description) parts.push(flat(schema.description));
  const item = types(schema).includes('array') && schema.items ? deref(schema.items).schema : null;
  // A list that a later version may extend ("x-values"): not a limit, so it is said in words.
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

const loadExample = (file) => JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
/** The size of a body as the extension sends it: JSON without white space, in bytes of UTF-8. */
const sentBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function exampleBlock(file, title) {
  const full = loadExample(file);
  const notes = [];
  const shown = shorten(full, notes);
  // A list inside a list is cut once per parent ("rows[].contacts: 2 of 6", "…: 2 of 4"): say it once.
  const byPath = new Map();
  for (const note of notes) {
    const path = note.slice(0, note.indexOf(': '));
    byPath.set(path, byPath.has(path) && byPath.get(path) !== note ? `${path}: ${note.match(/: (first )?(\d+)/)[2]} ${note.includes('characters') ? 'characters' : 'items'} of each shown` : note);
  }
  const where = notes.length > 0 ? `Shortened here (${[...byPath.values()].join('; ')}). Complete file: ${code(`examples/${file}`)}.` : `File: ${code(`examples/${file}`)}.`;
  // A request has a size that matters to the server: the limit for a body is 1 MB.
  const size = file.endsWith('.request.json') ? ` As sent, without white space: ${count(sentBytes(full))} bytes.` : '';
  return `**${title}**\n\n\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\`\n\n${where}${size}\n`;
}

const exampleFiles = existsSync(examplesDir) ? readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort() : [];
/**
 * The example files of one operation: the typical one first, then its variants by name.
 * "prefix" is an operation id, or "anySave" for a reply that every save can give.
 */
const examplesFor = (prefix, kind) => {
  const typical = `${prefix}.${kind}.json`;
  return exampleFiles
    .filter((f) => f === typical || (f.startsWith(`${prefix}.`) && f.endsWith(`.${kind}.json`)))
    .sort((a, b) => Number(b === typical) - Number(a === typical) || a.localeCompare(b));
};
const variantOf = (file, prefix, kind) => file.slice(prefix.length + 1, -(kind.length + 6)).replace(/-/g, ' ');
const exampleTitle = (file, prefix, kind) => {
  const variant = variantOf(file, prefix, kind);
  return variant ? `Example ${kind}: ${variant}` : `Example ${kind}`;
};

const responses = contract.components.responses;
const refName = (node) => (node && typeof node.$ref === 'string' ? node.$ref.split('/').at(-1) : null);

/** Every operation of the contract, numbered in the order of the file. */
const operations = Object.entries(contract.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method: method.toUpperCase(), op })));
operations.forEach((entry, index) => {
  entry.number = index + 1;
  entry.title = `${entry.number}. ${entry.method} ${entry.path}`;
  entry.successes = Object.entries(entry.op.responses).filter(([status]) => status.startsWith('2')).sort((a, b) => Number(b[0]) - Number(a[0]));
});

/**
 * What several endpoints share is described once, under "Shared parameters and responses". An endpoint prints
 * the first paragraph of the description and a link. Shared: a parameter, or a success response, of
 * "components" that more than one operation points to.
 */
const SHARED_SECTION = 'Shared parameters and responses';
/** A title for a shared response, the prefix of the example files that belong to it and to no single endpoint, and a note for those examples. */
const SHARED_RESPONSES = { Saved: { title: 'Response to a save', examples: 'anySave', note: 'the same for every save' } };
const usersOf = (kind, name) =>
  operations.filter(({ op, successes }) => (kind === 'parameters' ? (op.parameters ?? []).some((p) => refName(p) === name) : successes.some(([, node]) => refName(node) === name))).map((o) => o.number);
const isShared = (kind, name) => name !== null && usersOf(kind, name).length > 1;
const endpointsText = (numbers) => `${numbers.length === 1 ? 'endpoint' : 'endpoints'} ${listOf(numbers.map(String))}`;
const sharedResponseTitle = (name) => SHARED_RESPONSES[name]?.title ?? `Response ${name}`;
/** Every parameter that the contract lists is sent with every request of its endpoint. "required: false" means: do not require it. */
const ALWAYS_SENT = 'yes';

/** What a status means on this endpoint, where one status has more than one meaning or is used by few endpoints. */
const errorNote = { NotFound: ' (business not found, or endpoint not available)', Unavailable: ' (endpoint not available)', Conflict: ' (a request with the same Idempotency-Key is still running)' };

const sections = [];
const toc = [];
for (const { path, method, op, number, title, successes } of operations) {
  const lines = [];
  toc.push(`| ${number} | ${linkTo(title, code(`${method} ${path}`))} | ${cell(flat(op.summary))} | ${op['x-capability'] ? code(op['x-capability']) : 'always on'} |`);
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(flat(op.summary));
  lines.push('');
  const errors = Object.entries(op.responses).filter(([status]) => !status.startsWith('2'));
  const facts = [
    ['Capability', op['x-capability'] ? code(op['x-capability']) : 'none: always available'],
    ['Called when', flat(op['x-called-when'])],
    ['Success', successes.map(([status]) => code(status)).join(' or ')],
    ['Errors', `${errors.map(([status, node]) => `${code(status.replace('XX', 'xx'))}${errorNote[refName(node)] ?? ''}`).join(', ')}. See ${linkTo('Errors')}.`],
    ['Operation id', code(op.operationId)],
  ].filter(([, value]) => value);
  lines.push('| Item | Value |', '| --- | --- |', ...facts.map(([k, v]) => `| ${k} | ${cell(v)} |`));
  lines.push('');
  if (op.description) lines.push(String(op.description).trim(), '');

  const params = (op.parameters ?? []).map((p) => ({ ...deref(p).schema, component: refName(p) }));
  for (const [where, heading] of [['path', 'Path parameters'], ['header', 'Request headers (besides the common ones)']]) {
    const list = params.filter((p) => p.in === where);
    if (list.length === 0) continue;
    lines.push(`### ${heading}`, '');
    lines.push('| Name | Type | Always sent | Limits | Meaning |', '| --- | --- | --- | --- | --- |');
    for (const p of list) {
      const meaning = isShared('parameters', p.component) ? `${paragraphs(p.description)[0]} See ${linkTo(p.name)}.` : flat(p.description);
      lines.push(`| ${code(p.name)} | ${typeLabel(p.schema ?? {})} | ${ALWAYS_SENT} | ${cell(limits(p.schema ?? {}))} | ${cell(meaning)} |`);
    }
    lines.push('');
  }

  const body = op.requestBody?.content?.['application/json']?.schema;
  if (body) {
    const top = deref(body).schema;
    lines.push('### Request body', '');
    if (top.description) lines.push(flat(top.description), '');
    lines.push(`JSON Schema of this body: [${code(`schemas/${op.operationId}.request.schema.json`)}](schemas/${op.operationId}.request.schema.json).`, '');
    lines.push(table(rows(body), { request: true }));
    for (const file of examplesFor(op.operationId, 'request')) lines.push(exampleBlock(file, exampleTitle(file, op.operationId, 'request')));
  }

  const success = successes[0];
  if (success) {
    const component = refName(success[1]);
    const response = deref(success[1]).schema;
    const schema = response.content?.['application/json']?.schema;
    lines.push(`### Response ${successes.map(([status]) => status).join(' or ')}`, '');
    if (isShared('responses', component)) {
      const fields = schema ? rows(schema).filter((r) => !r.path.includes('.')) : [];
      const fieldList = fields.length > 0 ? ` Fields: ${listOf(fields.map((r) => `${code(r.path)}${r.required ? ' (required)' : ''}`))}.` : '';
      lines.push(`${paragraphs(response.description)[0]}${fieldList} The same for ${endpointsText(usersOf('responses', component))}: see ${linkTo(sharedResponseTitle(component))}.`, '');
    } else {
      if (response.description) lines.push(...paragraphs(response.description).flatMap((p) => [p, '']));
      if (response['x-extension-reaction']) lines.push(`What the extension does: ${flat(response['x-extension-reaction'])}`, '');
      if (schema) {
        const top = deref(schema).schema;
        if (top.description) lines.push(flat(top.description), '');
        lines.push(table(rows(schema), { request: false }));
      }
    }
    for (const file of examplesFor(op.operationId, 'response')) lines.push(exampleBlock(file, exampleTitle(file, op.operationId, 'response')));
  }
  sections.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd());
}

// What several endpoints share: each parameter and each success response, once.
const sharedParts = [];
for (const [name, parameter] of Object.entries(contract.components.parameters ?? {})) {
  if (!isShared('parameters', name)) continue;
  const kind = parameter.in === 'path' ? 'Path parameter' : parameter.in === 'header' ? 'Request header' : `Parameter (${parameter.in})`;
  const limit = limits(parameter.schema ?? {});
  sharedParts.push(
    `### ${parameter.name}`,
    '',
    `${kind} of ${endpointsText(usersOf('parameters', name))}. Type: ${typeLabel(parameter.schema ?? {})}${limit ? ` (${limit})` : ''}. The extension sends it with every request of these endpoints.`,
    '',
    ...paragraphs(parameter.description).flatMap((p) => [p, '']),
  );
}
for (const [name, response] of Object.entries(responses)) {
  if (!isShared('responses', name)) continue;
  const users = operations.filter(({ successes }) => successes.some(([, node]) => refName(node) === name));
  const statuses = [...new Set(users.flatMap(({ successes }) => successes.filter(([, node]) => refName(node) === name).map(([status]) => status)))].sort((a, b) => Number(b) - Number(a));
  const schema = response.content?.['application/json']?.schema;
  const prefix = SHARED_RESPONSES[name]?.examples;
  const files = prefix ? examplesFor(prefix, 'response') : [];
  sharedParts.push(
    `### ${sharedResponseTitle(name)}`,
    '',
    `Status ${statuses.join(' or ')}. The same for ${endpointsText(users.map((o) => o.number))}.`,
    '',
    ...paragraphs(response.description).flatMap((p) => [p, '']),
    ...(response['x-extension-reaction'] ? [`What the extension does: ${flat(response['x-extension-reaction'])}`, ''] : []),
    ...(schema ? [table(rows(schema), { request: false })] : []),
    ...(files.length > 0 ? ['Each of these endpoints can answer like the examples below. Its own examples are in its section.', ''] : []),
    ...files.map((file) => exampleBlock(file, exampleTitle(file, prefix, 'response'))),
  );
}
const sharedPartsSection = [`## ${SHARED_SECTION}`, '', 'What several endpoints share is described once, here. Each endpoint that uses one of these parts links to it.', '', ...sharedParts].join('\n');

// One table for the error replies, which are the same for every endpoint. The rows are in the order of the status codes.
const ERROR_ROWS = [
  ['BadRequest', '`400`'],
  ['Unauthorised', '`401`'],
  ['Forbidden', '`403`'],
  ['NotFound', '`404` with `error.code` `not_found`'],
  ['Unavailable', 'any other `404`, `405`, `501`'],
  ['Conflict', '`409`'],
  ['TooLarge', '`413`'],
  ['Invalid', '`422`, any other `4xx`'],
  ['RateLimited', '`429`'],
  ['ServerError', '`5xx` except `501`'],
];
const errorNames = Object.keys(responses).filter((name) => !operations.some(({ successes }) => successes.some(([, node]) => refName(node) === name)));
const unlisted = errorNames.filter((name) => !ERROR_ROWS.some(([listed]) => listed === name));
if (unlisted.length > 0 || ERROR_ROWS.some(([name]) => !responses[name])) throw new Error(`The error table of the reference (ERROR_ROWS) and components.responses of the contract do not list the same replies: ${unlisted.join(', ')}`);
const errorRows = ERROR_ROWS.map(([name, status]) => `| ${status} | ${cell(flat(responses[name].description))} | ${cell(flat(responses[name]['x-extension-reaction']))} |`);
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
    return [`### ${name}`, '', `Type: ${typeLabel(schema)}${limits(schema) ? ` (${limits(schema)})` : ''}.`, '', describe(schema), ''];
  }),
].join('\n');

const sharedPartNames = [
  ...Object.entries(contract.components.parameters ?? {}).filter(([name]) => isShared('parameters', name)).map(([, p]) => code(p.name)),
  ...Object.keys(responses).filter((name) => isShared('responses', name)).map((name) => `the ${sharedResponseTitle(name).replace(/^R/, 'r')}`),
];

const reference = `${[
  '# Endpoint reference',
  '',
  '<!-- Generated by scripts/build-api-reference.mjs from openapi.yaml and examples/. Do not edit by hand: change the contract, then run "npm run api:examples". -->',
  '',
  `Generated from ${code('openapi.yaml')}, version ${contract.info.version}. Read [README.md](README.md) first: it has the rules that apply to every endpoint, and the list of changes in this version.`,
  '',
  'How to read the tables:',
  '',
  `- ${code('a.b')} is field ${code('b')} of object ${code('a')}. ${code('a[].b')} is field ${code('b')} of every item of list ${code('a')}.`,
  '- Request tables describe what the extension sends. "Always sent: yes" means the key is in every request, possibly with the value null, "" or [] where its row allows that.',
  '- Reply tables describe what you return. A heading such as "Response 200" is the reply with the status 200. "Required: no" means the key may be left out or be null. "First N chars are used" is not a limit for you: longer text is fine, the extension cuts it.',
  '- The "Limits" column of a request table has everything that you can check: lengths, list sizes, number ranges, fixed values ("must be") and closed lists ("one of").',
  '- "Values in this version", in the "Meaning" column, is an open list: a later extension version may add values. Store the value as text and accept one you do not know.',
  '- Sentences such as "null exactly when…" or "always the number of…" describe what the extension sends. You can rely on them; do not reject a request because of them.',
  `- ${listOf(SHARED_TYPES.filter((name) => sharedUsed.has(name)).map((name) => `"See ${name}"`))} lead to ${linkTo('Shared types')}: rules that hold wherever such a value appears.`,
  `- What several endpoints share (${listOf(sharedPartNames)}) is described once, under ${linkTo(SHARED_SECTION)}.`,
  '- Lengths are in UTF-16 code units, the "length" of a JavaScript string. One unit is at most 3 bytes of UTF-8.',
  `- The examples are real. Requests were built by the extension's own code from its test pages. Replies come from the mock server, except a few that show a case the mock server does not have (integer ids, a session without capabilities, ${code('"url": null')}, some errors): those are written by hand, and a test checks them against the contract and against what the extension accepts. Long lists are shortened here; the files in ${code('examples/')} are complete.`,
  `- ${code('schemas/')} has the body of every POST as a standalone JSON Schema file (draft 2020-12), for a JSON Schema validator. Each "Request body" section names its file. The files accept fields that they do not know and, in an open list, values that they do not know. ${code('maxLength')} in JSON Schema counts characters, and the limits here count UTF-16 code units: a text that is within its limit here is never refused by the schema.`,
  '',
  '| # | Endpoint | What it does | Capability |',
  '| --- | --- | --- | --- |',
  ...toc,
  '',
  sections.join('\n\n'),
  '',
  sharedPartsSection,
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
  const named = (files, prefix, kind, note = '') =>
    Object.fromEntries(files.map((file) => [variantOf(file, prefix, kind).replace(/ /g, '-') || 'typical', { summary: `${variantOf(file, prefix, kind) || 'typical'}${note}`, value: loadExample(file) }]));
  // A reply that every save can give: its examples go to the shared response, and from there into every endpoint that uses it.
  for (const [name, { examples: prefix, note }] of Object.entries(SHARED_RESPONSES)) {
    const files = examplesFor(prefix, 'response');
    if (files.length > 0) doc.components.responses[name].content['application/json'].examples = named(files, prefix, 'response', ` (${note})`);
  }
  for (const methods of Object.values(doc.paths)) {
    for (const op of Object.values(methods)) {
      const requests = examplesFor(op.operationId, 'request');
      const media = op.requestBody?.content?.['application/json'];
      if (media && requests.length > 0) media.examples = named(requests, op.operationId, 'request');
      const replies = examplesFor(op.operationId, 'response');
      const status = Object.keys(op.responses).filter((code) => code.startsWith('2')).sort((a, b) => Number(b) - Number(a))[0];
      if (status && replies.length > 0) {
        // A reply that is shared between endpoints is copied into this one, so that it can carry this endpoint's examples.
        const name = refName(op.responses[status]);
        const response = structuredClone(name ? doc.components.responses[name] : op.responses[status]);
        const content = response.content['application/json'];
        content.examples = { ...named(replies, op.operationId, 'response'), ...(content.examples ?? {}) };
        op.responses[status] = response;
      }
    }
  }
  // An error example belongs to the reply with its status. The two kinds of 404 are told apart by the code, as the extension does it.
  const byStatus = { 400: 'BadRequest', 401: 'Unauthorised', 403: 'Forbidden', 405: 'Unavailable', 409: 'Conflict', 413: 'TooLarge', 422: 'Invalid', 429: 'RateLimited', 501: 'Unavailable' };
  for (const file of errorExamples) {
    const [, status, name] = /^error\.(\d{3})-(.+)\.json$/.exec(file) ?? [];
    const value = loadExample(file);
    const target = status === '404' ? (value.error?.code === 'not_found' ? 'NotFound' : 'Unavailable') : byStatus[status];
    if (!target) throw new Error(`The contract has no reply for the status ${status} of the example ${file}. Add the status to byStatus in scripts/build-api-reference.mjs, or give the file another status. The name must be error.<status>-<case>.json.`);
    const content = doc.components.responses[target].content['application/json'];
    content.examples = { ...(content.examples ?? {}), [name]: { summary: name.replace(/-/g, ' '), value } };
  }
  doc.info.description = `Generated from openapi.yaml and examples/ by scripts/build-api-reference.mjs. Do not edit: change openapi.yaml.\n\n${doc.info.description}`;
  return `${JSON.stringify(doc, null, 1)}\n`;
}

/**
 * A request schema of the contract as one standalone JSON Schema (draft 2020-12): every "$ref" is followed, and
 * the kit's own keys are put into standard ones. "x-values" (an open list) becomes a sentence in the description,
 * so that a validator accepts a value added later; "x-examples" becomes "examples". Unknown fields stay allowed.
 */
function standalone(node) {
  const { schema } = deref(node);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, standalone(child)]));
    else if (key === 'items') out.items = standalone(value);
    else if (key === 'description') out.description = flat(value);
    else if (key === 'x-examples') out.examples = value;
    else if (!key.startsWith('x-')) out[key] = value;
  }
  if (schema['x-values']) out.description = `${out.description ?? ''} Values in this version: ${schema['x-values'].join(', ')}. A later version may add values: accept a value that is not in this list.`.trim();
  return out;
}
function schemaFiles() {
  const files = {};
  for (const { path, method, op } of operations) {
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (!body) continue;
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $comment: `Generated from openapi.yaml, version ${contract.info.version}, by scripts/build-api-reference.mjs. Do not edit by hand.`,
      title: `Request body of ${method} ${path}`,
      ...standalone(body),
    };
    const text = `${JSON.stringify(schema, null, 2)}\n`;
    if (/"\$ref"|"x-[a-z-]+":/.test(text)) throw new Error(`The standalone schema of ${op.operationId} still has a $ref or a key of the kit`);
    files[`${op.operationId}.request.schema.json`] = text;
  }
  return files;
}

/** Every generated file: path below docs/legiit-api → content. */
const outputs = { 'reference.md': reference, 'openapi.examples.json': bundle(), ...Object.fromEntries(Object.entries(schemaFiles()).map(([name, text]) => [`schemas/${name}`, text])) };
/** Files in schemas/ that this script would no longer write. */
const strays = (existsSync(schemasDir) ? readdirSync(schemasDir) : []).filter((name) => !(`schemas/${name}` in outputs));

if (process.argv.includes('--check')) {
  // A checkout with Windows line endings is not out of date.
  const read = (file) => (existsSync(join(kit, file)) ? readFileSync(join(kit, file), 'utf8').replace(/\r\n/g, '\n') : null);
  const stale = [...Object.entries(outputs).filter(([file, text]) => read(file) !== text).map(([file]) => file), ...strays.map((name) => `schemas/${name} (not generated any more)`)];
  if (stale.length > 0) {
    console.error(`Out of date in docs/legiit-api: ${stale.join(', ')}. Run: npm run api:reference`);
    process.exit(1);
  }
  console.log(`docs/legiit-api: reference.md, openapi.examples.json and ${Object.keys(outputs).length - 2} files in schemas/ are up to date`);
} else {
  mkdirSync(schemasDir, { recursive: true });
  for (const name of strays) rmSync(join(schemasDir, name));
  for (const [file, text] of Object.entries(outputs)) writeFileSync(join(kit, file), text);
  console.log(`wrote docs/legiit-api/reference.md (${operations.length} endpoints, ${exampleFiles.length} example files, ${(reference.length / 1024).toFixed(1)} KB), openapi.examples.json and ${Object.keys(outputs).length - 2} files in schemas/`);
}
