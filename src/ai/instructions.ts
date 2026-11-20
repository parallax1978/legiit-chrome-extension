/**
 * The one-sentence instruction each screen gives an AI provider when the user
 * asks for a summary to be rewritten. Kept in one place because they are part
 * of what is sent to the Legiit AI endpoint (the "Task:" line of the prompt)
 * and the API examples in docs/legiit-api/examples are built from them.
 */
import type { AiTask } from './provider';

export const SUMMARY_INSTRUCTIONS: Readonly<Record<Exclude<AiTask, 'brief'>, string>> = {
  'click-potential': 'Explain in plain language how much room organic results get on this Google results page and why.',
  'why-not-me': 'Explain where this brand is missing while competitors are present, and what explains it.',
  rewind: "Summarise how this page's on-page SEO changed over time and which changes most likely mattered.",
  'new-or-noise': 'Explain how much of this page is new compared with competing pages, and what it should add.',
};
