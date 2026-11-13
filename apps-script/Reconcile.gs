/**
 * Reconcile.gs — matches warehouse receipts to PO lines and lists every discrepancy.
 *
 * reconcile_() is pure: plain objects in, plain objects out. runReconciliation_()
 * does the Sheets reading and writing around it.
 */

const ISSUES = {
  MISSING_RECEIPT:        { label: 'No warehouse receipt',   severity: 'High',   action: 'Find the delivery paperwork, or correct the ERP receipt' },
  COUNT_MISMATCH:         { label: 'Count differs from ERP', severity: 'High',   action: 'Recount the stock, then correct the ERP or the receipt' },
  OVER_RECEIVED:          { label: 'Over-received',          severity: 'High',   action: 'Confirm with the vendor: return the extra or amend the PO' },
  UNKNOWN_PO:             { label: 'PO number not found',    severity: 'High',   action: 'Check the PO number on the delivery note' },
  UNKNOWN_SKU:            { label: 'SKU not matched on PO',  severity: 'High',   action: 'Check the item code on the delivery note' },
  SHORT_SHIPPED:          { label: 'Short shipped',          severity: 'Medium', action: 'Ask the vendor for a backorder date or a credit note' },
  REJECTED:               { label: 'Rejected at receiving',  severity: 'Medium', action: 'Raise a return / claim with the vendor' },
  OVERDUE_OPEN:           { label: 'Open PO overdue',        severity: 'Medium', action: 'Chase the vendor for a delivery date' },
  DUPLICATE_RECEIPT:      { label: 'Duplicate receipt',      severity: 'Medium', action: 'Delete the duplicate entry (already left out of totals)' },
  LATE_DELIVERY:          { label: 'Late delivery',          severity: 'Low',    action: 'Log against vendor delivery performance' },
  SKU_CORRECTED:          { label: 'SKU typed differently',  severity: 'Low',    action: 'No stock impact; fix the SKU on the receipt record' },
};

const SEVERITY_RANK = { High: 3, Medium: 2, Low: 1 };

/**
 * @param {Object[]} poLines   rows of raw_po_lines
 * @param {Object[]} receipts  rows of raw_receipts
 * @param {Object}   settings  from getSettings_()
 * @return {{lines: Object[], receipts: Object[], exceptions: Object[], stats: Object}}
 */
