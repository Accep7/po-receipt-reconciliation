/**
 * Menu.gs — the "PO Reconciliation" menu, the full pipeline, and the run wrapper.
 *
 * Every run takes a document lock, so two people pressing the button at the same time
 * can't overwrite each other's results (the other person gets a "try again" message),
 * and every run is recorded on the Run Log tab.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PO Reconciliation')
    .addItem('Run everything', 'runAll')
    .addSeparator()
    .addItem('1. Import CSVs from Drive', 'menuImport')
    .addItem('2. Reconcile POs vs receipts', 'menuReconcile')
    .addItem('3. Check inventory risk', 'menuInventory')
    .addItem('4. Create report email draft', 'menuReport')
    .addSeparator()
    .addItem('Turn on daily run', 'enableDailyRun')
    .addItem('Turn off daily run', 'disableDailyRun')
    .addItem('Set up Settings tab', 'setupSettings')
    .addToUi();
}

/** Import -> reconcile -> inventory -> summary -> (optional) report draft. */
function runPipeline_(source) {
  const settings = getSettings_();
  const imported = importCsvs_();
  console.log(imported.join('\n'));
  const recon = runReconciliation_();
  const inventory = runInventoryRisk_();
  writeSummary_();
  if (source === 'Menu') arrangeTabs_();

  const wantDraft = settings.reportMode === 'Every run' ||
    (settings.reportMode === 'Scheduled runs only' && source === 'Schedule');
  const draft = wantDraft ? ' ' + createReportDraft_() : '';
  return `${recon} ${inventory}${draft}`;
}

function runAll() {
  runSafely_('Run everything', () => runPipeline_('Menu'));
}

function menuImport() {
  runSafely_('Import CSVs', () => importCsvs_().join(' · '));
}

function menuReconcile() {
  runSafely_('Reconcile', () => {
    const msg = runReconciliation_();
    writeSummary_();
    return msg;
  });
}

function menuInventory() {
  runSafely_('Inventory risk', () => {
    const msg = runInventoryRisk_();
    writeSummary_();
    return msg;
  });
}

function menuReport() {
  runSafely_('Report draft', () => createReportDraft_());
}

/** Lock, progress toast, Run Log entry, and a readable error message instead of a stack trace. */
function runSafely_(action, fn) {
  const ss = SpreadsheetApp.getActive();
  const started = Date.now();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30 * 1000)) {
    SpreadsheetApp.getUi().alert('Someone else is running the tool right now. Please try again in a minute.');
    return;
  }
  try {
    ss.toast(`${action}…`, 'PO Reconciliation', -1);
    const message = fn() || 'Done.';
    logRun_('Menu', action, 'OK', message, started);
    ss.toast(message, 'PO Reconciliation', 10);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    logRun_('Menu', action, 'Error', message, started);
    console.error(e && e.stack ? e.stack : e);
    ss.toast('Stopped with an error.', 'PO Reconciliation', 3);
    SpreadsheetApp.getUi().alert('The run stopped:\n\n' + message);
  } finally {
    lock.releaseLock();
  }
}

/** Puts the tabs people read first in front and the raw data at the back. */
function arrangeTabs_() {
  const ss = SpreadsheetApp.getActive();
  const order = ['Summary', 'Exceptions', 'Inventory Risk', 'Reconciliation', 'Receipt Matching', 'Settings', RUN_LOG_SHEET]
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
