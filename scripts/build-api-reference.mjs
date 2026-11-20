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

const contract = parse(readFileSync(contractPath, 'utf8'));

/** Follows local "$ref" pointers ("#/components/schemas/Name"). */
function deref(node) {
  let current = node;
  let name = null;
  let guard = 0;
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    const parts = current.$ref.replace(/^#\//, '').split('/');
    name = parts.at(-1);
    current = parts.reduce((value, part) => (value ? value[part] : undefined), contract);
    if (++guard > 20) throw new Error(`Circular $ref at ${node.$ref}`);
  }
  if (!current) throw new Error(`Unresolved $ref: ${JSON.stringify(node)}`);
  return { schema: current, name };
}

const types = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);
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

function limits(schema) {
  const out = [];
  if (schema.const !== undefined) out.push(`always ${code(JSON.stringify(schema.const))}`);
  if (schema.format) out.push(schema.format);
  if (schema.minLength !== undefined) out.push(`min ${schema.minLength} chars`);
  if (schema.maxLength !== undefined) out.push(`max ${schema.maxLength.toLocaleString('en-US')} chars`);
  if (schema.minItems !== undefined) out.push(`min ${schema.minItems} items`);
  if (schema.maxItems !== undefined) out.push(`max ${schema.maxItems.toLocaleString('en-US')} items`);
  if (schema.minimum !== undefined && schema.maximum !== undefined) out.push(`${schema.minimum} to ${schema.maximum}`);
  else if (schema.minimum !== undefined) out.push(`≥ ${schema.minimum}`);
  else if (schema.maximum !== undefined) out.push(`≤ ${schema.maximum}`);
  return out.join(', ');
}

function describe(schema) {
  const parts = [];
  if (schema.description) parts.push(String(schema.description).trim().replace(/\s*\n\s*/g, ' '));
  const values = schema.enum ? schema.enum.filter((v) => v !== null) : null;
  if (values && values.length > 0) parts.push(`One of: ${values.map(code).join(', ')}.`);
  if (schema['x-examples']) parts.push(`For example: ${schema['x-examples'].map(code).join(', ')}.`);
  return parts.join(' ');
}

