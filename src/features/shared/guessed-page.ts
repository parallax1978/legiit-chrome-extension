/**
 * Pages whose address is a guess.
 *
 * Google can hide where a result leads. The line under its title then still spells an address
 * ("https://www.example.com › blog › post"), but Google shortens and rewrites that line, so the address can be
 * wrong. The extension never asks Google where the result leads. It requests the guessed address on the result's
 * own site, as it would request any page the user granted, and reads the answer only when the page that comes back
 * calls itself what the result is called.
 */
import { failedDigest, type PageDigest } from '@/extract/digest';
import { titlesAgree } from '@/lib/text';

export const WRONG_PAGE = 'Google hides the address of this result, and the address under its title leads to another page';
export const NO_PAGE = 'Google hides the address of this result, and the address under its title did not answer';

/**
 * The digest of a page that was loaded from a guessed address, checked against the title of the result it was
 * guessed for. The same digest when the titles agree; a failed digest that says why when they do not, or when the
 * address did not answer. `expectTitle` undefined: the address was no guess, and the digest is returned as it is.
 */
export function checkGuessed(digest: PageDigest, expectTitle: string | undefined): PageDigest {
  if (expectTitle === undefined) return digest;
  if (!digest.ok) {
    // A missing permission is the user's to grant: it is not a wrong guess.
    return digest.needsPermission ? digest : { ...digest, error: `${NO_PAGE} (${digest.error ?? 'no answer'})` };
  }
  const titles = digest.titles && digest.titles.length > 0 ? digest.titles : [digest.title];
  if (titlesAgree(expectTitle, titles)) return digest;
  return failedDigest(digest.url, digest.title ? `${WRONG_PAGE} (“${digest.title.slice(0, 80)}”)` : WRONG_PAGE, digest.status, false, digest.fetchedAt);
}
