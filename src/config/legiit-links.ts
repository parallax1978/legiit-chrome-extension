/**
 * Pages of the Legiit marketplace that the Overview points to when a next step is work a freelancer can do.
 *
 * They are plain links that the user clicks. Nothing about the user, their site or their search is added to them,
 * and the extension requests none of them. Each address was checked on 28 November 2026; change them here.
 */
export interface LegiitLink {
  label: string;
  url: string;
}

export const LEGIIT_SERVICES = {
  guestPosts: { label: 'Find outreach and guest post services on Legiit', url: 'https://legiit.com/categories/seo/guest-posts' },
  backlinks: { label: 'Find link building services on Legiit', url: 'https://legiit.com/categories/seo/backlinks' },
  localSeo: { label: 'Find local SEO services on Legiit', url: 'https://legiit.com/categories/seo/local-seo' },
  writing: { label: 'Find writers on Legiit', url: 'https://legiit.com/categories/writing' },
  seo: { label: 'Find SEO services on Legiit', url: 'https://legiit.com/categories/seo' },
} as const satisfies Record<string, LegiitLink>;
