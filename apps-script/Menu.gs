/**
 * Menu.gs — the "PO Reconciliation" menu and the run wrapper.
 *
 * Every run takes a document lock, so two people pressing the button at the same time
 * can't overwrite each other's results (the other person gets a "try again" message).
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PO Reconciliation')
    .addItem('Run everything', 'runAll')
    .addSeparator()
    .addItem('1. Import CSVs from Drive', 'menuImport')
    .addItem('2. Reconcile POs vs receipts', 'menuReconcile')
    .addItem('3. Check inventory risk', 'menuInventory')
    .addSeparator()
    .addItem('Set up Settings tab', 'setupSettings')
    .addToUi();
}

function runAll() {
  runSafely_('Importing and checking…', () => {
    const imported = importCsvs_();
    const recon = runReconciliation_();
    const inventory = runInventoryRisk_();
    writeSummary_();
    arrangeTabs_();
    console.log(imported.join('\n'));
    return `${recon} ${inventory}`;
  });
}

function menuImport() {
  runSafely_('Importing CSVs…', () => importCsvs_().join(' · '));
}

function menuReconcile() {
  runSafely_('Reconciling…', () => {
    const msg = runReconciliation_();
    writeSummary_();
    return msg;
  });
}

function menuInventory() {
  runSafely_('Checking inventory…', () => {
    const msg = runInventoryRisk_();
    writeSummary_();
    return msg;
  });
}

/** Lock, progress toast, friendly error message instead of a stack trace. */
function runSafely_(startMessage, fn) {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30 * 1000)) {
    SpreadsheetApp.getUi().alert('Someone else is running the tool right now. Please try again in a minute.');
    return;
  }
  try {
    ss.toast(startMessage, 'PO Reconciliation', -1);
    const message = fn();
    ss.toast(message || 'Done.', 'PO Reconciliation', 10);
  } catch (e) {
    ss.toast('Stopped with an error.', 'PO Reconciliation', 3);
    console.error(e && e.stack ? e.stack : e);
    SpreadsheetApp.getUi().alert('The run stopped:\n\n' + (e && e.message ? e.message : e));
  } finally {
    lock.releaseLock();
  }
}

/** Puts the tabs people read first in front and the raw data at the back. */
function arrangeTabs_() {
  const ss = SpreadsheetApp.getActive();
  const order = ['Summary', 'Exceptions', 'Inventory Risk', 'Reconciliation', 'Receipt Matching', 'Settings']
    .concat(Object.keys(CSV_TABS).map(f => CSV_TABS[f]));
  let position = 1;
  order.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(position++);
  });
  const summary = ss.getSheetByName('Summary');
  if (summary) ss.setActiveSheet(summary);
}
