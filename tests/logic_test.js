// Local tests for the Apps Script logic, run with Deno:
//   deno test --allow-read tests/
//
// The pure functions in apps-script/*.gs are loaded as-is (no copies), fed the same CSVs
// the Sheet imports, and checked against tests/data/answer_key.csv, which lists the
// mistake planted on every PO line by sql/02_warehouse_receipts.sql.

const root = new URL('../', import.meta.url);
const read = path => Deno.readTextFileSync(new URL(path, root));

const gs = new Function(
  ['Utils.gs', 'Matching.gs', 'Reconcile.gs', 'InventoryRisk.gs', 'Summary.gs', 'Tracking.gs', 'Report.gs']
    .map(f => read(`apps-script/${f}`)).join('\n') +
  '\nreturn { matchSku_, normalizeSku_, editDistance_, reconcile_, assessInventory_, buildSummaryRows_, mergeTracking_, buildReport_, toCsv_, parseEmails_ };',
)();

// Same typing rules as Import.gs.
const TEXT_COLUMNS = ['receipt_id', 'po_ref', 'sku', 'sku_entered', 'shelf', 'bin'];
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  return rows.filter(r => r.some(v => v !== '')).map(r => {
    const o = {};
    headers.forEach((h, i) => {
      const v = r[i] ?? '';
      o[h] = v === '' || TEXT_COLUMNS.includes(h) || /(_date|_due)$/.test(h) || !/^-?\d+(\.\d+)?$/.test(v) ? v : Number(v);
    });
    return o;
  });
}
const csv = path => parseCsv(read(path));

