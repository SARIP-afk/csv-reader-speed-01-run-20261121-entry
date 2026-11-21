// csv-reader-speed-01: a fast drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what make.fun's csv-reader 1.0.0 returns for the
// same input {text, header}: the JSON value {columns, rows, errors}. Written
// from the specification in the kit's RULES.txt:
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
// Speed comes from never reading one character at a time on the common path
// and from keeping the field readers inline in the record loop, so a field
// costs no function call and no scratch object:
//
//   - a record on one line with no quote and no stray CR in it splits
//     natively (String split) instead of field by field;
//   - an unquoted field is cut out with indexOf + slice (its terminator is
//     the nearer of the next comma and the next LF, both found with one
//     native search each, the LF one cached per line); a CR inside the cut
//     is found through the cached next-CR position, so the common no-CR
//     case costs one comparison, not a scan;
//   - a quoted field is cut out with indexOf for its closing quote, and
//     only the rare broken pieces -- stray CRs, doubled quotes, junk after
//     a closing quote, multi-line quoted spans -- take a slower road;
//     the line breaks a quoted span holds are counted with native indexOf
//     walks (a CRLF counting once), never a character loop.
//   - the next LF, the next quote and the next CR are each cached: a search
//     scans only up to the next one, so the three together cost one pass
//     over the text, never one scan per field or per line.

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

  // The next LF, the next quote and the next CR at or after the position
  // each was computed for (len when there is none). Valid while not behind
  // pos: a quoted field that spans lines moves pos past them and they are
  // recomputed from the new pos.
  let nl = -1;
  let nq = -1;
  let nc = -1;

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

    // The record being read: the line it starts on and the index in rows it
    // takes (null: the header).
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    if (nl < pos) {
      const n = text.indexOf('\n', pos);
      nl = n === -1 ? len : n;
    }
    if (nq < pos) {
      const q = text.indexOf('"', pos);
      nq = q === -1 ? len : q;
    }
    if (nc < pos) {
      const c = text.indexOf('\r', pos);
      nc = c === -1 ? len : c;
    }
    const lineEnd = nl;

    let fields;
    if (nq >= lineEnd && (nc >= lineEnd || (nc === lineEnd - 1 && lineEnd < len))) {
      // Fast path: the whole record sits on this one line, with no quote
      // and no stray CR in it (a trailing CR is the CRLF line break). The
      // line splits natively instead of field by field.
      const plain = nc >= lineEnd ? text.slice(pos, lineEnd) : text.slice(pos, lineEnd - 1);
      pos = lineEnd < len ? lineEnd + 1 : len;
      line += 1;
      fields = plain.split(',');
    } else {
      // Slow path: the record holds a quote or a stray CR, so it is read
      // field by field, inline: no call and no scratch object per field.
      fields = [];
      let lastQuoted = false;
      let ended;
      do {
        lastQuoted = false;
        let value;
        let scan = true; // whether the unquoted scan below must run
        let prefix = ''; // what the unquoted scan starts from ('', a quoted value, or '"')
        let junkAfter = false; // the quote closed and junk follows it: the scan's added characters are quote_junk
        if (text.charCodeAt(pos) === 34) {
          lastQuoted = true;
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
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            prefix = '"';
          } else {
            // Count the line breaks the quoted span holds (a CRLF counts
            // once) with native indexOf walks, and take the span as the
            // value, undoing "" escapes and CR line breaks.
            let v = text.slice(pos, close);
            const spanNl = v.indexOf('\n');
            const spanCr = v.indexOf('\r');
            if (spanNl !== -1 || spanCr !== -1) {
              let lb = 0;
              let i = spanNl;
              while (i !== -1) {
                lb += 1;
                i = v.indexOf('\n', i + 1);
              }
              let j = spanCr;
              while (j !== -1) {
                if (v.charCodeAt(j + 1) !== 10) lb += 1;
                j = v.indexOf('\r', j + 1);
              }
              line += lb;
            }
            let qvalue;
            if (!hasDouble && spanCr === -1) {
              qvalue = v;
            } else {
              if (hasDouble) v = v.replaceAll('""', '"');
              if (spanCr !== -1) v = v.replace(/\r\n?/g, '\n');
              qvalue = v;
            }
            pos = close + 1;
            if (pos >= len) {
              value = qvalue;
              ended = END;
              scan = false;
            } else {
              const cc = text.charCodeAt(pos);
              if (cc === 44) {
                pos += 1;
                value = qvalue;
                ended = COMMA;
                scan = false;
              } else if (cc === 10) {
                pos += 1;
                line += 1;
                value = qvalue;
                ended = LINE_BREAK;
                scan = false;
              } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                value = qvalue;
                ended = LINE_BREAK;
                scan = false;
              } else {
                // What follows the closing quote is appended as it stands,
                // up to the next comma or line break.
                prefix = qvalue;
                junkAfter = true;
              }
            }
          }
        }
        if (scan) {
          // Reads unquoted characters onto `prefix` up to the next comma or
          // line break: a CR not followed by LF is dropped (stray_cr).
          if (nl < pos) {
            const n = text.indexOf('\n', pos);
            nl = n === -1 ? len : n;
          }
          const comma = text.indexOf(',', pos);
          let end = len;
          let term = END;
          if (comma !== -1 && comma < nl) {
            end = comma;
            term = COMMA;
          } else if (nl !== len) {
            end = nl;
            term = LINE_BREAK;
          }
          if (nc < pos) {
            const c = text.indexOf('\r', pos);
            nc = c === -1 ? len : c;
          }
          let added = 0;
          if (nc >= end) {
            // No CR in the cut: the cut is the field (a CR at its very end
            // cannot be one, since the cut holds no comma and no LF -- except
            // one at its very end when the LF that ends the cut follows it,
            // and that case is caught by nc < end, as nc is that CR).
            const seg = text.slice(pos, end);
            value = prefix + seg;
            added = seg.length;
            pos = end;
            if (term === COMMA) pos += 1;
            else if (term === LINE_BREAK) {
              pos += 1;
              line += 1;
            }
            ended = term;
          } else {
            // The cut holds CRs: walk them, dropping the stray ones.
            let v = prefix;
            let s = pos;
            let cr = nc;
            let done = false;
            while (cr < end) {
              if (cr === end - 1 && end < len && text.charCodeAt(end) === 10) {
                // The cut's last character is a CR and the cut ends at an
                // LF: CRLF.
                v += text.slice(s, cr);
                added += cr - s;
                pos = end + 1;
                line += 1;
                value = v;
                ended = LINE_BREAK;
                nc = -1;
                done = true;
                break;
              }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              v += text.slice(s, cr);
              added += cr - s;
              s = cr + 1;
              cr = text.indexOf('\r', s);
              if (cr === -1) cr = len;
            }
            if (!done) {
              v += text.slice(s, end);
              added += end - s;
              pos = end;
              if (term === COMMA) pos += 1;
              else if (term === LINE_BREAK) {
                pos += 1;
                line += 1;
              }
              value = v;
              ended = term;
              nc = cr;
            }
          }
          if (junkAfter && added > 0) {
            errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          }
        }
        fields.push(value);
      } while (ended === COMMA);

      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    }

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
