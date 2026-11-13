/**
 * SheetIO.gs — reading and writing tabs as tables (header row + data rows).
 */

/**
 * Reads a tab into an array of objects keyed by the header row.
 * Dates come back as "yyyy-MM-dd" strings so the logic never has to think about time zones.
 */
function readTable_(sheetName) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 1) {
    throw new Error(`Tab "${sheetName}" is missing or empty. Run "Import CSVs from Drive" first.`);
  }
  const tz = ss.getSpreadsheetTimeZone();
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  return values
    .filter(row => row.some(v => v !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        const v = row[i];
        obj[h] = v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v;
      });
      return obj;
    });
}

/**
 * Replaces a tab's contents with a table. Creates the tab if needed.
 * @param {Object} [opts]
 *   textColumns: headers whose cells must stay plain text (SKUs, PO refs)
 *   formats:     {header: number format}, e.g. {due_date: 'yyyy-mm-dd'}
 */
function writeTable_(sheetName, headers, rows, opts) {
  opts = opts || {};
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.clear();
  sheet.clearConditionalFormatRules();
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();

  const numRows = rows.length + 1;
  const numCols = headers.length;
  if (sheet.getMaxRows() < numRows) sheet.insertRowsAfter(sheet.getMaxRows(), numRows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < numCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), numCols - sheet.getMaxColumns());

  // Formats go on before the values, so "0681" stays text and "2014-02-03" becomes a date.
  (opts.textColumns || []).forEach(h => {
    const col = headers.indexOf(h) + 1;
    if (col) sheet.getRange(1, col, numRows, 1).setNumberFormat('@');
  });
  Object.keys(opts.formats || {}).forEach(h => {
    const col = headers.indexOf(h) + 1;
    if (col && rows.length) sheet.getRange(2, col, rows.length, 1).setNumberFormat(opts.formats[h]);
  });

  const clean = rows.map(r => headers.map((_, i) => (r[i] === undefined || r[i] === null ? '' : r[i])));
  sheet.getRange(1, 1, numRows, numCols).setValues([headers].concat(clean));

  sheet.getRange(1, 1, 1, numCols).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setFrozenRows(1);
  if (rows.length) sheet.getRange(1, 1, numRows, numCols).createFilter();
  sheet.autoResizeColumns(1, numCols);
  return sheet;
}

/** Red / amber / grey fill for a High / Medium / Low column. */
function colorSeverity_(sheet, col, numRows) {
  colorText_(sheet, col, numRows, {
    High: ['#fce8e6', '#a50e0e'],
    Medium: ['#fef7e0', '#7a4f01'],
    Low: ['#f1f3f4', '#3c4043'],
  });
}

/** Conditional formatting: {cellText: [background, fontColor]} on one column. */
function colorText_(sheet, col, numRows, colors) {
  if (numRows < 1 || col < 1) return;
  const range = sheet.getRange(2, col, numRows, 1);
  const rules = sheet.getConditionalFormatRules();
  Object.keys(colors).forEach(text => {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text)
      .setBackground(colors[text][0])
      .setFontColor(colors[text][1])
      .setRanges([range])
      .build());
  });
  sheet.setConditionalFormatRules(rules);
}

/** Run results are kept in document properties so the Summary can combine separate runs. */
function saveStats_(name, stats) {
  stats.ranAt = new Date().toISOString();
  PropertiesService.getDocumentProperties().setProperty('stats_' + name, JSON.stringify(stats));
}

function loadStats_(name) {
  const raw = PropertiesService.getDocumentProperties().getProperty('stats_' + name);
  return raw ? JSON.parse(raw) : null;
}