const settings = {
  asOfDate: '2014-08-03', lateToleranceDays: 0, countToleranceUnits: 0,
  maxSkuEdits: 1, poSuggestWindowDays: 7, slowMoverDays: 180,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test('All .gs files load together (Apps Script shares one global scope)', () => {
  const files = [...Deno.readDirSync(new URL('apps-script/', root))].filter(f => f.name.endsWith('.gs'));
  // Throws on a syntax error or on the same const declared in two files.
  new Function(files.map(f => read(`apps-script/${f.name}`)).join('\n'));
  assert(files.length >= 12, 'expected all modules');
});

Deno.test('SKU matching: tolerant but not reckless', () => {
  const onPo = ['FW-7160', 'FW-9160', 'HL-U509-R'];
  const cases = [
    ['FW-7160', 'FW-7160', 'exact'],
    ['fw-7160', 'FW-7160', 'normalized'],
    ['FW7160', 'FW-7160', 'normalized'],
    [' FW-716O ', 'FW-7160', 'normalized'],     // letter O, stray spaces
    ['FW-1760', 'FW-7160', 'fuzzy'],             // swapped neighbours
    ['HL-U509', 'HL-U509-R', 'fuzzy'],           // last character cut off
    ['FW-8160', null, 'ambiguous'],              // one edit from both FW-7160 and FW-9160
    ['CA-1098', null, 'none'],
  ];
  for (const [typed, expected, method] of cases) {
    const m = gs.matchSku_(typed, onPo, 1);
    assert(m.sku === expected && m.method === method,
      `${typed}: expected ${expected}/${method}, got ${m.sku}/${m.method}`);
  }
  assert(gs.editDistance_('AB', 'BA') === 1, 'a swap counts as one edit');
});

Deno.test('Reconciliation finds every planted mistake on the sample data', () => {
  const poLines = csv('data/po_lines.csv');
  const receipts = csv('data/warehouse_receipts.csv');
  const key = csv('tests/data/answer_key.csv');
  const result = gs.reconcile_(poLines, receipts, settings);

  const byReceipt = new Map(result.receipts.map(x => [x.receipt.receipt_id, x]));
  const lineById = new Map(poLines.map(l => [l.po_line_id, l]));
  // Two lines on one PO with the same SKU are interchangeable, so "right line" means same PO + SKU.
  const sameLine = (a, b) => lineById.get(a)?.po_id === lineById.get(b)?.po_id && lineById.get(a)?.sku === lineById.get(b)?.sku;
  const issuesByLine = new Map();
  result.exceptions.forEach(e => {
    if (e.po_line_id === '') return;
    const k = String(e.po_line_id);
    if (!issuesByLine.has(k)) issuesByLine.set(k, new Set());
    issuesByLine.get(k).add(e.type);
  });
  const has = (lineId, type) => issuesByLine.get(String(lineId))?.has(type) ?? false;

  const tally = {};
  const count = (name, ok) => {
    tally[name] ??= { caught: 0, total: 0 };
    tally[name].total++;
    if (ok) tally[name].caught++;
  };
  let wrongMatches = 0;
  let falseAlarms = 0;

  for (const k of key) {
    const lineId = k.po_line_id;
    const receipt = k.receipt_id ? byReceipt.get(k.receipt_id) : null;

    // Any receipt that did get matched must sit on the right PO line.
    if (receipt && receipt.lineId !== '' && !sameLine(receipt.lineId, lineId)) wrongMatches++;

    if (!k.receipt_id && k.planted_error !== 'missing_receipt') {
      // Receipt date fell after the as-of date: it should show as missing, not be silently ignored.
      count('received after as-of date -> no receipt', has(lineId, 'MISSING_RECEIPT'));
      continue;
    }
    switch (k.planted_error) {
      case 'sku_typo':
        if (receipt.method === 'unmatched') {
          // e.g. "LJ-516" when the PO has both LJ-5161 and LJ-5162: must go to a person, naming the right SKU.
          count('mistyped SKU, 2 close options -> sent to review',
            receipt.note.includes(lineById.get(lineId).sku) && has(lineId, 'MISSING_RECEIPT'));
        } else {
          count('mistyped SKU -> matched to right line', sameLine(receipt.lineId, lineId) && receipt.method !== 'exact');
        }
        break;
      case 'short_count':
        count('short count -> count mismatch', has(lineId, 'COUNT_MISMATCH'));
        break;
      case 'over_count':
        count('over count -> over-received / mismatch', has(lineId, 'OVER_RECEIVED') || has(lineId, 'COUNT_MISMATCH'));
        break;
      case 'missing_receipt':
        count('missing receipt -> flagged', has(lineId, 'MISSING_RECEIPT'));
        break;
      case 'duplicate':
        count('duplicate scan -> set aside', byReceipt.get(k.duplicate_receipt_id)?.method === 'duplicate'
          && !has(lineId, 'COUNT_MISMATCH') && !has(lineId, 'OVER_RECEIVED'));
        break;
      case 'po_typo':
        count('mistyped PO -> flagged', receipt.method === 'unmatched' && has(lineId, 'MISSING_RECEIPT'));
        count('mistyped PO -> right PO suggested', receipt.suggestedLineId === lineId);
        break;
      case 'clean':
        if (['COUNT_MISMATCH', 'OVER_RECEIVED', 'MISSING_RECEIPT'].some(t => has(lineId, t))) falseAlarms++;
        break;
    }
    if (Number(k.planted_late) === 1 && k.receipt_id && k.planted_error !== 'po_typo') {
      count('late delivery -> flagged', has(lineId, 'LATE_DELIVERY'));
    }
  }

  const line = (label, value) => console.log(`  ${label.padEnd(52)}${value}`);
  console.log('');
  line('check', 'caught / planted');
  for (const [name, t] of Object.entries(tally)) line(name, `${String(t.caught).padStart(5)} / ${t.total}`);
  line('receipts matched to the wrong line', wrongMatches);
  line('false alarms on clean lines', falseAlarms);
  line('exceptions by severity', JSON.stringify(result.stats.bySeverity));
  line('receipt matching', JSON.stringify(result.stats.matchCounts));
  console.log('');

  assert(wrongMatches === 0, `${wrongMatches} receipts matched to the wrong PO line`);
  assert(falseAlarms === 0, `${falseAlarms} quantity alarms on lines with no planted mistake`);
  for (const [name, t] of Object.entries(tally)) {
    if (name === 'mistyped PO -> right PO suggested') continue;   // best effort, reported above
    assert(t.caught === t.total, `${name}: only ${t.caught} of ${t.total}`);
  }
  const m = result.stats.matchCounts;
  assert(m.exact + m.normalized + m.fuzzy + m.duplicate + m.unmatched === receipts.length, 'every receipt is accounted for');
});

Deno.test('Inventory risk runs on the sample data and explains every flag', () => {
  const result = gs.assessInventory_(csv('data/product_master.csv'), csv('data/inventory_by_location.csv'), settings);
  assert(result.items.length > 0, 'something should be flagged');
  for (const it of result.items) {
    assert(['High', 'Medium', 'Low'].includes(it.risk), `bad risk level on ${it.sku}`);
    assert(it.flags.length > 0, `${it.sku} flagged without a reason`);
  }
  console.log(`\n  inventory: ${JSON.stringify(result.stats.byRisk)}  ${JSON.stringify(result.stats.byFlag)}\n`);

  const rows = gs.buildSummaryRows_(null, result.stats);
  assert(rows.some(r => r[0] === 'Products checked'), 'summary has an inventory section');
});

Deno.test('Exception keys are unique, so tracked comments never land on the wrong row', () => {
  const result = gs.reconcile_(csv('data/po_lines.csv'), csv('data/warehouse_receipts.csv'), settings);
  const keys = result.exceptions.map(e => e.key);
  assert(keys.every(Boolean), 'every exception has a key');
  assert(new Set(keys).size === keys.length, `${keys.length - new Set(keys).size} duplicate keys`);
});

Deno.test('Tracking keeps status/owner/comment across runs and counts new and cleared', () => {
  const exc = (key, severity, value) => ({ key, severity, value_impact: value, type: 'COUNT_MISMATCH' });
  const run1 = gs.mergeTracking_([exc('A', 'High', 10), exc('B', 'Medium', 5), exc('C', 'Low', 0)], new Map(), '2026-11-13');
  assert(run1.stats.firstRun && run1.rows.every(r => r.status === 'Open' && r.first_seen === '2026-11-13'), 'first run: all open');

  // People work the queue between runs.
  const previous = new Map([
    ['A', { status: 'In progress', owner: 'AK', comment: 'Asked vendor', first_seen: '2026-11-13' }],
    ['B', { status: 'Resolved', owner: 'MT', comment: 'ERP corrected', first_seen: '2026-11-13' }],
    ['C', { status: 'Open', owner: '', comment: '', first_seen: '2026-11-13' }],
  ]);
  // Next run: A and B still detected, C fixed at the source, D is new.
  const run2 = gs.mergeTracking_([exc('B', 'Medium', 5), exc('A', 'High', 10), exc('D', 'High', 99)], previous, '2026-11-14');
  const byKey = Object.fromEntries(run2.rows.map(r => [r.key, r]));

  assert(byKey.A.status === 'In progress' && byKey.A.owner === 'AK' && byKey.A.comment === 'Asked vendor', 'A keeps its notes');
  assert(byKey.A.first_seen === '2026-11-13' && byKey.D.first_seen === '2026-11-14', 'first_seen kept / set');
  assert(byKey.D.status === 'Open', 'new exception starts Open');
  assert(run2.stats.newThisRun === 1 && run2.stats.clearedSinceLastRun === 1, 'one new, one cleared');
  assert(run2.stats.closedStillDetected === 1 && run2.stats.open === 2, 'B is closed, A and D open');
  assert(run2.rows.map(r => r.key).join('') === 'DAB', 'open first, by severity and value; closed last');

  const bad = gs.mergeTracking_([exc('A', 'High', 1)], new Map([['A', { status: 'Done??', owner: '', comment: '' }]]), 'x');
  assert(bad.rows[0].status === 'Open', 'unknown status falls back to Open');
});

Deno.test('Report email: escaped, honest about truncation, attachment CSV quoted', () => {
  const recon = {
    poLines: 10, byStatus: { OK: 7 },
    tracking: { open: 3, openBySeverity: { High: 3, Medium: 0, Low: 0 }, newThisRun: 1, clearedSinceLastRun: 2, closedStillDetected: 0, firstRun: false },
  };
  const openHigh = [1, 2, 3].map(i => ({
    issue: 'Count differs from ERP', po_id: 100 + i, po_line_id: i, vendor: 'Trikes, Inc. & <Sons>',
    sku: 'FW-7160', qty_diff: -1, value_impact: 1234.5, detail: 'Warehouse counted 2, ERP shows 3', owner: '',
  }));
  const r = gs.buildReport_({
    asOfDate: '2014-08-03', runDate: '2026-11-13 07:00', sheetUrl: 'https://docs.google.com/spreadsheets/d/x',
    recon, inventory: { byRisk: { High: 1, Medium: 2, Low: 0 } }, openHigh, highRisk: [], maxRows: 2,
  });
  assert(r.subject === 'PO reconciliation as of 2014-08-03: 3 high-priority exceptions, 1 new', `subject: ${r.subject}`);
  assert(r.html.includes('Trikes, Inc. &amp; &lt;Sons&gt;') && !r.html.includes('<Sons>'), 'vendor names are escaped');
  assert(r.html.includes('top 2 of 3 by value'), 'says when the list is cut');
  assert(r.html.includes('1,234.50'), 'money formatted');

  const csvText = gs.toCsv_(['vendor', 'detail'], [{ vendor: 'Trikes, Inc.', detail: 'said "short"' }]);
  assert(csvText === 'vendor,detail\r\n"Trikes, Inc.","said ""short"""', `csv: ${csvText}`);

  assert(gs.parseEmails_('a@x.com; b@y.co.jp,  c@z.com').length === 3, 'emails split on , ; and spaces');
  let threw = false;
  try { gs.parseEmails_('not-an-address'); } catch (_) { threw = true; }
  assert(threw, 'bad address rejected');
});