function reconcile_(poLines, receipts, settings) {
  const asOf = dayNum_(settings.asOfDate);
  const recs = poLines.map(line => ({
    line, receiptIds: [], whQty: 0, firstReceipt: null, methods: [], hints: [],
  }));
  const byPo = new Map();
  const byNormSku = new Map();
  recs.forEach(rec => {
    pushTo_(byPo, String(rec.line.po_id), rec);
    pushTo_(byNormSku, normalizeSku_(rec.line.sku), rec);
  });

  const exceptions = [];
  const receiptResults = [];
  const unmatched = [];
  const matchCounts = { exact: 0, normalized: 0, fuzzy: 0, duplicate: 0, unmatched: 0 };
  const seen = new Map();

  // Pass 1: match each receipt to a PO line on the PO it names.
  receipts.forEach(r => {
    const poRef = String(r.po_ref).trim();
    const qty = num_(r.qty_received);
    const result = { receipt: r, method: '', lineId: '', matchedSku: '', note: '' };
    receiptResults.push(result);

    const poRecs = byPo.get(poRef);
    const match = poRecs
      ? matchSku_(r.sku_entered, unique_(poRecs.map(x => x.line.sku)), settings.maxSkuEdits)
      : null;

    // Same PO, SKU, quantity and day as an earlier receipt = scanned twice. Unless the PO has
    // another line for that SKU still waiting for a receipt: then it's a genuine second delivery.
    const dupKey = [poRef, normalizeSku_(r.sku_entered), qty, r.receipt_date].join('|');
    const freeLine = match && match.sku ? poRecs.find(x => x.line.sku === match.sku && x.receiptIds.length === 0) : null;
    if (seen.has(dupKey) && !freeLine) {
      matchCounts.duplicate++;
      result.method = 'duplicate';
      result.note = `Same PO, SKU, quantity and date as ${seen.get(dupKey)}`;
      exceptions.push(receiptException_('DUPLICATE_RECEIPT', r, result.note, qty, null));
      return;
    }
    if (!seen.has(dupKey)) seen.set(dupKey, r.receipt_id);

    if (!match || !match.sku) {
      matchCounts.unmatched++;
      result.method = 'unmatched';
      unmatched.push({ r, result, poRecs, match });
      return;
    }

    matchCounts[match.method]++;
    const rec = freeLine || poRecs.find(x => x.line.sku === match.sku);
    const day = dayNum_(r.receipt_date);
    rec.receiptIds.push(r.receipt_id);
    rec.whQty += qty;
    rec.methods.push(match.method);
    if (day !== null && (rec.firstReceipt === null || day < rec.firstReceipt)) rec.firstReceipt = day;

    result.method = match.method;
    result.lineId = rec.line.po_line_id;
    result.matchedSku = match.sku;
    if (match.method !== 'exact') {
      result.note = `Typed "${r.sku_entered}", matched to ${match.sku}` +
        (match.method === 'fuzzy' ? ` (${match.distance} edit${match.distance > 1 ? 's' : ''})` : '');
      exceptions.push(lineException_('SKU_CORRECTED', rec.line, `${r.receipt_id}: ${result.note}`, 0, [r.receipt_id]));
    }
  });

  // Pass 2: for receipts that matched nothing, suggest the PO line they most likely belong to.
  unmatched.forEach(({ r, result, poRecs, match }) => {
    const hint = suggestLine_(r, byNormSku, settings.poSuggestWindowDays);
    let note;
    if (!poRecs) note = `PO ${r.po_ref} is not in the PO extract`;
    else if (match.method === 'ambiguous') note = `"${r.sku_entered}" could be ${match.candidates.join(' or ')}`;
    else note = `PO ${r.po_ref} has ${unique_(poRecs.map(x => x.line.sku)).join(', ')}`;
    if (hint) {
      note += `. Likely PO ${hint.line.po_id} line ${hint.line.po_line_id} (${hint.line.sku}, shipped ${hint.line.vendor_ship_date})`;
      hint.hints.push(`${r.receipt_id} entered under PO ${r.po_ref} may belong here`);
      result.suggestedLineId = hint.line.po_line_id;
    }
    result.note = note;
    exceptions.push(receiptException_(poRecs ? 'UNKNOWN_SKU' : 'UNKNOWN_PO', r, note, num_(r.qty_received), hint && hint.line));
  });

  // Pass 3: check every PO line.
  const lines = recs.map(rec => {
    const l = rec.line;
    const ordered = num_(l.ordered_qty);
    const erpRec = num_(l.erp_received_qty);
    const erpRej = num_(l.erp_rejected_qty);
    const due = dayNum_(l.due_date);
    const open = l.po_status === 'Pending' || l.po_status === 'Approved';
    const hasReceipt = rec.receiptIds.length > 0;
    const issues = [];
    const add = (type, detail, qtyDiff, severity) =>
      issues.push(lineException_(type, l, detail, qtyDiff, rec.receiptIds, severity));

    // In AdventureWorks a "Rejected" PO is a delivery that was refused at receiving
    // (received = rejected), so it gets the same receipt checks as any other line.
    if (erpRec > 0 && !hasReceipt) {
      add('MISSING_RECEIPT', `ERP shows ${erpRec} received; no warehouse receipt` +
        (rec.hints.length ? `. ${rec.hints.join('; ')}` : ''), -erpRec);
    }
    if (hasReceipt && rec.whQty > ordered) {
      add('OVER_RECEIVED', `Warehouse counted ${rec.whQty} vs ${ordered} ordered (ERP shows ${erpRec})`, rec.whQty - ordered);
    } else if (hasReceipt && Math.abs(rec.whQty - erpRec) > settings.countToleranceUnits) {
      add('COUNT_MISMATCH', `Warehouse counted ${rec.whQty}, ERP shows ${erpRec}`, rec.whQty - erpRec);
    }
    if (l.po_status === 'Complete' && erpRec < ordered) {
      add('SHORT_SHIPPED', `${erpRec} of ${ordered} delivered and the PO is closed`, erpRec - ordered);
    }
    if (open && due !== null && due < asOf && erpRec < ordered) {
      add('OVERDUE_OPEN', `${ordered - erpRec} still outstanding, due ${l.due_date} (${asOf - due} days ago)`, erpRec - ordered);
    }
    if (erpRej > 0) add('REJECTED', `${erpRej} of ${erpRec} rejected at receiving`, -erpRej);
    if (rec.firstReceipt !== null && due !== null && rec.firstReceipt - due > settings.lateToleranceDays) {
      const days = rec.firstReceipt - due;
      add('LATE_DELIVERY', `Received ${isoDay_(rec.firstReceipt)}, ${days} days after the due date`, 0, days > 7 ? 'Medium' : 'Low');
    }
    issues.forEach(x => exceptions.push(x));

    let status;
    if (issues.length) status = 'Exception';
    else if (open && erpRec < ordered) status = 'Open, not yet due';
    else status = 'OK';

    return {
      po_id: l.po_id,
      po_line_id: l.po_line_id,
      po_status: l.po_status,
      vendor: l.vendor_name,
      sku: l.sku,
      product: l.product_name,
      order_date: l.order_date,
      due_date: l.due_date,
      ordered_qty: ordered,
      erp_received_qty: erpRec,
      wh_received_qty: hasReceipt ? rec.whQty : '',
      wh_minus_erp: hasReceipt ? rec.whQty - erpRec : '',
      erp_rejected_qty: erpRej,
      first_receipt_date: rec.firstReceipt === null ? '' : isoDay_(rec.firstReceipt),
      days_late: rec.firstReceipt !== null && due !== null ? Math.max(0, rec.firstReceipt - due) : '',
      receipt_ids: rec.receiptIds.join(', '),
      sku_match: unique_(rec.methods).join(', '),
      status,
      issues: issues.map(x => x.issue).join('; '),
    };
  });

  exceptions.sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (num_(b.value_impact) - num_(a.value_impact)));

  return {
    lines,
    receipts: receiptResults,
    exceptions,
    stats: reconStats_(lines, exceptions, matchCounts, receipts.length, settings),
  };
}

