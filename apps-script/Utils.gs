/**
 * Utils.gs — small pure helpers shared by every module.
 * No Google APIs here, so these also run in the local Deno tests.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2014-08-03" -> whole days since 1970-01-01 (time-zone free). Returns null if not a date. */
function dayNum_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/** Day number -> "2014-08-03". */
function isoDay_(dayNumber) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/** Blank or non-numeric -> 0. */
function num_(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

function round2_(x) {
  return Math.round(x * 100) / 100;
}

function pushTo_(map, key, item) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(item);
}

function unique_(list) {
  return Array.from(new Set(list));
}

/** "a@x.com; b@y.com,  c@z.com" -> ["a@x.com", "b@y.com", "c@z.com"]. Throws on anything that isn't an address. */
function parseEmails_(text) {
  const list = String(text || '').split(/[,;\s]+/).filter(Boolean);
  list.forEach(a => {
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(a)) throw new Error(`Settings: "${a}" is not an email address.`);
  });
  return list;
}

function escapeHtml_(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function money_(x) {
  return num_(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Array of objects -> CSV text (RFC 4180 quoting). */
function toCsv_(headers, rows) {
  const field = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.map(field).join(',')]
    .concat(rows.map(r => headers.map(h => field(r[h])).join(',')))
    .join('\r\n');
}

/** Accepts a Drive folder link or a bare ID and returns the ID. */
function extractDriveId_(text) {
  const s = String(text || '').trim();
  const m = /\/folders\/([\w-]+)/.exec(s) || /[?&]id=([\w-]+)/.exec(s);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : '';
}
