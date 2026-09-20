import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type { Source } from './types.js';
export const MAX_ROWS = 5000;
function source(name: string, grid: unknown[][], lines?: number[]): Source {
  if (grid.length < 2) throw new Error(`${name}: include a header and at least one data row.`);
  const headers = grid[0].map((v) => String(v ?? '').trim());
  if (
    headers.length > 60 ||
    headers.some((h) => !h || h.length > 120) ||
    new Set(headers.map((h) => h.toLowerCase())).size !== headers.length
  )
    throw new Error(`${name}: use 1–60 unique, nonempty column headers (maximum 120 characters).`);
  const rows = grid
    .slice(1)
    .map((cells, i) => {
      if (
        cells.length > headers.length &&
        cells.slice(headers.length).some((v) => String(v ?? '').trim())
      )
        throw new Error(`${name}: row ${i + 2} has more cells than headers.`);
      const values = Object.fromEntries(headers.map((h, j) => [h, String(cells[j] ?? '')]));
      if (Object.values(values).some((v) => v.length > 2000))
        throw new Error(`${name}: a cell exceeds 2,000 characters.`);
      return { line: lines?.[i + 1] ?? i + 2, values };
    })
    .filter((r) => Object.values(r.values).some((v) => v.trim()));
  if (!rows.length || rows.length > MAX_ROWS)
    throw new Error(`${name}: use 1–${MAX_ROWS} populated rows.`);
  return { id: randomUUID(), name, headers, rows };
}
export async function parseFile(name: string, buffer: Buffer): Promise<Source[]> {
  if (/\.csv$/i.test(name)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const parsed = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      max_record_size: 125000,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
    // Parser line counters include skipped blank lines. Embedded field newlines
    // move the record's end line; subtract them to retain its starting line.
    const lines = parsed.map(
      (r) =>
        r.info.lines -
        r.record.reduce((sum, cell) => sum + (cell.match(/\r\n|\n|\r/g)?.length || 0), 0),
    );
    return [
      source(
        name,
        parsed.map((r) => r.record),
        lines,
      ),
    ];
  }
  if (!/\.xlsx$/i.test(name))
    throw new Error(`${name}: only UTF-8 CSV and .xlsx files are supported.`);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
  if (book.worksheets.length > 10) throw new Error('Use at most 10 worksheets per workbook.');
  return book.worksheets
    .filter((s) => s.rowCount > 0)
    .map((sheet) => {
      if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > 60)
        throw new Error(`${name}: worksheet is too large.`);
      const grid: unknown[][] = [];
      for (let rowNum = 1; rowNum <= sheet.rowCount; rowNum++) {
        const row = sheet.getRow(rowNum);
        const cells: unknown[] = [];
        for (let col = 1; col <= sheet.columnCount; col++) {
          const cell = row.getCell(col);
          if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error)
            throw new Error(
              `${name}: ${sheet.name}!${cell.address} contains a formula or error; export plain values first.`,
            );
          cells.push(
            cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text,
          );
        }
        grid.push(cells);
      }
      return source(`${name} · ${sheet.name}`, grid);
    });
}