/**
 * Receipt that matched nothing: is there a received PO line with this SKU, shipped around
 * the same day, still without a receipt? Closest ship date wins, then closest quantity.
 * If two lines are equally likely, no guess is made.
 */
function suggestLine_(r, byNormSku, windowDays) {
  const day = dayNum_(r.receipt_date);
  if (day === null) return null;
  const qty = num_(r.qty_received);
  const free = (byNormSku.get(normalizeSku_(r.sku_entered)) || [])
    .filter(rec => rec.receiptIds.length === 0 && num_(rec.line.erp_received_qty) > 0)
    .map(rec => ({
      rec,
      gap: Math.abs(day - dayNum_(rec.line.vendor_ship_date)),
      qtyGap: Math.abs(qty - num_(rec.line.erp_received_qty)),
    }))
    .filter(x => x.gap <= windowDays)
    .sort((a, b) => a.gap - b.gap || a.qtyGap - b.qtyGap);
  if (!free.length) return null;
  if (free.length > 1 && free[0].gap === free[1].gap && free[0].qtyGap === free[1].qtyGap) return null;
  return free[0].rec;
}

/**
 * Every exception carries a stable key (issue type + PO line, or + receipt), so status,
 * owner and comments typed into the Exceptions tab survive the next run. See Tracking.gs.
 */
function lineException_(type, l, detail, qtyDiff, receiptIds, severity) {
  const def = ISSUES[type];
  return {
    key: `${type}|L${l.po_line_id}` + (type === 'SKU_CORRECTED' ? `|${(receiptIds || []).join(',')}` : ''),
    severity: severity || def.severity,
    type,
    issue: def.label,
    po_id: l.po_id,
    po_line_id: l.po_line_id,
    vendor: l.vendor_name,
    sku: l.sku,
    product: l.product_name,
    qty_diff: qtyDiff,
    value_impact: round2_(Math.abs(qtyDiff) * num_(l.unit_price)),
    detail,
    receipt_ids: (receiptIds || []).join(', '),
    action: def.action,
  };
}

function receiptException_(type, r, detail, qty, suggestedLine) {
  const def = ISSUES[type];
  return {
    key: `${type}|R${r.receipt_id}`,
    severity: def.severity,
    type,
    issue: def.label,
    po_id: r.po_ref,
    po_line_id: '',
    vendor: suggestedLine ? suggestedLine.vendor_name : '',
    sku: r.sku_entered,
    product: suggestedLine ? suggestedLine.product_name : '',
    qty_diff: qty,
    value_impact: suggestedLine ? round2_(qty * num_(suggestedLine.unit_price)) : '',
    detail,
    receipt_ids: r.receipt_id,
    action: def.action,
  };
}

function reconStats_(lines, exceptions, matchCounts, receiptCount, settings) {
  const byStatus = {};
  lines.forEach(l => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });

  const byIssue = {};
  const bySeverity = { High: 0, Medium: 0, Low: 0 };
  const byVendor = {};
  exceptions.forEach(e => {
    bySeverity[e.severity]++;
    const t = byIssue[e.issue] || (byIssue[e.issue] = { count: 0, value: 0, severity: ISSUES[e.type].severity });
    t.count++;
    t.value = round2_(t.value + num_(e.value_impact));
    if (e.vendor && e.severity !== 'Low') {
      const v = byVendor[e.vendor] || (byVendor[e.vendor] = { count: 0, value: 0 });
      v.count++;
      v.value = round2_(v.value + num_(e.value_impact));
    }
  });
  const topVendors = Object.keys(byVendor)
    .map(name => [name, byVendor[name].count, byVendor[name].value])
    .sort((a, b) => b[1] - a[1] || b[2] - a[2])
    .slice(0, 5);

  return {
    asOfDate: settings.asOfDate,
    poLines: lines.length,
    byStatus,
    receipts: receiptCount,
    matchCounts,
    exceptions: exceptions.length,
    bySeverity,
    byIssue,
    topVendors,
  };
}

