// A fast drop-in for csv-reader 1.0.0: reads a broken CSV file exactly as the
// reference does, from the written spec alone.
//
// Reading rules (one left-to-right pass):
// - A U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field that opens with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, and each CRLF or lone CR inside it is read as LF.
//   What follows its closing quote, up to the next comma or line break, is
//   appended as it stands (error quote_junk, when the field ends).
// - A quote that never closes is a literal character, and the text after it is
//   read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds the
//   records after it (every record when header is false), each padded with empty
//   strings (short_row, with fields: its field count) or cut (long_row, with
//   extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met, a record's short_row or
//   long_row when it ends: line the 1-based line its record starts on, counting
//   every LF, CRLF and lone CR inside quotes, and row its record's index in
//   rows, null for the header.
//
// Speed: lines with no quote and no stray CR take a split fast path; the rest
// are parsed field by field with indexOf jumps, the end of the current line
// cached so an unquoted field costs one indexOf, and the hot path never walks
// the text character by character.

const CR = 13; // '\r'
const LF = 10; // '\n'
const QUOTE = 34; // '"'

export function run(input) {
  const text = input.text;
  const header = input.header;
  const n = text.length;
  let i = 0;
  if (n !== 0 && text.charCodeAt(0) === 0xfeff) i = 1;
  let line = 1;
  const errors = [];
  const records = [];

  // Pad or cut a finished data record to the first record's width, recording
  // the short_row / long_row error at the record's end, in the order met.
  function finishRecord(fields, recLine, recRow) {
    if (records.length <= 1) return; // the first record sets the width
    const width = records[0].length;
    if (fields.length < width) {
      errors.push({ code: 'short_row', fields: fields.length, line: recLine, row: recRow });
      for (let k = fields.length; k < width; k++) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', extra: fields.slice(width), line: recLine, row: recRow });
      fields.length = width;
    }
  }

  // Drop every CR in seg, reporting the stray ones. A CR that is seg's last
  // character before a LF line break (kind 1) is that break's CRLF, so it is
  // dropped quietly. Only used where a CR was found, so it stays off the
  // hot path.
  function dropCRs(seg, kind, recLine, recRow) {
    let acc = '';
    let p = 0;
    for (;;) {
      const r = seg.indexOf('\r', p);
      if (r === -1) {
        acc += seg.slice(p);
        break;
      }
      acc += seg.slice(p, r);
      if (kind === 1 && r === seg.length - 1) break; // the CRLF's CR
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      p = r + 1;
    }
    return acc;
  }

  // An unquoted field, or the junk after a closing quote, or the re-read of
  // an unterminated field: the text from `start` up to the next comma or the
  // end of the current line (nl, the '\n' ending it, or -1). `prefix` is the
  // literal opening quote of an unterminated field, else ''. Returns
  // [value, kind]: kind 0 at a comma, 1 at a line break, 2 at end of text.
  // A stray CR inside it is dropped and reported; the CR of a CRLF is not.
  function parseBare(start, prefix, nl, recLine, recRow) {
    const commaAt = text.indexOf(',', start);
    let end;
    let kind; // 0 comma, 1 line break, 2 end of text
    if (commaAt !== -1 && (nl === -1 || commaAt < nl)) {
      end = commaAt;
      kind = 0;
    } else if (nl !== -1) {
      end = nl;
      kind = 1;
    } else {
      end = n;
      kind = 2;
    }
    const seg = text.slice(start, end);
    let value;
    if (seg.indexOf('\r') === -1) {
      value = prefix === '' ? seg : prefix + seg;
    } else {
      value = prefix + dropCRs(seg, kind, recLine, recRow);
    }
    if (kind === 0) {
      i = end + 1;
      return [value, 0];
    }
    if (kind === 1) {
      line++;
      i = end + 1;
      return [value, 1];
    }
    i = n;
    return [value, 2];
  }

  // One record whose line holds a quote or a stray CR: parse it field by
  // field. Only called at a record start, so no quote is open. `nl` is the
  // '\n' ending the record's first line, or -1. Advances i past the record's
  // end and counts every line break crossed, including the ones inside
  // quoted fields.
  function parseSlow(recLine, recRow, nl) {
    const fields = [];
    for (;;) {
      if (i < n && text.charCodeAt(i) === QUOTE) {
        // A field that opens with a quote: find its closing quote.
        let j = i + 1;
        let closed = -1;
        let doubled = false;
        for (;;) {
          j = text.indexOf('"', j);
          if (j === -1) break;
          if (text.charCodeAt(j + 1) === QUOTE) {
            doubled = true;
            j += 2;
            continue;
          }
          closed = j;
          break;
        }
        if (closed === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          const r = parseBare(i + 1, '"', nl, recLine, recRow);
          fields.push(r[0]);
          if (r[1] === 0) continue;
          break;
        }
        let value;
        const raw = text.slice(i + 1, closed);
        let hasBreak = false;
        if (raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1) {
          value = doubled ? raw.replaceAll('""', '"') : raw;
        } else {
          // Each CRLF or lone CR inside the quotes is one line, read as LF.
          hasBreak = true;
          let breaks = 0;
          for (let k = 0; k < raw.length; k++) {
            const c = raw.charCodeAt(k);
            if (c === CR) {
              breaks++;
              if (raw.charCodeAt(k + 1) === LF) k++;
            } else if (c === LF) {
              breaks++;
            }
          }
          line += breaks;
          value = raw.replace(/\r\n?/g, '\n');
          if (doubled) value = value.replaceAll('""', '"');
        }
        i = closed + 1;
        // What follows the closing quote, up to the next comma or line break,
        // is appended as it stands. The closing quote may be on a later line
        // than the field opened on, so the line's end is found again then,
        // before anything else reads it.
        if (hasBreak) nl = text.indexOf('\n', i);
        // Most quoted fields have nothing there: a comma, a line break or
        // the end of text ends the field with no junk, and only anything else
        // needs the bare scan.
        const nc = i < n ? text.charCodeAt(i) : -1;
        if (nc === 44) {
          fields.push(value);
          i++;
          continue;
        }
        if (nc === 10) {
          fields.push(value);
          line++;
          i++;
          break;
        }
        if (nc === -1) {
          fields.push(value);
          i = n;
          break;
        }
        if (nc === CR && text.charCodeAt(i + 1) === LF) {
          fields.push(value);
          line++;
          i += 2;
          break;
        }
        const r = parseBare(i, '', nl, recLine, recRow);
        if (r[0].length !== 0) {
          value += r[0];
          errors.push({ code: 'quote_junk', line: recLine, row: recRow });
        }
        fields.push(value);
        if (r[1] === 0) continue;
        break;
      }
      // Unquoted field: it ends at the next comma or the end of the line.
      // (Inlined: this is the hot path, most fields take it.)
      const commaAt = text.indexOf(',', i);
      let end;
      let kind; // 0 comma, 1 line break, 2 end of text
      if (commaAt !== -1 && (nl === -1 || commaAt < nl)) {
        end = commaAt;
        kind = 0;
      } else if (nl !== -1) {
        end = nl;
        kind = 1;
      } else {
        end = n;
        kind = 2;
      }
      const seg = text.slice(i, end);
      fields.push(seg.indexOf('\r') === -1 ? seg : dropCRs(seg, kind, recLine, recRow));
      if (kind === 0) {
        i = end + 1;
        continue;
      }
      if (kind === 1) {
        line++;
        i = end + 1;
      } else {
        i = n;
      }
      break;
    }
    return fields;
  }

  while (i < n) {
    const recLine = line;
    const isHead = header && records.length === 0;
    const recRow = isHead ? null : records.length - (header ? 1 : 0);
    // Fast path: the whole line holds no quote and no stray CR, so its fields
    // are the line split on commas. A CR just before the line's LF is the
    // CRLF line break, not a stray CR.
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? n : nl;
    let segEnd = lineEnd;
    if (nl !== -1 && segEnd > i && text.charCodeAt(segEnd - 1) === CR) segEnd--;
    const seg = text.slice(i, segEnd);
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      if (segEnd !== i) {
        const fields = seg.split(',');
        records.push(fields);
        finishRecord(fields, recLine, recRow);
      }
      if (nl === -1) break;
      line++;
      i = nl + 1;
      continue;
    }
    const fields = parseSlow(recLine, recRow, nl);
    records.push(fields);
    finishRecord(fields, recLine, recRow);
  }

  let columns;
  let rows;
  if (header) {
    columns = records.length === 0 ? [] : records[0];
    rows = records.slice(1);
  } else {
    columns = null;
    rows = records;
  }
  return { columns, rows, errors };
}
