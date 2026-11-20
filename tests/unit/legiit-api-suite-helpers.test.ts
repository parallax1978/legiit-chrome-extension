// @vitest-environment node
/**
 * The small parts of the conformance check that decide whether a server
 * passes: the id that "no business has", the keys in another spelling, and
 * the words for a reply that breaks the contract. And the line ends of the
 * kit's files, which the generators compare byte for byte.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractValidators, describeError, example, loadContract, misspeltKeys, NO_SUCH_BUSINESS, unknownIdLike } from '../api/suite';

const ROOT = resolve(__dirname, '../..');

describe('unknownIdLike: an id that no business has, in the form of a real id', () => {
  /** Every character has the kind of the character at its place in the real id. */
  const sameShape = (id: string, like: string): boolean =>
    id.length === like.length && [...id].every((char, index) => (/\d/.test(like[index]!) ? /\d/.test(char) : /[a-z]/.test(like[index]!) ? /[a-z]/.test(char) : /[A-Z]/.test(like[index]!) ? /[A-Z]/.test(char) : char === like[index]));

  it('keeps the form of every scheme of ids', () => {
    const cases: [string, RegExp][] = [
      // The ids of the mock, and prefixed ids: the part up to the last "_" stays.
      ['biz_brightpath', /^biz_[a-z]{10}$/],
      ['biz_1NqXyzAbC2dEf', /^biz_\d[A-Z][a-z][A-Z][a-z]{2}[A-Z][a-z][A-Z]\d[a-z][A-Z][a-z]$/],
      // A UUID stays a UUID: the last group changes, in hexadecimal digits of the same letter case.
      ['0b6e4d6c-58f4-4a5e-9d6f-3c2a1b7e9f10', /^0b6e4d6c-58f4-4a5e-9d6f-[0-9a-f]{12}$/],
      ['0B6E4D6C-58F4-4A5E-9D6F-3C2A1B7E9F10', /^0B6E4D6C-58F4-4A5E-9D6F-[0-9A-F]{12}$/],
      // A ULID stays a ULID: no I, L, O or U. The first third (the time) stays.
      ['01J3DF75DDA33214231DCF72E2', /^01J3DF75[0-9A-HJKMNP-TV-Z]{18}$/],
      // An ObjectId of MongoDB stays 24 hexadecimal digits.
      ['507f1f77bcf86cd799439011', /^507f1f77[0-9a-f]{16}$/],
      // A number stays a number with as many digits, and does not start with 0.
      ['7', /^[1-9]$/],
      ['101', /^[1-9]\d\d$/],
      ['1234567890123456789', /^123456\d{13}$/],
      // A short id of mixed characters keeps the kind of each character.
      ['jR5k2Wp', /^[a-z][A-Z]\d[a-z]\d[A-Z][a-z]$/],
    ];
    for (const [id, form] of cases) {
      const unknown = unknownIdLike(id);
      expect(unknown, id).toMatch(form);
      expect(unknown, id).not.toBe(id);
      expect(sameShape(unknown, id), `${id} -> ${unknown}`).toBe(true);
      // The same id on every run, so that a failure can be repeated.
      expect(unknownIdLike(id)).toBe(unknown);
    }
  });

  it('is never an id of the account', () => {
    // Nine businesses with the ids 1 to 9: no other number with one digit is left, so the id gets a second digit.
    const taken = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(unknownIdLike('7', taken)).toMatch(/^[1-9]\d$/);
    // Whatever the check would choose first is taken: it chooses another one.
    const first = unknownIdLike('biz_brightpath');
    const second = unknownIdLike('biz_brightpath', new Set([first]));
    expect(second).toMatch(/^biz_[a-z]{10}$/);
    expect(second).not.toBe(first);
    for (let i = 0; i < 200; i += 1) expect(taken.has(unknownIdLike(String((i % 9) + 1), taken))).toBe(false);
  });

  it('falls back to a text when there is no id to go by', () => {
    expect(unknownIdLike(null)).toBe(NO_SUCH_BUSINESS);
    expect(unknownIdLike('')).toBe(NO_SUCH_BUSINESS);
    expect(unknownIdLike('東京')).toBe(NO_SUCH_BUSINESS);
  });
});

