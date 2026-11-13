/**
 * Report.gs — the email report, created as a Gmail draft.
 *
 * Drafts, not sends: a person reads the numbers before they go to a vendor or a manager.
 * Uses the Gmail advanced service with the narrow gmail.compose scope (create drafts only),
 * instead of GmailApp, which would need full access to the mailbox.
 */

const EXCEPTION_CSV_HEADERS = ['severity', 'status', 'owner', 'issue', 'po_id', 'po_line_id', 'vendor', 'sku',
  'product', 'qty_diff', 'value_impact', 'detail', 'receipt_ids', 'action', 'comment', 'first_seen'];

/**
 * Pure: builds the subject and HTML body.
 * @param {Object} input {asOfDate, runDate, sheetUrl, recon, inventory, openHigh: Object[], highRisk: Object[], maxRows}
 */
function buildReport_(input) {
  const recon = input.recon || {};
  const t = recon.tracking || { openBySeverity: { High: 0, Medium: 0, Low: 0 }, newThisRun: 0, clearedSinceLastRun: 0, closedStillDetected: 0, open: 0 };
  const inv = input.inventory || { byRisk: { High: 0, Medium: 0, Low: 0 }, flagged: 0 };
  const e = escapeHtml_;

  const subject = `PO reconciliation as of ${input.asOfDate}: ${t.openBySeverity.High} high-priority exceptions` +
    (t.firstRun ? '' : `, ${t.newThisRun} new`);

  const cell = 'style="padding:4px 8px;border:1px solid #dadce0;vertical-align:top"';
  const head = 'style="padding:4px 8px;border:1px solid #dadce0;background:#f1f3f4;text-align:left"';
  const num = 'style="padding:4px 8px;border:1px solid #dadce0;text-align:right;vertical-align:top"';
  const table = (headers, rows) =>
    `<table style="border-collapse:collapse;font-size:13px">` +
    `<tr>${headers.map(h => `<th ${head}>${e(h)}</th>`).join('')}</tr>` +
    rows.map(r => `<tr>${r.join('')}</tr>`).join('') + '</table>';

  const counts = table(['', 'Count'], [
    [`<td ${cell}>Open exceptions: high / medium / low</td>`,
      `<td ${num}>${t.openBySeverity.High} / ${t.openBySeverity.Medium} / ${t.openBySeverity.Low}</td>`],
    [`<td ${cell}>New since last run</td>`, `<td ${num}>${t.firstRun ? 'first run' : t.newThisRun}</td>`],
    [`<td ${cell}>Cleared since last run</td>`, `<td ${num}>${t.firstRun ? '-' : t.clearedSinceLastRun}</td>`],
    [`<td ${cell}>Marked resolved / won't fix but still detected</td>`, `<td ${num}>${t.closedStillDetected}</td>`],
    [`<td ${cell}>PO lines checked / fully matched</td>`,
      `<td ${num}>${recon.poLines || 0} / ${(recon.byStatus && recon.byStatus.OK) || 0}</td>`],
    [`<td ${cell}>Products at high / medium inventory risk</td>`, `<td ${num}>${inv.byRisk.High} / ${inv.byRisk.Medium}</td>`],
  ]);

  const top = (input.openHigh || []).slice(0, input.maxRows);
  const exceptionTable = top.length
    ? table(['Issue', 'PO', 'Vendor', 'SKU', 'Qty', 'Value', 'Detail', 'Owner'], top.map(x => [
      `<td ${cell}>${e(x.issue)}</td>`,
      `<td ${cell}>${e(x.po_id)}${x.po_line_id ? ` / ${e(x.po_line_id)}` : ''}</td>`,
      `<td ${cell}>${e(x.vendor)}</td>`,
      `<td ${cell}>${e(x.sku)}</td>`,
      `<td ${num}>${e(x.qty_diff)}</td>`,
      `<td ${num}>${x.value_impact === '' ? '' : money_(x.value_impact)}</td>`,
      `<td ${cell}>${e(x.detail)}</td>`,
      `<td ${cell}>${e(x.owner || '-')}</td>`,
    ]))
    : '<p>No open high-priority exceptions.</p>';

  const risk = (input.highRisk || []).slice(0, 10);
  const riskTable = risk.length
    ? table(['SKU', 'Product', 'On hand', 'Why'], risk.map(x => [
      `<td ${cell}>${e(x.sku)}</td>`, `<td ${cell}>${e(x.product)}</td>`,
      `<td ${num}>${e(x.on_hand_qty)}</td>`, `<td ${cell}>${e(x.flags)}</td>`,
    ]))
    : '<p>No products at high risk.</p>';

  const shownNote = (input.openHigh || []).length > top.length
    ? ` (top ${top.length} of ${input.openHigh.length} by value)` : '';

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#202124">` +
    `<p>PO vs receipt reconciliation and inventory risk, data as of <b>${e(input.asOfDate)}</b>.</p>` +
    counts +
    `<h3 style="font-size:15px;margin:20px 0 8px">Open high-priority exceptions${shownNote}</h3>` +
    exceptionTable +
    `<h3 style="font-size:15px;margin:20px 0 8px">Inventory at high risk</h3>` +
    riskTable +
    `<p style="margin-top:20px">Full list of open exceptions attached (CSV). ` +
    (input.sheetUrl ? `<a href="${e(input.sheetUrl)}">Open the Sheet</a> to update status, owner and comments.` : '') +
    `</p><p style="color:#5f6368;font-size:12px">Draft created by the PO Reconciliation script on ${e(input.runDate)}. ` +
    `Please review before sending.</p></div>`;

  return { subject, html };
}

