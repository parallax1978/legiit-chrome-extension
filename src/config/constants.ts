/**
 * Build-time and run-time constants shared by the extension code and by
 * wxt.config.ts. This file must stay free of browser and bundler APIs so the
 * build config can import it.
 */

/** Working product name. Change it here and nowhere else. */
export const PRODUCT_NAME = 'Legiit Lens';

export const PUBLISHER = 'Legiit';

/** Chrome Web Store single-purpose statement. Used verbatim in the listing. */
export const SINGLE_PURPOSE =
  'Shows how visible a web page or brand is in Google results and AI answers, and what explains it.';

/**
 * Legiit Command Center API. ASSUMPTION: the real host is not known yet.
 * Override at build time with the LEGIIT_API_BASE_URL environment variable
 * (the manifest host permission follows automatically).
 */
export const DEFAULT_LEGIIT_API_BASE_URL = 'https://api.legiit.com';

export const WAYBACK_ORIGIN = 'https://web.archive.org';

/**
 * Account gating. `false` (the default) never asks for an account.
 * Set to a number N to ask users to connect a Legiit account after N free
 * feature runs.
 */
export const REQUIRE_ACCOUNT_AFTER_FREE_RUNS = false as number | false;

/** Oldest Chrome the extension supports (sidePanel.open needs 116). */
export const MINIMUM_CHROME_VERSION = '116';

/** Keyboard shortcut suggested for "analyze this page". Users can rebind it. */
export const SUGGESTED_SHORTCUT = 'Alt+Shift+L';