/** Reads the raw tabs, runs reconcile_, writes Reconciliation, Receipt Matching and Exceptions. */
function runReconciliation_() {
  const settings = getSettings_();
  const result = reconcile_(readTable_('raw_po_lines'), readTable_('raw_receipts'), settings);

  const lineHeaders = Object.keys(result.lines[0] || { po_id: '' });
  const recon = writeTable_('Reconciliation', lineHeaders, result.lines.map(o => lineHeaders.map(h => o[h])), {
    textColumns: ['sku', 'receipt_ids'],
    formats: { order_date: 'yyyy-mm-dd', due_date: 'yyyy-mm-dd', first_receipt_date: 'yyyy-mm-dd' },
  });
  colorText_(recon, lineHeaders.indexOf('status') + 1, result.lines.length,
    { Exception: ['#fce8e6', '#a50e0e'], OK: ['#e6f4ea', '#137333'] });

  const receiptHeaders = ['receipt_id', 'receipt_date', 'po_ref', 'sku_entered', 'qty_received',
    'match_method', 'matched_po_line_id', 'matched_sku', 'suggested_po_line_id', 'note'];
  const receiptRows = result.receipts.map(x => [
    x.receipt.receipt_id, x.receipt.receipt_date, x.receipt.po_ref, x.receipt.sku_entered, x.receipt.qty_received,
    x.method, x.lineId, x.matchedSku, x.suggestedLineId || '', x.note,
  ]);
  const matching = writeTable_('Receipt Matching', receiptHeaders, receiptRows, {
    textColumns: ['receipt_id', 'po_ref', 'sku_entered', 'matched_sku'],
    formats: { receipt_date: 'yyyy-mm-dd' },
  });
  colorText_(matching, receiptHeaders.indexOf('match_method') + 1, receiptRows.length, {
    normalized: ['#fef7e0', '#7a4f01'], fuzzy: ['#fef7e0', '#7a4f01'],
    duplicate: ['#fce8e6', '#a50e0e'], unmatched: ['#fce8e6', '#a50e0e'],
  });

  writeExceptions_(result);

  saveStats_('recon', result.stats);
  const s = result.stats;
  const t = s.tracking;
  return `Reconciled ${s.poLines} PO lines and ${s.receipts} receipts: ${t.open} open exceptions ` +
    `(${t.openBySeverity.High} high), ${t.newThisRun} new, ${t.clearedSinceLastRun} cleared since last run.`;
}

/** Writes the Exceptions work queue, keeping status / owner / comment from the previous run. */
function writeExceptions_(result) {
  const ss = SpreadsheetApp.getActive();
  const today = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const tracked = mergeTracking_(result.exceptions, readTracking_(), today);
  result.stats.tracking = tracked.stats;

  const headers = ['severity', 'status', 'owner', 'issue', 'po_id', 'po_line_id', 'vendor', 'sku', 'product',
    'qty_diff', 'value_impact', 'detail', 'receipt_ids', 'action', 'comment', 'first_seen', 'key'];
  const n = tracked.rows.length;
  const sheet = writeTable_('Exceptions', headers, tracked.rows.map(o => headers.map(h => o[h])), {
    textColumns: ['po_id', 'sku', 'receipt_ids', 'owner', 'comment', 'key'],
    formats: { value_impact: '#,##0.00', first_seen: 'yyyy-mm-dd' },
  });
  const col = h => headers.indexOf(h) + 1;
  colorSeverity_(sheet, col('severity'), n);
  colorText_(sheet, col('status'), n, {
    'In progress': ['#e8f0fe', '#174ea6'], Resolved: ['#e6f4ea', '#137333'], "Won't fix": ['#f1f3f4', '#5f6368'],
  });
  if (n) {
    sheet.getRange(2, col('status'), n, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(TRACK_STATUSES, true).setAllowInvalid(false).build());
  }
  // Yellow headers = the columns people type into; everything else is rewritten each run.
  ['status', 'owner', 'comment'].forEach(h => sheet.getRange(1, col(h)).setBackground('#fff2cc'));
  sheet.setColumnWidth(col('owner'), 110);
  sheet.setColumnWidth(col('comment'), 260);
  sheet.hideColumns(col('key'));
}
