/**
 * Settings.gs — the Settings tab, so nobody has to open the code to change a rule.
 * Column A labels are what the script looks for; values in column B can be edited freely.
 */

const SETTINGS_SHEET = 'Settings';

// [key, label shown in the sheet, default value, explanation]
const SETTINGS = [
  ['csvFolder', 'CSV folder (Drive link or ID)', '',
    'Google Drive folder holding the four CSV files from export.ps1'],
  ['asOfDate', 'As-of date', '2014-08-03',
    '"Today" for overdue, late and slow-mover checks. The sample data ends on 2014-08-03.'],
  ['lateToleranceDays', 'Late delivery tolerance (days)', 0,
    'Receipts up to this many days after the due date still count as on time'],
  ['countToleranceUnits', 'Count tolerance (units)', 0,
    'Warehouse vs ERP quantity differences up to this many units are ignored'],
  ['maxSkuEdits', 'Max SKU typo distance', 1,
    'Character edits (wrong, missing, extra or swapped) a typed SKU may have and still match. Only SKUs on the same PO are compared.'],
  ['poSuggestWindowDays', 'PO suggestion window (days)', 7,
    'For a receipt with an unknown PO number: look for a PO line with that SKU shipped within this many days'],
  ['slowMoverDays', 'Slow mover threshold (days)', 180,
    'Stock with no movement for this many days is flagged'],
];

/** Menu item: creates the Settings tab, or adds missing rows while keeping existing values. */
function setupSettings() {
  runSafely_('Setting up the Settings tab…', () => {
    setupSettings_();
    SpreadsheetApp.getActive().getSheetByName(SETTINGS_SHEET).activate();
    return 'Settings tab ready. Paste the CSV folder link into cell B2.';
  });
}

function setupSettings_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SETTINGS_SHEET) || ss.insertSheet(SETTINGS_SHEET);
  const existing = {};
  if (sheet.getLastRow() > 0) {
    sheet.getDataRange().getValues().forEach(r => { existing[String(r[0]).trim()] = r[1]; });
  }

  const rows = [['Setting', 'Value', 'What it does']].concat(SETTINGS.map(([, label, def, help]) =>
    [label, label in existing && existing[label] !== '' ? existing[label] : def, help]));

  sheet.clear();
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.getRange(2, 1, rows.length - 1, 1).setFontWeight('bold');
  sheet.getRange(2, 3, rows.length - 1, 1).setFontColor('#5f6368').setWrap(true);
  const asOfRow = SETTINGS.findIndex(s => s[0] === 'asOfDate') + 2;
  sheet.getRange(asOfRow, 2).setNumberFormat('yyyy-mm-dd');
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 320);
  sheet.setColumnWidth(3, 520);
  sheet.setFrozenRows(1);

  // Warn (not block) anyone editing the labels the script depends on.
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(p => p.remove());
  sheet.getRange(1, 1, rows.length, 1).protect()
    .setDescription('Labels used by the script. Edit the values in column B instead.')
    .setWarningOnly(true);
}

/** Reads the Settings tab into {key: value}, with defaults for anything missing. */
function getSettings_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    setupSettings_();
    throw new Error('There was no Settings tab, so one has been created. Paste the CSV folder link into it and run again.');
  }
  const tz = ss.getSpreadsheetTimeZone();
  const values = {};
  sheet.getDataRange().getValues().forEach(r => { values[String(r[0]).trim()] = r[1]; });

  const settings = {};
  SETTINGS.forEach(([key, label, def]) => {
    let v = label in values && values[label] !== '' ? values[label] : def;
    if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (typeof def === 'number') {
      v = Number(v);
      if (isNaN(v) || v < 0) throw new Error(`Settings: "${label}" must be a number of 0 or more.`);
    }
    settings[key] = v;
  });
  if (dayNum_(settings.asOfDate) === null) {
    throw new Error('Settings: "As-of date" must be a date such as 2014-08-03.');
  }
  settings.csvFolderId = extractDriveId_(settings.csvFolder);
  return settings;
}
