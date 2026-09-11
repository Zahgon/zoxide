/**
 * `BufRead::read_until`, as the file-based importers use it: records are split
 * on a delimiter, the delimiter and a preceding `\r` are stripped, empty
 * records are skipped, and the line counter advances for every record read —
 * including the skipped ones, so reported line numbers match the file.
 */
export interface Record {
  readonly bytes: Buffer;
  readonly lineNum: number;
}

export function* readRecords(buffer: Buffer, delimiter: number, stripCarriageReturn: boolean): Generator<Record> {
  let offset = 0;
  let lineNum = 0;

  while (offset < buffer.length) {
    lineNum += 1;
    const found = buffer.indexOf(delimiter, offset);
    const end = found === -1 ? buffer.length : found + 1;
    let record = buffer.subarray(offset, end);
    offset = end;

    if (record.length > 0 && record[record.length - 1] === delimiter) {
      record = record.subarray(0, record.length - 1);
    }
    if (stripCarriageReturn && record.length > 0 && record[record.length - 1] === 0x0d) {
      record = record.subarray(0, record.length - 1);
    }
    if (record.length === 0) {
      continue;
    }
    yield { bytes: record, lineNum };
  }
}