/** Flattens a schema into table rows: one per field, nested fields as "a.b" and "a[].b". */
function rows(schemaNode, prefix = '', requiredHere = true, out = []) {
  const { schema } = deref(schemaNode);
  const all = types(schema);
  if (prefix) {
    out.push({ path: prefix, type: typeLabel(schema), required: requiredHere, limits: limits(schema), description: describe(schema) });
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

function table(list, { withRequired }) {
  if (list.length === 0) return '_No fields._\n';
  const head = withRequired ? '| Field | Type | Required | Limits | Meaning |\n| --- | --- | --- | --- | --- |' : '| Field | Type | Always present | Limits | Meaning |\n| --- | --- | --- | --- | --- |';
  const body = list.map((r) => `| ${code(r.path)} | ${cell(r.type)} | ${r.required ? 'yes' : 'no'} | ${cell(r.limits)} | ${cell(r.description)} |`);
  return `${head}\n${body.join('\n')}\n`;
}

/** Shortens long arrays and strings so an example stays readable. Returns notes on what was cut. */
function shorten(value, notes, path = '') {
  if (Array.isArray(value)) {
    const keep = value.length > 3 ? 2 : value.length;
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
  const cut = notes.length > 0 ? `\n\nShortened here (${[...new Set(notes)].join('; ')}). Complete file: ${code(`examples/${file}`)}.` : `\n\nFile: ${code(`examples/${file}`)}.`;
  return `**${title}**\n\n\`\`\`json\n${JSON.stringify(shown, null, 2)}\n\`\`\`${cut}\n`;
}

const exampleFiles = existsSync(examplesDir) ? readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort() : [];
const examplesFor = (operationId, kind) => exampleFiles.filter((f) => f === `${operationId}.${kind}.json` || (f.startsWith(`${operationId}.`) && f.endsWith(`.${kind}.json`)));
const variantOf = (file, operationId, kind) => file.slice(operationId.length + 1, -(kind.length + 6)).replace(/-/g, ' ');

const sections = [];
let number = 0;
for (const [path, methods] of Object.entries(contract.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    number++;
    const lines = [];
    lines.push(`## ${number}. ${method.toUpperCase()} ${path}`);
    lines.push('');
    lines.push(String(op.summary ?? '').trim());
    lines.push('');
    const facts = [
      ['Client method', code(op.operationId)],
      ['Capability', op['x-capability'] ? code(op['x-capability']) : 'none (always available)'],
      ['Called when', op['x-called-when'] ? String(op['x-called-when']).trim().replace(/\s*\n\s*/g, ' ') : ''],
      ['Success', Object.keys(op.responses).filter((s) => s.startsWith('2')).map(code).join(' or ')],
    ].filter(([, value]) => value);
    lines.push('| | |', '| --- | --- |', ...facts.map(([k, v]) => `| ${k} | ${cell(v)} |`));
    lines.push('');
    if (op.description) lines.push(String(op.description).trim(), '');

    const params = (op.parameters ?? []).map((p) => deref(p).schema);
    if (params.length > 0) {
      lines.push('### Path parameters', '');
      lines.push('| Name | Type | Limits | Meaning |', '| --- | --- | --- | --- |');
      for (const p of params) lines.push(`| ${code(p.name)} | ${typeLabel(p.schema ?? {})} | ${cell(limits(p.schema ?? {}))} | ${cell(p.description ?? '')} |`);
      lines.push('');
    }

    const body = op.requestBody?.content?.['application/json']?.schema;
    if (body) {
      lines.push('### Request body', '');
      lines.push(table(rows(body), { withRequired: true }));
      for (const file of examplesFor(op.operationId, 'request')) {
        const variant = variantOf(file, op.operationId, 'request');
        lines.push(exampleBlock(file, variant ? `Example request (${variant})` : 'Example request'));
      }
    }

    const success = Object.entries(op.responses).find(([status]) => status.startsWith('2'));
    if (success) {
      const response = deref(success[1]).schema;
      const schema = response.content?.['application/json']?.schema;
      lines.push(`### Response ${success[0]}`, '');
      if (schema) lines.push(table(rows(schema), { withRequired: false }));
      for (const file of examplesFor(op.operationId, 'response')) {
        const variant = variantOf(file, op.operationId, 'response');
        lines.push(exampleBlock(file, variant ? `Example response (${variant})` : 'Example response'));
      }
    }

    const errors = Object.entries(op.responses).filter(([status]) => !status.startsWith('2'));
    if (errors.length > 0) {
      lines.push('### Errors', '');
      lines.push('| Status | When | What the extension does |', '| --- | --- | --- |');
      for (const [status, node] of errors) {
        const response = deref(node).schema;
        lines.push(`| ${code(status)} | ${cell(response.description ?? '')} | ${cell(response['x-extension-reaction'] ?? '')} |`);
      }
      lines.push('');
    }
    sections.push(lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd());
  }
}

const errorExamples = exampleFiles.filter((f) => f.startsWith('error.'));
const output = `${[
  '# Endpoint reference',
  '',
  '<!-- Generated by scripts/build-api-reference.mjs from openapi.yaml and examples/. Do not edit by hand: change the contract, then run "npm run api:reference". -->',
  '',
  `Generated from ${code('openapi.yaml')} (version ${contract.info.version}). Field tables come from the contract; the examples are real requests built by the extension's own code from its test fixtures, and real responses of the mock server.`,
  '',
  'Read [README.md](README.md) first: it has the rules that apply to every endpoint.',
  '',
  sections.join('\n\n'),
  ...(errorExamples.length > 0 ? ['', '## Error bodies', '', ...errorExamples.map((file) => exampleBlock(file, `Example: ${file.replace(/^error\./, '').replace(/\.json$/, '').replace(/-/g, ' ')}`))] : []),
].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== output) {
    console.error('docs/legiit-api/reference.md is out of date. Run: npm run api:reference');
    process.exit(1);
  }
  console.log('docs/legiit-api/reference.md is up to date');
} else {
  writeFileSync(target, output);
  console.log(`wrote docs/legiit-api/reference.md (${number} endpoints, ${exampleFiles.length} example files, ${(output.length / 1024).toFixed(1)} KB)`);
}
