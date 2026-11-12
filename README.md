# PO vs Receipt Reconciliation & Inventory Risk

SQL Server extracts feed a Google Sheet, where Apps Script checks every purchase-order line
against the warehouse receiving log and flags inventory at risk of running out or sitting idle.

> Personal portfolio project, built with AI assistance (Claude). The data is Microsoft's
> AdventureWorks sample database; the warehouse receiving log is **simulated** (see below).

## What it does

| Check | Example |
|---|---|
| Receipt vs ERP quantity | Warehouse counted 2, ERP shows 3 received |
| Missing / unknown receipts | ERP shows goods received but no warehouse record; receipt quotes a PO that doesn't exist |
| Short / over / rejected deliveries | 468 of 550 delivered and PO closed; 550 of 550 rejected at receiving |
| Late deliveries, overdue open POs | Received 9 days after the due date |
| Duplicate scans | Same PO, SKU, quantity and day entered twice |
| Typo-tolerant SKU matching | `fw7160`, `FW-716O`, `FW-1760` are all matched to `FW-7160`; ambiguous ones go to a person |
| Stockout risk | Below safety stock, at reorder point with nothing on order, days of cover shorter than lead time |
| Slow / dead stock | No movement for 180+ days, discontinued items still in stock, with location breakdown |

Results land in tabs: **Summary**, **Exceptions** (one row per issue, with severity, value and a suggested action),
**Inventory Risk**, **Reconciliation** (every PO line), **Receipt Matching** (how each receipt was matched), plus a **Settings** tab
so rules can be changed without touching code.

## How it works

```
SQL Server (AdventureWorks2022)
   │  sql/01-04_*.sql            extract PO lines, receipts, stock by location, product master
   ▼
export.ps1  ──►  data/*.csv      UTF-8, locale-independent numbers
   │
   ▼  upload to a Google Drive folder
Google Sheet + Apps Script       import → reconcile → inventory risk → summary
```

**Design choices**

- **SQL prepares facts, Apps Script applies rules.** Thresholds live in the Settings tab, not in the code.
- **SKU matching only compares SKUs on the same PO**, so typo tolerance can't drift onto an unrelated item.
  A real team script failed because one wrong character stopped files from matching; this avoids that without guessing.
- **One run at a time:** every run takes a document lock, so two people pressing the button can't overwrite each other.
- **Logic is testable outside Google:** the matching and checking functions are pure and run under Deno against the same CSVs.

## Simulated data

AdventureWorks has purchase orders but no separate warehouse receiving log, so
[`sql/02_warehouse_receipts.sql`](sql/02_warehouse_receipts.sql) builds one from the received PO lines and plants
realistic mistakes in a small, repeatable share of rows: mistyped SKUs (~4%), short and over counts, missing receipts,
duplicate scans, mistyped PO numbers and late arrivals. The sample data ends in August 2014, so "today" is fixed at
**2014-08-03** (editable in Settings).

## Test results

`tests/logic_test.js` runs the Apps Script logic against the sample CSVs and an answer key of the planted mistakes:

```
check                                               caught / planted
short count -> count mismatch                         128 / 128
late delivery -> flagged                              391 / 391
missing receipt -> flagged                             87 / 87
mistyped SKU -> matched to right line                 166 / 166
over count -> over-received / mismatch                 41 / 41
mistyped PO -> flagged                                 44 / 44
mistyped PO -> right PO suggested                      44 / 44
duplicate scan -> set aside                            42 / 42
mistyped SKU, 2 close options -> sent to review         7 / 7
received after as-of date -> no receipt                84 / 84
receipts matched to the wrong line                      0
false alarms on clean lines                             0
```

## Setup

### 1. Export the data (optional: sample CSVs are already in `data/`)

Needs SQL Server with [AdventureWorks2022](https://learn.microsoft.com/sql/samples/adventureworks-install-configure) restored.

```powershell
powershell -ExecutionPolicy Bypass -File .\export.ps1                         # default server .\SQLEXPRESS
powershell -ExecutionPolicy Bypass -File .\export.ps1 -Server "MYPC\SQL2022"  # another instance
```

### 2. Put the CSVs in Google Drive

Create a Drive folder and upload the four files from `data/`. Uploading a newer version later is fine:
the import always takes the most recently updated file of each name.

### 3. Create the Sheet and add the script

1. Create a new Google Sheet.
2. Run `powershell -ExecutionPolicy Bypass -File .\bundle.ps1`. It joins `apps-script/*.gs` into `dist/Code.gs` and copies it to the clipboard.
3. In the Sheet: **Extensions → Apps Script**, select everything in `Code.gs`, paste, and save.
4. Reload the Sheet. A **PO Reconciliation** menu appears.

### 4. Run it

1. **PO Reconciliation → Set up Settings tab.** Google asks for permission the first time
   (the script reads your Drive files and edits this spreadsheet).
2. Paste the Drive folder link into **CSV folder** on the Settings tab.
3. **PO Reconciliation → Run everything.**

### Run the tests

```powershell
deno test --allow-read tests/
```

To rebuild the answer key after changing the SQL: `.\export.ps1 -SqlDir .\tests\sql -OutDir .\tests\data`.

## Repository layout

```
sql/            extract queries (01-04)
export.ps1      runs sql/*.sql, writes data/*.csv
data/           sample CSVs (as of 2014-08-03)
apps-script/    Apps Script source, one file per module
bundle.ps1      joins apps-script/*.gs into dist/Code.gs for pasting
tests/          Deno tests + answer key of planted mistakes
```
