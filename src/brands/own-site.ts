/** The user's own site, as the tools need it when the tab holds no page of theirs. */
import { safeHttpUrl } from '@/lib/sanitize';

/**
 * The home page of the user's own site: the first domain of their brands. '' when they track none.
 * Used as a starting value where a tool needs a page address and the tab cannot give one (a results page).
 */
export function ownHomeUrl(brands: readonly { domains: readonly string[] }[]): string {
  const domain = brands.flatMap((brand) => brand.domains).find((d) => d.trim() !== '');
  return domain ? (safeHttpUrl(`https://${domain.trim()}/`) ?? '') : '';
}
