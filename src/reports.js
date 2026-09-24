// Builds polished, styled .xlsx workbooks for the two exports this app
// offers (the check-in feed and payroll) -- not just raw CSV. Excel is the
// realistic way anyone actually opens "a report" on a client's Windows
// laptop, so a title block, a real header row, currency/date formatting,
// and readable column widths are worth getting right here, deliberately,
// rather than just dumping rows with commas between them.

const ExcelJS = require('exceljs');

const BRAND_ARGB = 'FF2F5233'; // deep green -- matches the dashboard's own accent color
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_ARGB } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const TITLE_FONT = { bold: true, size: 16, color: { argb: BRAND_ARGB } };
const SUBTITLE_FONT = { italic: true, size: 10, color: { argb: 'FF666666' } };
const THIN_GREY = { style: 'thin', color: { argb: 'FFD8DEDA' } };
const ZEBRA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F3' } };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4ECE5' } };

const DIRECTION_KA = { in: 'შემოსვლა', out: 'გასვლა' };
const SOURCE_KA = { face: 'სახე', card: 'ბარათი' };

function dateOnly(iso) {
  return (iso || '').slice(0, 10);
}
function timeOnly(iso) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso || '');
  return m ? m[1] : '';
}

// A currency symbol is admin-typed free text (Settings), not a fixed enum
// -- guard the one character (") that would break out of an Excel number
// format's quoted literal instead of assuming it's always safe to embed.
function safeCurrency(currency) {
  return String(currency || '').replace(/"/g, '');
}

// Column widths here are deliberately explicit rather than "auto-fit" --
// exceljs has no real auto-fit (it would need to measure rendered glyph
// widths itself), so a plausible fixed width per column reads far better
// than the truncated/overflowing default (~8 chars) every column would
// otherwise get.
function applyColumnWidths(sheet, widths) {
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}

function writeTitleBlock(sheet, colCount, { title, subtitle }) {
  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = TITLE_FONT;
  titleCell.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 28;

  sheet.mergeCells(2, 1, 2, colCount);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = SUBTITLE_FONT;
  sheet.getRow(2).height = 18;
  // row 3 is left blank on purpose -- a visual gap between the title block
  // and the header row below it.
}

function writeHeaderRow(sheet, rowIndex, headers) {
  const row = sheet.getRow(rowIndex);
  headers.forEach((h, i) => { row.getCell(i + 1).value = h; });
  row.eachCell((cell) => {
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: THIN_GREY, left: THIN_GREY, bottom: THIN_GREY, right: THIN_GREY };
  });
  row.height = 22;
  return row;
}

function zebraStripeRow(row, zebra) {
  row.eachCell((cell) => {
    cell.border = { bottom: THIN_GREY };
    cell.alignment = { ...cell.alignment, vertical: 'middle' };
    if (zebra) cell.fill = ZEBRA_FILL;
  });
}

// rows: db.listCheckins() output. meta: { siteName, filterLabel } -- the
// filter description (date/employee/"all") gets baked into the subtitle so
// the exported file is self-describing even once it's saved somewhere else,
// detached from the dashboard it came from.
async function buildCheckinsReport(rows, { siteName, filterLabel }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = siteName;
  wb.created = new Date();

  const headers = ['№', 'თანამშრომლის №', 'სახელი', 'თარიღი', 'დრო', 'მიმართულება', 'წყარო', 'ვერიფიკაცია'];
  const widths = [5, 15, 26, 13, 10, 14, 10, 16];

  const sheet = wb.addWorksheet('ჩანაწერები', { views: [{ state: 'frozen', ySplit: 4 }] });
  applyColumnWidths(sheet, widths);
  writeTitleBlock(sheet, headers.length, {
    title: `${siteName} — დასწრების ანგარიში`,
    subtitle: `${filterLabel} · შექმნილია ${new Date().toLocaleString('ka-GE')} · სულ ${rows.length} ჩანაწერი`,
  });
  writeHeaderRow(sheet, 4, headers);

  rows.forEach((r, i) => {
    const row = sheet.getRow(5 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = r.employee_no ?? '';
    row.getCell(3).value = r.name || '(უცნობი)';
    row.getCell(4).value = dateOnly(r.event_time);
    row.getCell(5).value = timeOnly(r.event_time);
    row.getCell(6).value = DIRECTION_KA[r.direction] || '';
    row.getCell(7).value = SOURCE_KA[r.device_id] || r.device_id || '';
    row.getCell(8).value = r.verify_mode || '';
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(4).alignment = { horizontal: 'center' };
    row.getCell(5).alignment = { horizontal: 'center' };
    row.getCell(6).alignment = { horizontal: 'center' };
    row.getCell(7).alignment = { horizontal: 'center' };
    zebraStripeRow(row, i % 2 === 1);
  });

  return wb;
}

// rows: db.payroll() output (now includes attended_dates, see db.js).
// meta: { siteName, currency, start, end }.
async function buildPayrollReport(rows, { siteName, currency, start, end }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = siteName;
  wb.created = new Date();

  const cur = safeCurrency(currency);
  const headers = ['№', 'თანამშრომლის №', 'სახელი', 'დამსწრე დღეები', 'დღიური განაკვეთი', 'ჯამი', 'დამსწრე თარიღები'];
  const widths = [5, 15, 26, 15, 17, 15, 60];

  const sheet = wb.addWorksheet('ხელფასი', { views: [{ state: 'frozen', ySplit: 4 }] });
  applyColumnWidths(sheet, widths);
  writeTitleBlock(sheet, headers.length, {
    title: `${siteName} — ხელფასის ანგარიში`,
    subtitle: `პერიოდი: ${start} — ${end} · შექმნილია ${new Date().toLocaleString('ka-GE')} · სულ ${rows.length} თანამშრომელი`,
  });
  writeHeaderRow(sheet, 4, headers);

  let grandTotal = 0;
  rows.forEach((r, i) => {
    const row = sheet.getRow(5 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = r.employee_no ?? '';
    row.getCell(3).value = r.name || '(უცნობი)';
    row.getCell(4).value = r.days_present ?? 0;
    row.getCell(5).value = r.daily_wage ?? 0;
    row.getCell(6).value = r.total_pay ?? 0;
    row.getCell(7).value = r.attended_dates || '';
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(4).alignment = { horizontal: 'center' };
    row.getCell(5).numFmt = `#,##0.00 "${cur}"`;
    row.getCell(6).numFmt = `#,##0.00 "${cur}"`;
    row.getCell(6).font = { bold: true };
    zebraStripeRow(row, i % 2 === 1);
    grandTotal += Number(r.total_pay) || 0;
  });

  const totalRowIndex = 5 + rows.length;
  const totalRow = sheet.getRow(totalRowIndex);
  sheet.mergeCells(totalRowIndex, 1, totalRowIndex, 5);
  totalRow.getCell(1).value = 'ჯამური თანხა';
  totalRow.getCell(1).font = { bold: true, size: 12 };
  totalRow.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
  totalRow.getCell(6).value = grandTotal;
  totalRow.getCell(6).numFmt = `#,##0.00 "${cur}"`;
  totalRow.getCell(6).font = { bold: true, size: 12 };
  totalRow.eachCell((cell) => { cell.fill = TOTAL_FILL; cell.border = { top: THIN_GREY, bottom: THIN_GREY }; });
  totalRow.height = 22;

  return wb;
}

module.exports = { buildCheckinsReport, buildPayrollReport };
