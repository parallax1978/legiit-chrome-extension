import { toCsv, type CsvCell } from '@/lib/csv';
import { CLASS_LABELS, type NoiseReport } from './classify';

/** One row per sentence of the page, then one row per point the page is missing. */
export function noiseCsv(report: NoiseReport, keyword: string, pageUrl: string | null): string {
  const headers = ['keyword', 'page', 'kind', 'class', 'pages_saying_this', 'pages_compared', 'best_similarity', 'words', 'text', 'closest_match_url'];
  const rows: CsvCell[][] = report.sentences.map((s) => [
    keyword,
    pageUrl ?? '',
    'sentence on page',
    CLASS_LABELS[s.cls],
    s.pages,
    report.pagesCompared,
    Number(s.bestScore.toFixed(3)),
    s.words,
    s.text,
    s.closest?.url ?? '',
  ]);
  for (const m of report.missing) {
    rows.push([keyword, pageUrl ?? '', 'missing from page', 'Covered by most competitors', m.pages, report.pagesCompared, null, null, m.text, m.urls[0] ?? '']);
  }
  return toCsv(headers, rows);
}
