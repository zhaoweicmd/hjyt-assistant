// lib/xlsx_min.js —— 零依赖 .xlsx 生成器（ZIP STORE，不压缩）
// 只覆盖本仓库需要的子集：多工作表、inlineStr 文本、数字、表头加粗、列宽、冻结首行。
// 用法：
//   const { buildXlsx, writeXlsx } = require('./lib/xlsx_min.js')
//   const buf = buildXlsx([{ name: '表1', rows: [[{v:'标题',bold:true}], ['a', 1]], cols: [16, 10], freezeRows: 1 }])
//   writeXlsx('out.xlsx', sheets)
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';

// ---------------- CRC32 ----------------
let _tbl = null;
function crc32Table() {
  if (_tbl) return _tbl;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  _tbl = t;
  return t;
}
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  const t = crc32Table();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------- ZIP（method=0，只存不压） ----------------
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

function zipStore(entries, when) {
  const dt = dosDateTime(when || new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(0, 8);      // 方法：仅存储
    lh.writeUInt16LE(dt.time, 10);
    lh.writeUInt16LE(dt.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dt.time, 12);
    ch.writeUInt16LE(dt.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat(parts.concat([cd, eocd]));
}

// ---------------- XML 工具 ----------------
function esc(s) {
  return String(s)
    // XML 1.0 非法控制字符直接去掉，否则 Excel 打不开
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function colName(n) {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function cellXml(ref, cell, rowStyle) {
  if (cell === null || cell === undefined) return '';
  let v = cell;
  let style = rowStyle | 0;
  let fmt = null;
  if (typeof cell === 'object') {
    v = cell.v;
    if (cell.bold) style = 1;
    if (cell.s !== undefined) style = cell.s | 0;
    if (cell.fmt) fmt = cell.fmt;
  }
  if (v === null || v === undefined || v === '') return '';
  const sAttr = style ? ` s="${style}"` : '';
  if (typeof v === 'number' && isFinite(v)) {
    return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  }
  if (fmt === 'pct' && typeof v === 'number') {
    return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml(sheet) {
  const rows = sheet.rows || [];
  const cols = sheet.cols || [];
  const freeze = sheet.freezeRows || 0;
  let x = XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  if (freeze > 0) {
    x += `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  }
  if (cols.length) {
    x += '<cols>' + cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
  }
  x += '<sheetData>';
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const rn = r + 1;
    x += `<row r="${rn}">`;
    for (let c = 0; c < row.length; c++) {
      x += cellXml(colName(c) + rn, row[c], 0);
    }
    x += '</row>';
  }
  x += '</sheetData></worksheet>';
  return x;
}

function stylesXml() {
  // 0 = 常规；1 = 表头（加粗 + 灰底）；2 = 百分比；3 = 细边框数字
  return XML_HEAD +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="10"/><name val="等线"/></font>' +
    '<font><b/><sz val="10"/><name val="等线"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF7"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '</styleSheet>';
}

function buildXlsx(sheets) {
  const names = sheets.map((s, i) => (s.name || `Sheet${i + 1}`).slice(0, 31));
  const now = new Date();
  const files = [];
  files.push({
    name: '[Content_Types].xml',
    data: XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>',
  });
  files.push({
    name: '_rels/.rels',
    data: XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  });
  files.push({
    name: 'xl/workbook.xml',
    data: XML_HEAD +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      '</workbook>',
  });
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: XML_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  });
  files.push({ name: 'xl/styles.xml', data: stylesXml() });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zipStore(files, now);
}

function writeXlsx(file, sheets) {
  const buf = buildXlsx(sheets);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length };
}

export { buildXlsx, writeXlsx, colName, esc };
