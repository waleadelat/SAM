import * as XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";
import type { SessionUpload, ParsedRow } from "./sessionStore.js";

function detectNumericColumns(rows: ParsedRow[], columns: string[]): string[] {
  return columns.filter((col) => {
    let numericCount = 0;
    let nonNullCount = 0;
    for (const row of rows.slice(0, 100)) {
      const val = row[col];
      if (val !== null && val !== undefined && val !== "") {
        nonNullCount++;
        if (!isNaN(Number(val))) numericCount++;
      }
    }
    return nonNullCount > 0 && numericCount / nonNullCount > 0.8;
  });
}

function coerceRow(raw: Record<string, unknown>, columns: string[]): ParsedRow {
  const row: ParsedRow = {};
  for (const col of columns) {
    const val = raw[col];
    if (val === null || val === undefined || val === "") {
      row[col] = null;
    } else if (typeof val === "number") {
      row[col] = val;
    } else {
      const n = Number(val);
      row[col] = isNaN(n) ? String(val) : n;
    }
  }
  return row;
}

export function parseExcel(buffer: Buffer, fileName: string): SessionUpload {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: null,
    raw: false,
  });

  if (rawRows.length === 0) {
    return { fileName, rowCount: 0, columns: [], numericColumns: [], data: [] };
  }

  const columns = Object.keys(rawRows[0]);
  const data = rawRows.map((r) => coerceRow(r, columns));
  const numericColumns = detectNumericColumns(data, columns);

  return { fileName, rowCount: data.length, columns, numericColumns, data };
}

export function parseCsv(buffer: Buffer, fileName: string): SessionUpload {
  const rawRows = csvParse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    cast: true,
  }) as Array<Record<string, unknown>>;

  if (rawRows.length === 0) {
    return { fileName, rowCount: 0, columns: [], numericColumns: [], data: [] };
  }

  const columns = Object.keys(rawRows[0]);
  const data = rawRows.map((r) => coerceRow(r, columns));
  const numericColumns = detectNumericColumns(data, columns);

  return { fileName, rowCount: data.length, columns, numericColumns, data };
}

export function parseFile(buffer: Buffer, fileName: string): SessionUpload {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseCsv(buffer, fileName);
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseExcel(buffer, fileName);
  }
  // Try Excel first, fall back to CSV
  try {
    return parseExcel(buffer, fileName);
  } catch {
    return parseCsv(buffer, fileName);
  }
}

export function buildDataContext(upload: SessionUpload): string {
  const { data, fileName, columns, numericColumns } = upload;
  const rowCount = data.length;
  const sampleSize = Math.min(rowCount, 40);
  const sample = data.slice(0, sampleSize);

  const stats: Record<string, { min: number; max: number; mean: number; nulls: number }> = {};
  for (const col of numericColumns) {
    const values = data
      .map((r) => r[col])
      .filter((v): v is number => typeof v === "number" && !isNaN(v));
    if (values.length > 0) {
      stats[col] = {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        nulls: rowCount - values.length,
      };
    }
  }

  const statsLines = Object.entries(stats)
    .map(([col, s]) =>
      `  ${col}: min=${s.min.toFixed(2)}, max=${s.max.toFixed(2)}, mean=${s.mean.toFixed(2)}, nulls=${s.nulls}`
    )
    .join("\n");

  const sampleLines = sample
    .map((row) =>
      columns.map((col) => {
        const v = row[col];
        return `${col}=${v ?? "N/A"}`;
      }).join(" | ")
    )
    .join("\n");

  return `## Uploaded Dataset: ${fileName}
Total rows: ${rowCount}
Columns (${columns.length}): ${columns.join(", ")}
Numeric columns: ${numericColumns.join(", ")}

### Column Statistics
${statsLines || "  (no numeric columns detected)"}

### Sample Data (first ${sampleSize} rows)
${sampleLines}${rowCount > sampleSize ? `\n[... and ${rowCount - sampleSize} more rows not shown]` : ""}`;
}
