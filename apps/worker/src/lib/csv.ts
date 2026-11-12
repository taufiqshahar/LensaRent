/**
 * CSV for spreadsheet export. Every field is quoted, and fields that a spreadsheet would
 * run as a formula are defused with a leading apostrophe (CSV injection).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Rows to CSV text with CRLF line endings and a UTF-8 BOM so Excel reads Malay text right. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}
