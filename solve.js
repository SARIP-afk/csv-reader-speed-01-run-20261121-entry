// csv-reader-speed-01: a fast drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what make.fun's csv-reader 1.0.0 returns for the
// same input {text, header}: the JSON value {columns, rows, errors}. Written
// from the specification in the kit's RULES.txt, not from the reference code:
//
//   - the text is read once, left to right, commas and double quotes;
//   - a U+FEFF at its very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (error quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text
//     after it is read again as unquoted (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (error short_row, with fields: its field count) or cut (error
//     long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside a quoted
//     field counted), row its record's index in rows, null for the header.
//
// Speed comes from never reading one character at a time on the common path:
// an unquoted field is cut out with indexOf + slice (its terminator is the
// nearer of the next comma and the next LF, and a CR inside the cut is found
// with one more indexOf on that short slice, so no search ever runs past the
// field); a quoted field is cut out with indexOf for its closing quote, and
// only the rare broken pieces -- stray CRs, doubled quotes, junk after a
// closing quote, multi-line quoted spans -- take a slower road. Line numbers
// are kept exact by counting the line breaks a quoted span holds, CRLF
// counting once.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The next LF at or after the position this was computed for (len when
  // there is none): a field on the same line ends at it, so one search per
  // line serves every field on it. Valid while it is not behind pos: a
  // quoted field that spans lines moves pos past it and it is recomputed.
  // qCache and crCache are the same idea for the next quote and the next CR:
  // each search scans only up to the next one, so all three together cost
  // one pass over the text, never one scan per field.
  let nlCache = -1;
  let qCache = -1;
  let crCache = -1;

  // Scratch for the field just read: its value, how it ended, and (for an
  // unquoted read) how many characters it kept.
  const F = { value: '', ended: END, added: 0 };

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Sets F: the field, how it
  // ended, and how many characters it kept.
  function readUnquotedInto(value) {
    let v = value;
    let added = 0;
    if (nlCache < pos) {
      const n = text.indexOf('\n', pos);
      nlCache = n === -1 ? len : n;
    }
    const comma = text.indexOf(',', pos);
    const nl = nlCache;
    let end = len;
    let term = END;
    if (comma !== -1 && (nl === len || comma < nl)) {
      end = comma;
      term = COMMA;
    } else if (nl !== len) {
      end = nl;
      term = LINE_BREAK;
    }
    // The cut holds no comma and no LF, so a CR inside it is never followed
    // by an LF of the cut -- except one at its very end, when the LF that
    // ends the cut follows it: that one is the CRLF line break.
    const seg = text.slice(pos, end);
    let cr = seg.indexOf('\r');
    if (cr === -1) {
      v += seg;
      added += seg.length;
      pos = end;
      if (term === COMMA) pos += 1;
      else if (term === LINE_BREAK) {
        pos += 1;
        line += 1;
      }
      F.value = v;
      F.ended = term;
      F.added = added;
      return;
    }
    let s = 0;
    while (cr !== -1) {
      if (cr === seg.length - 1 && end < len && text.charCodeAt(end) === 10) {
        // The cut's last character is a CR and the cut ends at an LF: CRLF.
        v += seg.slice(s, cr);
        added += cr - s;
        pos = end + 1;
        line += 1;
        F.value = v;
        F.ended = LINE_BREAK;
        F.added = added;
        return;
      }
      error('stray_cr');
      v += seg.slice(s, cr);
      added += cr - s;
      s = cr + 1;
      cr = seg.indexOf('\r', s);
    }
    v += seg.slice(s);
    added += seg.length - s;
    pos = end;
    if (term === COMMA) pos += 1;
    else if (term === LINE_BREAK) {
      pos += 1;
      line += 1;
    }
    F.value = v;
    F.ended = term;
    F.added = added;
  }

  // Reads a quoted field whose opening quote is at pos. Sets F.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let close = text.indexOf('"', pos);
    let hasDouble = false;
    while (close !== -1 && text.charCodeAt(close + 1) === 34) {
      hasDouble = true;
      close = text.indexOf('"', close + 2);
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      readUnquotedInto('"');
      return;
    }
    // Count the line breaks the quoted span holds (a CRLF counts once) and
    // take the span as the value, undoing "" escapes and CR line breaks.
    // Every check runs on the span's slice, never past its closing quote.
    let v = text.slice(pos, close);
    const spanNl = v.indexOf('\n');
    const spanCr = v.indexOf('\r');
    if (spanNl !== -1 || spanCr !== -1) {
      let lb = 0;
      for (let i = 0; i < v.length; i++) {
        const cc = v.charCodeAt(i);
        if (cc === 10) lb += 1;
        else if (cc === 13) {
          lb += 1;
          if (v.charCodeAt(i + 1) === 10) i += 1;
        }
      }
      line += lb;
    }
    let value;
    if (!hasDouble && spanCr === -1) {
      value = v;
    } else {
      if (hasDouble) v = v.replaceAll('""', '"');
      if (spanCr !== -1) v = v.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      value = v;
    }
    pos = close + 1;
    if (pos >= len) {
      F.value = value;
      F.ended = END;
      return;
    }
    const cc = text.charCodeAt(pos);
    if (cc === 44) {
      pos += 1;
      F.value = value;
      F.ended = COMMA;
      return;
    }
    if (cc === 10) {
      pos += 1;
      line += 1;
      F.value = value;
      F.ended = LINE_BREAK;
      return;
    }
    if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      F.value = value;
      F.ended = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquotedInto(value);
    if (F.added > 0) error('quote_junk');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const cc = text.charCodeAt(pos);
      if (cc === 10) {
        pos += 1;
        line += 1;
      } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the whole record sits on this one line, with no quote and
    // no stray CR in it (a trailing CR is the CRLF line break). Then the
    // line splits natively instead of field by field. Anything else -- a
    // quote, a stray CR -- takes the field reader below, which is exact.
    if (nlCache < pos) {
      const n = text.indexOf('\n', pos);
      nlCache = n === -1 ? len : n;
    }
    if (qCache < pos) {
      const q = text.indexOf('"', pos);
      qCache = q === -1 ? len : q;
    }
    if (crCache < pos) {
      const c = text.indexOf('\r', pos);
      crCache = c === -1 ? len : c;
    }
    const lineEnd = nlCache;
    if (qCache >= lineEnd) {
      if (crCache >= lineEnd || (crCache === lineEnd - 1 && lineEnd < len)) {
        const plain = crCache >= lineEnd ? text.slice(pos, lineEnd) : text.slice(pos, lineEnd - 1);
        pos = lineEnd < len ? lineEnd + 1 : len;
        line += 1;
        if (plain !== '') {
          const fields = plain.split(',');
          if (width < 0) width = fields.length;
          if (header && columns === null) {
            columns = fields;
            continue;
          }
          if (fields.length < width) {
            errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
            while (fields.length < width) fields.push('');
          } else if (fields.length > width) {
            errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
          }
          rows.push(fields);
        }
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    let ended;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquotedInto('');
      fields.push(F.value);
      ended = F.ended;
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
