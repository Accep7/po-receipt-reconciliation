/**
 * Tracking.gs — turns the Exceptions tab into a work queue that survives reruns.
 *
 * People fill in status, owner and comment on the Exceptions tab. On the next run every
 * exception that is still detected keeps those values (matched by its stable key), new ones
 * start as "Open", and ones that disappeared (fixed at the source) are counted as cleared.
 * Several people or sub-teams can share one tab: filter by owner instead of copying sheets.
 */

const TRACK_STATUSES = ['Open', 'In progress', 'Resolved', "Won't fix"];
const CLOSED_STATUSES = ['Resolved', "Won't fix"];

/**
 * @param {Object[]} exceptions  this run's exceptions, each with a .key
 * @param {Map<string, Object>} previous  key -> {status, owner, comment, first_seen} from the last run
 * @param {string} today  "yyyy-mm-dd"
 * @return {{rows: Object[], stats: Object}}
 */
function mergeTracking_(exceptions, previous, today) {
  const seen = new Set();
  let added = 0;
  const rows = exceptions.map(e => {
    const p = previous.get(e.key);
    seen.add(e.key);
    if (!p) added++;
    return Object.assign({}, e, {
      status: p && TRACK_STATUSES.indexOf(p.status) !== -1 ? p.status : 'Open',
      owner: p ? p.owner : '',
      comment: p ? p.comment : '',
      first_seen: p && p.first_seen ? p.first_seen : today,
    });
  });

  let cleared = 0;
  previous.forEach((_, key) => { if (!seen.has(key)) cleared++; });

  const isClosed = r => CLOSED_STATUSES.indexOf(r.status) !== -1;
  rows.sort((a, b) =>
    (isClosed(a) - isClosed(b)) ||
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) ||
    (num_(b.value_impact) - num_(a.value_impact)));

  const openBySeverity = { High: 0, Medium: 0, Low: 0 };
  let closed = 0;
  rows.forEach(r => {
    if (isClosed(r)) closed++;
    else openBySeverity[r.severity]++;
  });

  return {
    rows,
    stats: {
      open: rows.length - closed,
      openBySeverity,
      closedStillDetected: closed,
      newThisRun: added,
      clearedSinceLastRun: cleared,
      firstRun: previous.size === 0,
    },
  };
}

/** Status, owner, comment and first-seen date from the current Exceptions tab, keyed by exception key. */
function readTracking_() {
  const map = new Map();
  const sheet = SpreadsheetApp.getActive().getSheetByName('Exceptions');
  if (!sheet || sheet.getLastRow() < 2) return map;
  const rows = readTable_('Exceptions');
  if (!rows.length || !('key' in rows[0])) return map;   // tab from before tracking existed
  rows.forEach(r => {
    if (!r.key) return;
    map.set(String(r.key), {
      status: String(r.status || ''),
      owner: String(r.owner || ''),
      comment: String(r.comment || ''),
      first_seen: r.first_seen || '',
    });
  });
  return map;
}