/** Reads the result tabs and creates the Gmail draft. Returns a one-line message. */
function createReportDraft_() {
  const settings = getSettings_();
  const ss = SpreadsheetApp.getActive();
  const recon = loadStats_('recon');
  if (!recon) throw new Error('Run the reconciliation first, then create the report.');

  const isOpen = r => CLOSED_STATUSES.indexOf(r.status) === -1;
  const open = readTable_('Exceptions').filter(isOpen);
  const openHigh = open.filter(r => r.severity === 'High').sort((a, b) => num_(b.value_impact) - num_(a.value_impact));
  const highRisk = ss.getSheetByName('Inventory Risk') ? readTable_('Inventory Risk').filter(r => r.risk === 'High') : [];

  const tz = ss.getSpreadsheetTimeZone();
  const report = buildReport_({
    asOfDate: settings.asOfDate,
    runDate: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'),
    sheetUrl: ss.getUrl(),
    recon,
    inventory: loadStats_('inventory'),
    openHigh,
    highRisk,
    maxRows: settings.reportMaxRows,
  });

  const to = settings.reportRecipientList.length
    ? settings.reportRecipientList
    : [Session.getEffectiveUser().getEmail()];
  const attachment = {
    name: `open_exceptions_${settings.asOfDate}.csv`,
    content: '﻿' + toCsv_(EXCEPTION_CSV_HEADERS, open),   // BOM so Excel opens it as UTF-8
  };
  Gmail.Users.Drafts.create({ message: { raw: buildMime_(to, report.subject, report.html, attachment) } }, 'me');
  return `Report draft created for ${to.join(', ')} (check Gmail > Drafts).`;
}

/** multipart/mixed message: HTML body + one CSV attachment, base64url-encoded for the Gmail API. */
function buildMime_(to, subject, html, attachment) {
  const boundary = 'part_' + Utilities.getUuid();
  const b64 = text => Utilities.base64Encode(text, Utilities.Charset.UTF_8).replace(/.{76}/g, '$&\r\n');
  const mime = [
    `To: ${to.join(', ')}`,
    `Subject: =?UTF-8?B?${Utilities.base64Encode(subject, Utilities.Charset.UTF_8)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}`,
    `Content-Type: text/csv; charset=UTF-8; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(attachment.content),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Utilities.base64EncodeWebSafe(mime, Utilities.Charset.UTF_8);
}
