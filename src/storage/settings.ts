/**
 * User settings live in chrome.storage.local, readable only by extension
 * pages and the service worker (see restrictStorageToTrustedContexts).
 * Stored values are validated on every read so a corrupt or outdated record
 * degrades to defaults instead of breaking the UI.
 */
import * as v from 'valibot';
import type { BrandEntry, TrackedBrands } from '@/brands/matcher';
import { isSafeImageDataUrl } from '@/lib/sanitize';

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

const BrandEntrySchema = v.object({
  id: text(64),
  name: text(160),
  domains: v.optional(v.pipe(v.array(text(255)), v.maxLength(30)), []),
  aliases: v.optional(v.pipe(v.array(text(160)), v.maxLength(30)), []),
  /** "legiit" entries were pre-filled from Command Center Business Details. */
  source: v.optional(v.picklist(['manual', 'legiit']), 'manual'),
});

export const SettingsSchema = v.object({
  version: v.optional(v.literal(1), 1),
  myBrands: v.optional(v.pipe(v.array(BrandEntrySchema), v.maxLength(50)), []),
  competitors: v.optional(v.pipe(v.array(BrandEntrySchema), v.maxLength(200)), []),
  agency: v.optional(
    v.object({
      name: v.optional(text(160), ''),
      logoDataUrl: v.optional(v.nullable(v.pipe(v.string(), v.check((value: string) => isSafeImageDataUrl(value)))), null),
    }),
    { name: '', logoDataUrl: null },
  ),
  strip: v.optional(
    v.object({
      enabled: v.optional(v.boolean(), true),
      collapsed: v.optional(v.boolean(), false),
    }),
    { enabled: true, collapsed: false },
  ),
  snapshots: v.optional(
    v.object({
      /**
       * panel  = save while the side panel is showing that results page (default)
       * always = save every Google results page you open
       * manual = only when you click Save
       */
      autoSave: v.optional(v.picklist(['panel', 'always', 'manual']), 'panel'),
    }),
    { autoSave: 'panel' as const },
  ),
  ai: v.optional(
    v.object({
      /** Opt-in to Chrome's built-in Prompt API (downloads an on-device model). */
      chromePromptOptIn: v.optional(v.boolean(), false),
    }),
    { chromePromptOptIn: false },
  ),
  legiit: v.optional(
    v.object({
      /** The Command Center business that tracked brands were pre-filled from and that saves go to. */
      businessId: v.optional(v.nullable(text(120)), null),
      businessName: v.optional(v.nullable(text(200)), null),
      focusKeywords: v.optional(v.pipe(v.array(text(200)), v.maxLength(200)), []),
      avatars: v.optional(v.pipe(v.array(v.object({ name: text(160), description: text(2000) })), v.maxLength(20)), []),
    }),
    { businessId: null, businessName: null, focusKeywords: [], avatars: [] },
  ),
  onboardingSeen: v.optional(v.boolean(), false),
});

export type Settings = v.InferOutput<typeof SettingsSchema>;
export type StoredBrand = Settings['myBrands'][number];

export const DEFAULT_SETTINGS: Settings = v.parse(SettingsSchema, {});

const SETTINGS_KEY = 'settings';
const AUTH_KEY = 'legiitAuth';
const USAGE_KEY = 'usage';
const SELECTOR_OVERRIDES_KEY = 'selectorOverrides';

export function parseSettings(raw: unknown): Settings {
  const result = v.safeParse(SettingsSchema, raw ?? {});
  return result.success ? result.output : DEFAULT_SETTINGS;
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const valid = v.parse(SettingsSchema, settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: valid });
  return valid;
}

/** Read-modify-write. The updater receives a copy it may mutate or replace. */
export async function updateSettings(updater: (draft: Settings) => Settings | void): Promise<Settings> {
  const current = await getSettings();
  const draft = structuredClone(current);
  const next = updater(draft) ?? draft;
  return saveSettings(next);
}

export function onSettingsChanged(listener: (settings: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[SETTINGS_KEY]) listener(parseSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export function trackedBrands(settings: Settings): TrackedBrands {
  const strip = (b: StoredBrand): BrandEntry => ({ id: b.id, name: b.name, domains: b.domains, aliases: b.aliases });
  return { mine: settings.myBrands.map(strip), competitors: settings.competitors.map(strip) };
}

/* ---------- Legiit auth token (kept apart from general settings) ---------- */

export async function getLegiitToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  const value = stored[AUTH_KEY] as { token?: unknown } | undefined;
  return typeof value?.token === 'string' && value.token.length > 0 ? value.token : null;
}

export async function setLegiitToken(token: string | null): Promise<void> {
  if (token === null) await chrome.storage.local.remove(AUTH_KEY);
  else await chrome.storage.local.set({ [AUTH_KEY]: { token: token.trim().slice(0, 4096), savedAt: Date.now() } });
}

export function onLegiitTokenChanged(listener: () => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[AUTH_KEY]) listener();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/* ---------- Free-run counter for optional account gating ---------- */

export async function getRunCount(): Promise<number> {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  const value = stored[USAGE_KEY] as { runs?: unknown } | undefined;
  return typeof value?.runs === 'number' && Number.isFinite(value.runs) ? value.runs : 0;
}

export async function incrementRunCount(): Promise<number> {
  const runs = (await getRunCount()) + 1;
  await chrome.storage.local.set({ [USAGE_KEY]: { runs } });
  return runs;
}

/* ---------- Selector pack overrides (data only, validated by the selector loader) ---------- */

export async function getSelectorOverrides(): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get(SELECTOR_OVERRIDES_KEY);
  const value = stored[SELECTOR_OVERRIDES_KEY];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function setSelectorOverride(site: string, pack: unknown | null): Promise<void> {
  const overrides = await getSelectorOverrides();
  if (pack === null) delete overrides[site];
  else overrides[site] = pack;
  await chrome.storage.local.set({ [SELECTOR_OVERRIDES_KEY]: overrides });
}

/**
 * Content scripts must not read extension storage (it holds the Legiit token
 * and the tracked-brand list). Called once from the service worker.
 */
export async function restrictStorageToTrustedContexts(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome: the default already excludes web pages; content scripts ask the service worker.
  }
}

export async function clearAllSettings(): Promise<void> {
  await chrome.storage.local.clear();
}
