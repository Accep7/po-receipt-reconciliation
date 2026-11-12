/*  02_warehouse_receipts.sql   ***  SIMULATED DATA  ***

    AdventureWorks has no separate warehouse receiving log, so this query builds one
    from the PO lines that the ERP shows as received. Most rows match the ERP exactly.
    A small, deterministic share carries the kinds of mistakes a real receiving team makes,
    so the Google Sheets tool has something realistic to catch:

      r = 0..3   SKU typed wrong       (hyphen dropped, lowercase, two characters swapped,
                                        0 typed as O / last character missing)
      r = 4..6   short count           (warehouse counted ~10% fewer than the ERP shows)
      r = 7      over count            (~5% more than the ERP shows)
      r = 8..9   no receipt recorded   (row left out: ERP says received, warehouse has nothing)
      r = 10     scanned twice         (duplicate row)
      r = 11     PO number mistyped    (digits reversed)
      r2 >= 90   received late         (5-14 days after the due date)

    "r" and "r2" come from CHECKSUM of the line ID, so every run produces the same file.
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
             THEN DATEADD(DAY, b.r2 - 85, b.DueDate)        -- late: 5-14 days past due
             ELSE DATEADD(DAY, b.r2 % 4, b.ShipDate)        -- normal: 0-3 days after shipping
        END                                                 AS receipt_date,
        CASE b.r
            WHEN 0 THEN REPLACE(b.sku, '-', '')
            WHEN 1 THEN LOWER(b.sku)
            WHEN 2 THEN STUFF(b.sku, 4, 2, SUBSTRING(b.sku, 5, 1) + SUBSTRING(b.sku, 4, 1))
            WHEN 3 THEN CASE WHEN CHARINDEX('0', b.sku) > 0
                             THEN REPLACE(b.sku, '0', 'O')
                             ELSE LEFT(b.sku, LEN(b.sku) - 1) END
            ELSE b.sku
        END                                                 AS sku_entered,
        CASE WHEN b.r = 11
             THEN REVERSE(CAST(b.PurchaseOrderID AS varchar(10)))
             ELSE CAST(b.PurchaseOrderID AS varchar(10))
        END                                                 AS po_ref,
        CASE WHEN b.r BETWEEN 4 AND 6 THEN b.received_qty - CEILING(b.received_qty * 0.10)
             WHEN b.r = 7             THEN b.received_qty + CEILING(b.received_qty * 0.05)
             ELSE b.received_qty
        END                                                 AS qty_counted,
        CHOOSE(b.r2 % 5 + 1, 'AK', 'MT', 'YS', 'RN', 'KO')  AS received_by,
        CHOOSE(b.r % 2 + 1, 'Dock A', 'Dock B')             AS dock
    FROM base AS b
    WHERE b.r NOT IN (8, 9)                                 -- missing receipts
),
with_dupes AS (
    SELECT *, 0 AS dup FROM entered
    UNION ALL
    SELECT *, 1 AS dup FROM entered WHERE r = 10            -- scanned twice
)
SELECT
    'GR-' + RIGHT('00000' + CAST(ROW_NUMBER() OVER (ORDER BY receipt_date, PurchaseOrderDetailID, dup) AS varchar(6)), 5)
                                                AS receipt_id,
    CONVERT(char(10), receipt_date, 23)         AS receipt_date,
    po_ref,
    sku_entered,
    CAST(qty_counted AS int)                    AS qty_received,
    rejected_qty                                AS qty_damaged,
    dock,
    received_by
FROM with_dupes
WHERE receipt_date <= @AsOf
ORDER BY receipt_id;
