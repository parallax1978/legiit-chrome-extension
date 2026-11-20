/** CSV export (RFC 4180) with spreadsheet formula-injection protection. */

export type CsvCell = string | number | boolean | null | undefined;

/**
 * Page-derived text can start with "=", "+", "-" or "@", which spreadsheets
 * execute as a formula. Such cells are prefixed with an apostrophe.
 */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = neutraliseFormula(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  // A byte-order mark makes Excel read the file as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Saves text as a file from an extension page. Needs no "downloads" permission. */
export function downloadText(filename: string, mimeType: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
