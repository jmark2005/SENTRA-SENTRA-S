'use strict';

/**
 * CSV and PDF output for report exports (T-34).
 *
 * A report is { title, columns: [{ label, width }], rows: [[cell, ...]] };
 * `width` is a relative weight used only for PDF column widths.
 */

const PDFDocument   = require('pdfkit');
const { stringify } = require('csv-stringify/sync');

// ── CSV ──────────────────────────────────────────────────────────────────────
// Spreadsheet apps treat cells starting with these as formulas, so free text
// typed by users (descriptions, summaries) gets a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && FORMULA_START.test(value)) return `'${value}`;
  return value;
}

/** CSV with a UTF-8 byte-order mark so Excel shows names and dashes correctly. */
function toCsv(report) {
  const text = stringify([
    report.columns.map(c => c.label),
    ...report.rows.map(row => row.map(csvCell)),
  ]);
  return Buffer.from('﻿' + text, 'utf8');
}

// ── PDF ──────────────────────────────────────────────────────────────────────
// The built-in PDF fonts only cover the Windows-1252 character set; anything
// else (emoji, CJK) would print as wrong glyphs, so it becomes "?".
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const MAX_CELL_CHARS = 400;
const FONT_SIZE = 8;
const PAD = 3;

function pdfText(value) {
  if (value === null || value === undefined) return '';
  let s = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    const ok = ch === '\n' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)
      || WIN_ANSI_EXTRA.includes(ch);
    s += ok ? ch : (code < 0x20 ? ' ' : '?');
  }
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS - 1) + '…' : s;
}

/**
 * Landscape A4 table. Header shows the school name, report title, who made it
 * and when, and the filters; the column header row repeats on every page.
 * @param {object} meta { schoolName, generatedAt, timezone, generatedBy, filterText }
 * @returns {Promise<Buffer>}
 */
function toPdf(report, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', layout: 'landscape', margin: 36, bufferPages: true,
      info: { Title: pdfText(`${report.title} - ${meta.schoolName}`), Author: 'S.E.N.T.R.A.' },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const tableWidth = doc.page.width - left - doc.page.margins.right;
    const weights = report.columns.map(c => c.width || 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map(w => (tableWidth * w) / totalWeight);
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    // Heading
    doc.font('Helvetica-Bold').fontSize(14).text(pdfText(meta.schoolName), left, doc.page.margins.top, { width: tableWidth });
    doc.fontSize(12).text(pdfText(report.title), { width: tableWidth });
    doc.font('Helvetica').fontSize(8).fillColor('#444444')
      .text(pdfText(`Generated ${meta.generatedAt} (${meta.timezone} time) by ${meta.generatedBy}`), { width: tableWidth })
      .text(pdfText(`Filters: ${meta.filterText}`), { width: tableWidth })
      .text(`Rows: ${report.rows.length}`, { width: tableWidth });
    doc.moveDown(0.6);

    function rowHeight(cells, font) {
      doc.font(font).fontSize(FONT_SIZE);
      return Math.max(...cells.map((c, i) => doc.heightOfString(c || ' ', { width: widths[i] - 2 * PAD }))) + 2 * PAD;
    }

    function drawRow(cells, y, { header = false, shade = false } = {}) {
      const font = header ? 'Helvetica-Bold' : 'Helvetica';
      const h = rowHeight(cells, font);
      if (header || shade) doc.rect(left, y, tableWidth, h).fill(header ? '#e4e4e4' : '#f6f6f6');
      doc.fillColor('#000000').font(font).fontSize(FONT_SIZE);
      let x = left;
      cells.forEach((c, i) => {
        doc.text(c, x + PAD, y + PAD, { width: widths[i] - 2 * PAD });
        x += widths[i];
      });
      doc.moveTo(left, y + h).lineTo(left + tableWidth, y + h).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
      return h;
    }

    const headerCells = report.columns.map(c => pdfText(c.label));
    let y = doc.y;
    y += drawRow(headerCells, y, { header: true });

    if (!report.rows.length) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#444444')
        .text('No records match these filters.', left, y + 8, { width: tableWidth });
    }

    report.rows.forEach((row, n) => {
      const cells = row.map(pdfText);
      if (y + rowHeight(cells, 'Helvetica') > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        y += drawRow(headerCells, y, { header: true });
      }
      y += drawRow(cells, y, { shade: n % 2 === 1 });
    });

    // Footer on every page. The bottom margin is lifted while writing it so
    // pdfkit does not push the footer onto a new page.
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor('#666666')
        .text(pdfText(`${meta.schoolName} · ${report.title} · Page ${i + 1} of ${range.count}`),
          left, doc.page.height - 24, { width: tableWidth, align: 'center', lineBreak: false });
      doc.page.margins.bottom = margin;
    }

    doc.end();
  });
}

module.exports = { toCsv, toPdf, pdfText };
