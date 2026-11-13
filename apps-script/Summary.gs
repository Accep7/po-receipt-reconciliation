/**
 * Summary.gs — one-page overview built from the latest reconciliation and inventory runs.
 */

/** Pure: turns the saved stats into rows of [label, value, note]. Section titles have value === null. */
function buildSummaryRows_(recon, inventory) {
  const rows = [];
  const section = title => rows.push([title, null, '']);
  const row = (label, value, note) => rows.push([label, value, note || '']);
  const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '');

  if (recon && recon.tracking) {
    const t = recon.tracking;
    section('Work queue (Exceptions tab)');
    row('Open exceptions', t.open);
    row('  high', t.openBySeverity.High);
    row('  medium', t.openBySeverity.Medium);
    row('  low', t.openBySeverity.Low);
    row('New since last run', t.firstRun ? '' : t.newThisRun, t.firstRun ? 'first tracked run' : '');
    row('Cleared since last run', t.firstRun ? '' : t.clearedSinceLastRun, 'no longer detected, e.g. fixed at the source');
    row("Marked resolved / won't fix, still detected", t.closedStillDetected);
  }

  if (recon) {
    const m = recon.matchCounts;
    const ok = recon.byStatus.OK || 0;
    section('PO vs receipt reconciliation');
    row('As-of date', recon.asOfDate);
    row('PO lines checked', recon.poLines);
    row('Lines fully matched (OK)', ok, pct(ok, recon.poLines));
    row('Lines with an exception', recon.byStatus.Exception || 0, pct(recon.byStatus.Exception || 0, recon.poLines));
    row('Open lines not yet due', recon.byStatus['Open, not yet due'] || 0);
    row('Warehouse receipts', recon.receipts);
    row('  matched exactly', m.exact, pct(m.exact, recon.receipts));
    row('  matched after cleanup (case, hyphens, O/0)', m.normalized, pct(m.normalized, recon.receipts));
    row('  matched despite a typo', m.fuzzy, pct(m.fuzzy, recon.receipts));
    row('  duplicates set aside', m.duplicate);
    row('  could not be matched', m.unmatched);

    section('Exceptions by type');
    Object.keys(recon.byIssue)
      .sort((a, b) => (SEVERITY_RANK[recon.byIssue[b].severity] - SEVERITY_RANK[recon.byIssue[a].severity]) ||
        recon.byIssue[b].count - recon.byIssue[a].count)
      .forEach(label => {
        const t = recon.byIssue[label];
        row(label, t.count, `${t.severity}` + (t.value ? ` · value ${money_(t.value)}` : ''));
      });

    if (recon.topVendors.length) {
      section('Vendors with most high/medium exceptions');
      recon.topVendors.forEach(([name, count, value]) =>
        row(name, count, `value ${money_(value)}`));
    }
  }

  if (inventory) {
    section('Inventory risk');
    row('Products checked', inventory.productsChecked);
    row('High risk', inventory.byRisk.High);
    row('Medium risk', inventory.byRisk.Medium);
    row('Low risk', inventory.byRisk.Low);
    Object.keys(inventory.byFlag)
      .sort((a, b) => inventory.byFlag[b] - inventory.byFlag[a])
      .forEach(flag => row(`  ${flag}`, inventory.byFlag[flag]));
    row('Value of slow / discontinued stock', inventory.slowStockValue, 'at standard cost');
  }
  return rows;
}

function writeSummary_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('Summary') || ss.insertSheet('Summary', 0);
  const recon = loadStats_('recon');
  const inventory = loadStats_('inventory');
  const rows = buildSummaryRows_(recon, inventory);

  sheet.clear();
  const tz = ss.getSpreadsheetTimeZone();
  const lastRun = [recon && recon.ranAt, inventory && inventory.ranAt].filter(Boolean).sort().pop();
  sheet.getRange(1, 1, 2, 1).setValues([
    ['PO Reconciliation & Inventory Risk'],
    [lastRun ? `Last run ${Utilities.formatDate(new Date(lastRun), tz, 'yyyy-MM-dd HH:mm')}` : 'Not run yet'],
  ]);
  sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sheet.getRange(2, 1).setFontColor('#5f6368');
  if (!rows.length) return;

  const start = 4;
  sheet.getRange(start, 1, rows.length, 3)
    .setValues(rows.map(r => [r[0], r[1] === null ? '' : r[1], r[2]]));
  sheet.getRange(start, 2, rows.length, 1).setHorizontalAlignment('right');
  rows.forEach((r, i) => {
    if (r[1] === null) {
      sheet.getRange(start + i, 1, 1, 3).setFontWeight('bold').setBackground('#e8f0fe');
    }
  });
  sheet.setColumnWidth(1, 330);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 260);
  sheet.getRange(start, 3, rows.length, 1).setFontColor('#5f6368');
}
