import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getLegiitToken,
  getRunCount,
  getSelectorOverrides,
  getSettings,
  incrementRunCount,
  onSettingsChanged,
  parseSettings,
  restrictStorageToTrustedContexts,
  setLegiitToken,
  setSelectorOverride,
  trackedBrands,
  updateSettings,
} from '@/storage/settings';
import { chromeMock } from '../helpers/fixtures';

describe('settings', () => {
  it('starts from safe defaults', async () => {
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.strip.enabled).toBe(true);
    expect(settings.snapshots.autoSave).toBe('panel');
    expect(settings.ai.chromePromptOptIn).toBe(false);
    expect(settings.myBrands).toEqual([]);
  });

  it('fills in missing fields from older or partial records', () => {
    const parsed = parseSettings({ myBrands: [{ id: 'a', name: 'Acme' }], strip: { collapsed: true } });
    expect(parsed.myBrands[0]).toEqual({ id: 'a', name: 'Acme', domains: [], aliases: [], source: 'manual' });
    expect(parsed.strip).toEqual({ enabled: true, collapsed: true });
    expect(parsed.agency).toEqual({ name: '', logoDataUrl: null });
  });

  it('falls back to defaults when the stored record is corrupt', () => {
    expect(parseSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ myBrands: 'nope' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ agency: { name: 'A', logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } })).toEqual(DEFAULT_SETTINGS);
  });

  it('updates with read-modify-write and notifies listeners', async () => {
    const listener = vi.fn();
    const stop = onSettingsChanged(listener);
    await updateSettings((draft) => {
      draft.myBrands.push({ id: 'me', name: 'BrightPath Dental', domains: ['brightpathdental.example'], aliases: [], source: 'manual' });
      draft.agency.name = 'North Star SEO';
    });
    const saved = await getSettings();
    expect(saved.myBrands).toHaveLength(1);
    expect(saved.agency.name).toBe('North Star SEO');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].agency.name).toBe('North Star SEO');
    stop();
    await updateSettings((draft) => {
      draft.agency.name = 'Other';
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid updates instead of storing them', async () => {
    await expect(
      updateSettings((draft) => {
        draft.agency.logoDataUrl = 'javascript:alert(1)';
      }),
    ).rejects.toThrow();
    expect((await getSettings()).agency.logoDataUrl).toBeNull();
  });

  it('converts stored brands to matcher input', () => {
    const settings = parseSettings({
      myBrands: [{ id: 'm', name: 'Mine', domains: ['mine.example'], aliases: ['M'], source: 'legiit' }],
      competitors: [{ id: 'c', name: 'Rival' }],
    });
    expect(trackedBrands(settings)).toEqual({
      mine: [{ id: 'm', name: 'Mine', domains: ['mine.example'], aliases: ['M'] }],
      competitors: [{ id: 'c', name: 'Rival', domains: [], aliases: [] }],
    });
  });

  it('keeps the Legiit token apart from general settings', async () => {
    expect(await getLegiitToken()).toBeNull();
    await setLegiitToken('  secret-token  ');
    expect(await getLegiitToken()).toBe('secret-token');
    expect(JSON.stringify(await getSettings())).not.toContain('secret-token');
    await setLegiitToken(null);
    expect(await getLegiitToken()).toBeNull();
  });

  it('counts feature runs', async () => {
    expect(await getRunCount()).toBe(0);
    await incrementRunCount();
    expect(await incrementRunCount()).toBe(2);
    expect(await getRunCount()).toBe(2);
  });

  it('stores and removes selector overrides per site', async () => {
    expect(await getSelectorOverrides()).toEqual({});
    await setSelectorOverride('google', { site: 'google', version: '2099.01.01-1', slots: {} });
    expect(Object.keys(await getSelectorOverrides())).toEqual(['google']);
    await setSelectorOverride('google', null);
    expect(await getSelectorOverrides()).toEqual({});
  });

  it('restricts extension storage to trusted contexts', async () => {
    await restrictStorageToTrustedContexts();
    expect(chrome.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(chromeMock().store.size).toBe(0);
  });
});
