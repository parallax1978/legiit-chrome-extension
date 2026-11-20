import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'wxt';
import {
  DEFAULT_LEGIIT_API_BASE_URL,
  MINIMUM_CHROME_VERSION,
  PRODUCT_NAME,
  SINGLE_PURPOSE,
  SUGGESTED_SHORTCUT,
  WAYBACK_ORIGIN,
} from './src/config/constants.ts';

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };

/** The Legiit API host is the only configurable required host. */
const legiitBaseUrl = (process.env.LEGIIT_API_BASE_URL ?? DEFAULT_LEGIIT_API_BASE_URL).replace(/\/+$/, '');
const legiitOrigin = new URL(legiitBaseUrl).origin;

/**
 * Content Security Policy for extension pages.
 *
 * - 'wasm-unsafe-eval' is required to compile the bundled ONNX runtime
 *   (WebAssembly) that New or Noise uses for on-device sentence embeddings.
 *   It does not allow eval() or remote code.
 * - No remote scripts, styles, images, fonts or frames can load: everything
 *   but connect-src is limited to the package itself.
 * - Inline *styles* (never scripts) are allowed. The panel parses fetched HTML
 *   with DOMParser to read it; those inert documents contain style attributes,
 *   and without this Chrome logs a CSP error for each one. Nothing from a
 *   fetched page is ever inserted into an extension page.
 * - connect-src allows http(s) because fetching pages the user chose to scan
 *   is a core feature; which hosts may actually be contacted is enforced by
 *   src/net/guarded-fetch.ts and Chrome's host permissions.
 */
function extensionPagesCsp(dev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${dev ? ' http://localhost:3000' : ''}`,
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' https: http:${dev ? ' ws://localhost:3000' : ''}`,
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  return `${directives.join('; ')};`;
}

/**
 * ONNX Runtime's loader mentions every WebAssembly flavour it can use
 * (`new URL("ort-wasm-simd-threaded.jsep.wasm", import.meta.url)` and friends)
 * inside a dead `if (false)` branch. Vite would still copy all four binaries
 * (about 86 MB) into the package. Lens ships exactly one binary, placed at
 * /ort/ by the build:publicAssets hook below and selected explicitly through
 * `wasmPaths`, so these unused references are blanked out before bundling.
 */
function ortSingleWasm(): Plugin {
  return {
    name: 'lens:ort-single-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('onnxruntime-web') || !code.includes('ort-wasm-simd-threaded')) return null;
      return {
        code: code.replace(/new URL\("ort-wasm-simd-threaded[^"]*\.wasm",\s*import\.meta\.url\)\.href/g, '""'),
        map: null,
      };
    },
  };
}

export default defineConfig({
  srcDir: 'src',
  // Explicit imports only: easier to read and review than auto-imports.
  imports: false,
  modules: ['@wxt-dev/module-react'],
  // Developers load .output/chrome-mv3-dev themselves; do not auto-launch a browser.
  webExt: { disabled: true },

  manifest: ({ mode }) => {
    const dev = mode === 'development';
    return {
      name: PRODUCT_NAME,
      short_name: PRODUCT_NAME,
      description: SINGLE_PURPOSE,
      version: pkg.version,
      minimum_chrome_version: MINIMUM_CHROME_VERSION,
      action: {
        default_title: `Analyze this page with ${PRODUCT_NAME}`,
      },
      permissions: ['activeTab', 'scripting', 'storage', 'sidePanel', 'contextMenus'],
      // Required hosts: the Wayback Machine (Rewind) and the Legiit API (only used when connected).
      host_permissions: [`${WAYBACK_ORIGIN}/*`, `${legiitOrigin}/*`],
      // Never granted at install. Requested per site, at the moment of use, from a user gesture.
      // One pattern for both schemes: Chrome only lets an extension request a pattern that fits inside a
      // single optional pattern, and sites are requested as "*://*.example.com/*" (see src/net/permissions.ts).
      optional_host_permissions: ['*://*/*'],
      commands: {
        _execute_action: {
          suggested_key: { default: SUGGESTED_SHORTCUT },
          description: 'Analyze the current page',
        },
        ...(dev
          ? {
              'dev-save-fixture': {
                suggested_key: { default: 'Alt+Shift+F' },
                description: 'DEV ONLY: save the current page as a test fixture',
              },
            }
          : {}),
      },
      content_security_policy: {
        extension_pages: extensionPagesCsp(dev),
      },
    };
  },

  vite: () => ({
    plugins: [ortSingleWasm()],
    worker: {
      format: 'es',
      plugins: () => [ortSingleWasm()],
    },
    define: {
      __LEGIIT_API_BASE_URL__: JSON.stringify(legiitBaseUrl),
    },
    resolve: {
      alias: {
        // transformers.js imports the WebGPU flavour of ONNX Runtime. Lens only
        // runs the CPU (WebAssembly) backend, so point it at the smaller,
        // unminified WASM-only build that ships in the same npm package.
        'onnxruntime-web/webgpu': resolve('node_modules/onnxruntime-web/dist/ort.wasm.mjs'),
      },
    },
    build: {
      // Readable, standard output for store review: no minification, no source maps needed.
      minify: false,
      sourcemap: false,
      // Chrome preloads modules natively. Vite's polyfill would add a second fetch() call site to every page.
      modulePreload: { polyfill: false },
    },
  }),

  hooks: {
    // Ship the ONNX Runtime WebAssembly binary and its loader from node_modules
    // (pinned by package-lock.json) so nothing is fetched from a CDN at run time.
    'build:publicAssets': (_wxt, files) => {
      for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
        files.push({
          absoluteSrc: resolve('node_modules/onnxruntime-web/dist', name),
          relativeDest: `ort/${name}`,
        });
      }
    },
  },
});
