/**
 * Schedule.gs — the daily run and the Run Log tab.
 *
 * The daily run uses a time-driven trigger owned by whoever turned it on. If it fails,
 * Google emails that person automatically, and the Run Log tab records the error.
 */

const DAILY_HANDLER = 'scheduledRun';
const RUN_LOG_SHEET = 'Run Log';
const RUN_LOG_MAX_ROWS = 500;

/** Called by the time-driven trigger. No UI is available here: no toasts, no alerts. */
function scheduledRun() {
  const started = Date.now();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5 * 60 * 1000)) {
    logRun_('Schedule', 'Daily run', 'Skipped', 'Another run was still in progress.', started);
    return;
  }
  try {
    const message = runPipeline_('Schedule');
    logRun_('Schedule', 'Daily run', 'OK', message, started);
  } catch (e) {
    logRun_('Schedule', 'Daily run', 'Error', e && e.message ? e.message : String(e), started);
    throw e;   // so Google's failure email still goes out
  } finally {
    lock.releaseLock();
  }
}

function enableDailyRun() {
  runSafely_('Turn on daily run', () => {
    const hour = getSettings_().dailyRunHour;
    removeDailyTriggers_();
    ScriptApp.newTrigger(DAILY_HANDLER).timeBased().everyDays(1).atHour(hour).nearMinute(0).create();
    return `Daily run is on: every day around ${hour}:00 (${Session.getScriptTimeZone()}).`;
  });
}

function disableDailyRun() {
  runSafely_('Turn off daily run', () => {
    const removed = removeDailyTriggers_();
    return removed ? 'Daily run is off.' : 'The daily run was not on.';
  });
}

function removeDailyTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === DAILY_HANDLER)
    .forEach(t => { ScriptApp.deleteTrigger(t); removed++; });
  return removed;
}

/** Appends one row to the Run Log tab. Never lets a logging problem break a run. */
function logRun_(source, action, result, message, startedMs) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sheet = ss.getSheetByName(RUN_LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(RUN_LOG_SHEET);
      sheet.getRange(1, 1, 1, 7).setValues([['started', 'source', 'user', 'action', 'result', 'seconds', 'message']])
        .setFontWeight('bold').setBackground('#e8f0fe');
      sheet.setFrozenRows(1);
      sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
      sheet.setColumnWidth(7, 600);
      sheet.setTabColor('#9aa0a6');
    }
    let user = '';
    try { user = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(); } catch (e) { /* not available */ }
    sheet.appendRow([new Date(startedMs), source, user, action, result,
      Math.round((Date.now() - startedMs) / 100) / 10, message]);
    const extra = sheet.getLastRow() - 1 - RUN_LOG_MAX_ROWS;
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (e) {
    console.warn('Run Log write failed: ' + e);
  }
}
