/*  answer_key.sql  (test fixture, not used by the Sheet)

    For every PO line that sql/02_warehouse_receipts.sql builds receipts from, this lists
    which mistake was planted and which receipt IDs it produced. The Deno test compares
    the Apps Script results against it.

    The CTEs must stay identical to sql/02_warehouse_receipts.sql.
*/
SET NOCOUNT ON;

DECLARE @AsOf date = '2014-08-03';
DECLARE @From date = DATEADD(MONTH, -6, @AsOf);

WITH base AS (
    SELECT
        h.PurchaseOrderID,
        d.PurchaseOrderDetailID,
        h.ShipDate,
        d.DueDate,
        p.ProductNumber                                         AS sku,
        CAST(d.ReceivedQty AS int)                              AS received_qty,
        CAST(d.RejectedQty AS int)                              AS rejected_qty,
        ABS(CHECKSUM(d.PurchaseOrderDetailID * 7919 + 17))   % 100 AS r,
        ABS(CHECKSUM(d.PurchaseOrderDetailID * 104729 + 3))  % 100 AS r2
    FROM Purchasing.PurchaseOrderHeader AS h
    JOIN Purchasing.PurchaseOrderDetail AS d ON d.PurchaseOrderID = h.PurchaseOrderID
    JOIN Production.Product             AS p ON p.ProductID       = d.ProductID
    WHERE h.OrderDate >= @From
      AND h.OrderDate <= @AsOf
      AND h.ShipDate  <= @AsOf
      AND d.ReceivedQty > 0
),
entered AS (
    SELECT
        b.*,
        CASE WHEN b.r2 >= 90
             THEN DATEADD(DAY, b.r2 - 85, b.DueDate)
             ELSE DATEADD(DAY, b.r2 % 4, b.ShipDate)
        END                                                 AS receipt_date
    FROM base AS b
    WHERE b.r NOT IN (8, 9)
),
with_dupes AS (
    SELECT *, 0 AS dup FROM entered
    UNION ALL
    SELECT *, 1 AS dup FROM entered WHERE r = 10
),
numbered AS (
    SELECT PurchaseOrderDetailID, dup, receipt_date,
           'GR-' + RIGHT('00000' + CAST(ROW_NUMBER() OVER (ORDER BY receipt_date, PurchaseOrderDetailID, dup) AS varchar(6)), 5)
               AS receipt_id
    FROM with_dupes
    WHERE receipt_date <= @AsOf
)
SELECT
    b.PurchaseOrderDetailID                                 AS po_line_id,
    CASE
        WHEN b.r BETWEEN 0 AND 3 THEN 'sku_typo'
        WHEN b.r BETWEEN 4 AND 6 THEN 'short_count'
        WHEN b.r = 7             THEN 'over_count'
        WHEN b.r IN (8, 9)       THEN 'missing_receipt'
        WHEN b.r = 10            THEN 'duplicate'
        WHEN b.r = 11            THEN 'po_typo'
        ELSE 'clean'
    END                                                     AS planted_error,
    CASE WHEN b.r2 >= 90 THEN 1 ELSE 0 END                  AS planted_late,
    (SELECT MIN(n.receipt_id) FROM numbered n
      WHERE n.PurchaseOrderDetailID = b.PurchaseOrderDetailID AND n.dup = 0) AS receipt_id,
    (SELECT MIN(n.receipt_id) FROM numbered n
      WHERE n.PurchaseOrderDetailID = b.PurchaseOrderDetailID AND n.dup = 1) AS duplicate_receipt_id
FROM base AS b
ORDER BY b.PurchaseOrderDetailID;
