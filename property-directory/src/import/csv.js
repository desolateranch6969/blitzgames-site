/**
 * CSV parsing.
 *
 * Written properly rather than split-on-comma, because a real CRM export will
 * absolutely contain `"The Maple, Uptown"`, a notes field with an embedded
 * newline, and a quote inside a quoted value. Each of those silently corrupts a
 * naive parser and the corruption shows up later as a property with a mangled
 * name, which is exactly the kind of bad data that is hard to trace back.
 *
 * Handles: quoted fields, escaped quotes (`""`), embedded newlines, CRLF, a
 * UTF-8 BOM, and comma / tab / semicolon / pipe delimiters.
 */

/**
 * Guess the delimiter from the header line. Counts only characters outside
 * quotes, so a comma inside `"Last, First"` does not vote.
 * @param {string} text
 */
export function sniffDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQuotes = false;

  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }

  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/**
 * @param {string} text
 * @param {{delimiter?: string}} [opts]
 * @returns {{headers: string[], rows: Record<string, string>[], rowCount: number}}
 */
export function parseCsv(text, opts = {}) {
  let input = String(text ?? '');
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1); // strip BOM

  const delimiter = opts.delimiter ?? sniffDelimiter(input);
  const table = parseRaw(input, delimiter);
  if (!table.length) return { headers: [], rows: [], rowCount: 0 };

  const headers = table[0].map((h, i) => h.trim() || `column_${i + 1}`);
  const rows = [];

  for (const cells of table.slice(1)) {
    // A trailing blank line is normal; a row of only empties is not data.
    if (cells.every((c) => c.trim() === '')) continue;
    /** @type {Record<string, string>} */
    const row = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] ?? '').trim();
    });
    rows.push(row);
  }

  return { headers, rows, rowCount: rows.length };
}

/**
 * The state machine. Kept separate so it can be tested on its own.
 * @param {string} input
 * @param {string} delimiter
 * @returns {string[][]}
 */
export function parseRaw(input, delimiter = ',') {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'; // an escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // handled by the \n that follows; a lone \r is treated as a break too
      if (input[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Serialize back out — for the review file the importer writes when rows are
 * skipped, so they can be corrected and re-fed rather than lost.
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} [headers]
 */
export function toCsv(rows, headers) {
  if (!rows?.length) return '';
  const cols = headers ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n');
}
