/**
 * Injected on demand (chrome.scripting.executeScript) into a page the user
 * invoked Legiit Lens on, or a site the user granted. It is never registered
 * as a content script and never runs on its own.
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { installAgent } from '@/content/agent';
import { saveFixture } from '@/dev/save-fixture';

export default defineUnlistedScript(() => {
  installAgent({ kind: 'page', ...(import.meta.env.DEV ? { devSaveFixture: saveFixture } : {}) });
});
