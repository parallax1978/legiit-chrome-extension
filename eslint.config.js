import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint rules double as policy enforcement for the Chrome Web Store hard rules:
 *  - no eval / new Function / string timers (no remote or dynamic code)
 *  - no innerHTML-style sinks (all page content is untrusted)
 *  - no direct fetch/XHR/WebSocket (every request goes through src/net/guarded-fetch.ts)
 */
const htmlSinks = [
  {
    selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]",
    message: 'Never assign innerHTML/outerHTML. Build DOM with createElement and textContent.',
  },
  {
    selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln|setHTMLUnsafe)$/]",
    message: 'HTML string sinks are forbidden. Build DOM with createElement and textContent.',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is forbidden.',
  },
  {
    selector: "NewExpression[callee.name=/^(XMLHttpRequest|WebSocket|EventSource)$/]",
    message: 'Use guardedFetch from src/net/guarded-fetch.ts for all network access.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'dist/**',
      'node_modules/**',
      'public/**',
      'fixtures/**',
      'store/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...htmlSinks],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use guardedFetch from src/net/guarded-fetch.ts.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'fetch', message: 'Use guardedFetch.' },
        { object: 'globalThis', property: 'fetch', message: 'Use guardedFetch.' },
        { object: 'self', property: 'fetch', message: 'Use guardedFetch.' },
      ],
    },
  },
  {
    // The only modules allowed to touch the network primitive directly.
    files: ['src/net/guarded-fetch.ts', 'src/similarity/embed.worker.ts', 'src/content/same-origin-fetch.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-restricted-properties': 'off' },
  },
  {
    files: ['scripts/**', 'mock-server/**', 'e2e/**', 'tests/**', '*.config.{js,ts}'],
    rules: { 'no-console': 'off' },
  },
);
