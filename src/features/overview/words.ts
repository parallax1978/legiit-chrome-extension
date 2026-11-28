/** Plain words for what the tools measure: no pixels, no letter grades. */
import type { GradeLetter } from '@/features/click-potential/metrics';

/** How much room a results page leaves for organic results, in a word. */
export type Crowding = 'open' | 'crowded' | 'very-crowded';

export const CROWDING_LABELS: Readonly<Record<Crowding, string>> = { open: 'Open', crowded: 'Crowded', 'very-crowded': 'Very crowded' };

export const CROWDING_MEANING: Readonly<Record<Crowding, string>> = {
  open: 'The regular results get most of the first screen.',
  crowded: 'Ads and other boxes take a good part of the first screen from the regular results.',
  'very-crowded': 'Ads and other boxes fill the first screen. People scroll before they reach the regular results.',
};

/** The same bands as the score the measurement keeps: 70 and up, 30 to 69, below 30. */
export function crowdingOf(letter: GradeLetter): Crowding {
  return letter === 'A' || letter === 'B' ? 'open' : letter === 'F' ? 'very-crowded' : 'crowded';
}

/**
 * Where something is on the page, counted in screens instead of pixels: "on the first screen",
 * "just below the first screen", "about 3 screens down". '' when it was not measured.
 */
export function howFarDown(top: number | null, viewportHeight: number): string {
  if (top === null || viewportHeight <= 0) return '';
  const screens = top / viewportHeight;
  if (screens < 1) return 'on the first screen';
  if (screens < 1.5) return 'just below the first screen';
  return `about ${Math.round(screens)} screens down`;
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The first `max` of the items as a list, with "and 4 more" for the rest. */
export function someOf(items: readonly string[], max = 3): string {
  const rest = items.length - max;
  return rest > 0 ? `${items.slice(0, max).join(', ')} and ${rest} more` : listOf(items);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 days ago", "yesterday", "today": how long ago something was checked. */
export function daysAgo(then: number, now: number): string {
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}