describe('misspeltKeys: a contract key in another spelling', () => {
  const contract = loadContract();
  const details = example<Record<string, unknown>>('getBusinessDetails.response.json');
  const pulse = example<Record<string, unknown>>('getIndustryPulse.response.json');

  it('reports a key whose correct spelling is missing', () => {
    const { brandNames, ...rest } = details;
    expect(misspeltKeys(contract, 'BusinessDetails', { ...rest, brand_names: brandNames })).toEqual(['"brand_names" is not read: the extension expects "brandNames"']);
    expect(misspeltKeys(contract, 'BusinessDetails', { ...rest, BrandNames: brandNames })).toEqual(['"BrandNames" is not read: the extension expects "brandNames"']);
    expect(misspeltKeys(contract, 'IndustryPulse', { updated_at: '2026-11-18 09:00:00', events: [] })).toEqual(['"updated_at" is not read: the extension expects "updatedAt"']);
  });

  it('accepts the same key next to the correct one: that is an extra field, and extra fields are allowed', () => {
    expect(misspeltKeys(contract, 'IndustryPulse', { ...pulse, updated_at: '2026-11-18 09:00:00' })).toEqual([]);
    expect(misspeltKeys(contract, 'BusinessDetails', { ...details, brand_names: details['brandNames'], created_at: 'x', focus_keywords: [] })).toEqual([]);
    expect(misspeltKeys(contract, 'BusinessDetails', details)).toEqual([]);
  });

  it('looks into lists', () => {
    const competitors = [{ name: 'Lakeside Smiles', Domains: ['lakesidesmiles.example'] }];
    expect(misspeltKeys(contract, 'BusinessDetails', { ...details, competitors })).toEqual(['"competitors[0].Domains" is not read: the extension expects "domains"']);
  });
});

describe('describeError: what is wrong with a reply, in words', () => {
  const validators = contractValidators();
  const problems = (schema: string, body: unknown): string[] => {
    const validate = validators(schema);
    return validate(body) ? [] : (validate.errors ?? []).map(describeError);
  };

  it('names the place and what the contract asks for', () => {
    expect(problems('SaveResult', {})).toEqual(['(body) has no key "id", which is required']);
    expect(problems('SaveResult', { id: 'x', url: '/command-center/x' })).toEqual(['/url must be an absolute URL that starts with http:// or https://']);
    expect(problems('Session', { user: { id: 1 }, capabilities: 'ai' })).toEqual(['/capabilities must be array']);
    expect(problems('Error', { error: { code: 'invalid', message: '' } })).toEqual(['/error/message must not be empty']);
    expect(problems('IndustryPulse', { events: [{ date: '2026-02-30', title: 'An update' }] })).toEqual(['/events/0/date must be a calendar day written as YYYY-MM-DD']);
    expect(problems('BusinessDetails', { id: 'b', name: 'B', competitors: { 0: { name: 'C' } } })).toEqual(['/competitors must be array or null']);
    expect(problems('SaveResult', { id: ' ' })).toEqual(['/id must have at least one character that is not white space']);
    expect(problems('SaveResult', { id: 'x'.repeat(121) })).toEqual(['/id must have at most 120 characters']);
    expect(problems('SaveResult', { id: -1 })).toEqual(['/id must be at least 0']);
    expect(problems('Competitor', { name: 'N', domains: Array.from({ length: 31 }, (_, i) => `d${i}.example`) })).toEqual(['/domains must have at most 30 items']);
    expect(problems('GapList', { source: 'S', subject: '', capturedAt: '2026-11-20T12:00:00.000Z', rows: [] })).toEqual(['/rows must have at least 1 item']);
    expect(problems('Fold', 'middle')).toEqual(['(body) must be one of: above, partly, below, null']);
  });

  it('says what a date and time needs: a time zone', () => {
    const snapshot = example<Record<string, unknown>>('saveVisibilitySnapshot.request.json');
    expect(problems('VisibilitySnapshot', { ...snapshot, capturedAt: '2026-11-18T09:00:00' })).toEqual(['/capturedAt must be a date and time with a time zone, for example 2026-11-18T09:00:00Z (RFC 3339)']);
    expect(problems('VisibilitySnapshot', snapshot)).toEqual([]);
  });
});

describe('line ends of the files of the kit', () => {
  it('.gitattributes makes Git write LF on every system, so that the byte-for-byte checks of the kit hold on Windows too', (test) => {
    const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (git('rev-parse', '--is-inside-work-tree').stdout?.trim() !== 'true') test.skip('not a Git checkout');
    const files = ['docs/legiit-api/reference.md', 'docs/legiit-api/openapi.examples.json', 'docs/legiit-api/openapi.yaml', 'docs/legiit-api/examples/getSession.response.json', 'fixtures/legiit/session.json'];
    const attributes = git('check-attr', 'text', 'eol', '--', ...files).stdout;
    for (const file of files) {
      expect(attributes).toContain(`${file}: text: auto\n`);
      expect(attributes).toContain(`${file}: eol: lf\n`);
    }
    // The files in the working tree have LF line ends now, too.
    for (const file of files) expect(readFileSync(resolve(ROOT, file), 'utf8'), file).not.toContain('\r\n');
  });
});
