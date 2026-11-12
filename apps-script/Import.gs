/**
 * Import.gs — loads the CSV files written by export.ps1 from a Google Drive folder
 * into raw_* tabs. The raw tabs are replaced on every import and never edited by hand.
 */

const CSV_TABS = {
  'po_lines.csv': 'raw_po_lines',
  'warehouse_receipts.csv': 'raw_receipts',
  'inventory_by_location.csv': 'raw_inventory_by_location',
  'product_master.csv': 'raw_product_master',
};

// Kept as text even if they look like numbers (a PO typed as "0681" must stay "0681").
const TEXT_COLUMNS = ['receipt_id', 'po_ref', 'sku', 'sku_entered', 'shelf', 'bin'];
const DATE_COLUMN = /(_date|_due)$/;
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

/** @return {string[]} one line per file, e.g. "po_lines.csv: 4654 rows" */
function importCsvs_() {
  const settings = getSettings_();
  if (!settings.csvFolderId) {
    throw new Error('Paste the Google Drive folder link into "CSV folder" on the Settings tab first.');
  }
  const folder = DriveApp.getFolderById(settings.csvFolderId);

  return Object.keys(CSV_TABS).map(fileName => {
    const file = latestFile_(folder, fileName);
    const text = file.getBlob().getDataAsString('UTF-8').replace(/^﻿/, '');
    const rows = Utilities.parseCsv(text).filter(r => r.some(v => v !== ''));
    const headers = rows.shift().map(h => h.trim());
    const dateHeaders = headers.filter(h => DATE_COLUMN.test(h));

    // Numbers are converted here, not by Sheets, so a decimal point is read the same in every locale.
    const typed = rows.map(r => headers.map((h, i) => {
      const v = r[i] === undefined ? '' : r[i];
      if (v === '' || TEXT_COLUMNS.indexOf(h) !== -1 || dateHeaders.indexOf(h) !== -1) return v;
      return NUMBER_TEXT.test(v) ? Number(v) : v;
    }));

    const formats = {};
    dateHeaders.forEach(h => { formats[h] = 'yyyy-mm-dd'; });
    const sheet = writeTable_(CSV_TABS[fileName], headers, typed, { textColumns: TEXT_COLUMNS, formats });
    sheet.setTabColor('#9aa0a6');
    return `${fileName}: ${typed.length} rows`;
  });
}

/** Uploading a file again to Drive creates a second copy with the same name: always take the newest. */
function latestFile_(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  let newest = null;
  while (files.hasNext()) {
    const f = files.next();
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  if (!newest) throw new Error(`"${fileName}" was not found in the CSV folder.`);
  return newest;
}
