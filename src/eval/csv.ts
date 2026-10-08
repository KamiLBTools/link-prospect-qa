/**
 * CSV escaping, not JSON escaping.
 *
 * The first version of the eval used `JSON.stringify` on the reason field,
 * which produces backslash-escaped quotes — valid JSON and invalid CSV, so
 * every reason containing a quoted keyword corrupted the row it was in. Shared
 * rather than duplicated because the same mistake is available to every writer.
 */
export function csvRow(cells: (string | number | boolean | null)[]): string {
  return cells
    .map((cell) => {
      const text = cell === null ? "" : String(cell);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(",");
}
