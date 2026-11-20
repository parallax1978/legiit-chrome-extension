/**
 * The API contract (docs/legiit-api/openapi.yaml) as something the mock can
 * check requests against. A body the contract does not allow is refused with
 * 422, exactly as a server built from the contract would refuse it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

export const CONTRACT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'legiit-api', 'openapi.yaml');

/** The largest request body the extension ever sends, in bytes (src/legiit/limits.ts). */
export const MAX_REQUEST_BYTES = 1_048_576;

let cached = null;

function load() {
  if (cached) return cached;
  const contract = parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const ajv = new (Ajv2020.default ?? Ajv2020)({ allErrors: false, strict: false, validateSchema: false });
  (addFormats.default ?? addFormats)(ajv);
  ajv.addSchema({ ...contract, $id: 'https://legiit.invalid/contract' });
  cached = { contract, ajv };
  return cached;
}

export function loadContract() {
  return load().contract;
}

/** "rows[0].url" from an Ajv instance path such as "/rows/0/url". */
function fieldPath(instancePath, extra = '') {
  const parts = instancePath.split('/').filter(Boolean);
  if (extra) parts.push(extra);
  return parts.map((part, index) => (/^\d+$/.test(part) ? `[${part}]` : `${index === 0 ? '' : '.'}${part}`)).join('');
}

/**
 * Checks a request body against a schema of the contract.
 * @returns {string | null} null when the body is allowed, otherwise one sentence that names the first problem.
 */
export function problemWith(schemaName, body) {
  const validate = load().ajv.getSchema(`https://legiit.invalid/contract#/components/schemas/${schemaName}`);
  if (!validate) throw new Error(`The contract has no schema called ${schemaName}`);
  if (validate(body)) return null;
  const error = validate.errors?.[0];
  if (!error) return 'The body is not valid';
  if (error.keyword === 'required') return `${fieldPath(error.instancePath, error.params.missingProperty)} is required`;
  const field = fieldPath(error.instancePath) || 'The body';
  if (error.keyword === 'minLength' && error.params.limit === 1) return `${field} is required`;
  if (error.keyword === 'maxLength') return `${field} is longer than ${error.params.limit} characters`;
  if (error.keyword === 'maxItems') return `${field} has more than ${error.params.limit} items`;
  if (error.keyword === 'minItems') return `${field} needs at least ${error.params.limit} item${error.params.limit === 1 ? '' : 's'}`;
  if (error.keyword === 'enum') return `${field} must be one of: ${error.params.allowedValues.map((v) => (v === null ? 'null' : v)).join(', ')}`;
  if (error.keyword === 'pattern') return `${field} is not in the expected form`;
  return `${field} ${error.message ?? 'is not valid'}`;
}
