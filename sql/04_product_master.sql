/*  04_product_master.sql
    One row per stocked or purchased product: planning parameters, total on-hand,
    open PO quantity, primary vendor lead time, and recent movement.
    Feeds the stockout-risk and slow-mover checks in Google Sheets.
    The flag logic itself lives in Apps Script; SQL only prepares the facts.
*/
SET NOCOUNT ON;

DECLARE @AsOf date = '2014-08-03';

WITH onhand AS (
    SELECT ProductID, SUM(Quantity) AS qty, COUNT(*) AS locations
    FROM Production.ProductInventory
    GROUP BY ProductID
),
open_po AS (                                    -- ordered but not yet received on @AsOf
    SELECT x.ProductID,
           SUM(x.outstanding) AS qty,
           MIN(x.DueDate)     AS next_due
    FROM (
        SELECT d.ProductID, d.DueDate,
               d.OrderQty - CASE WHEN h.ShipDate > @AsOf THEN 0 ELSE CAST(d.ReceivedQty AS int) END AS outstanding
        FROM Purchasing.PurchaseOrderHeader AS h
        JOIN Purchasing.PurchaseOrderDetail AS d ON d.PurchaseOrderID = h.PurchaseOrderID
        WHERE h.OrderDate <= @AsOf
          AND (h.Status IN (1, 2) OR h.ShipDate > @AsOf)   -- Pending/Approved, or not shipped yet on @AsOf
    ) AS x
    WHERE x.outstanding > 0
    GROUP BY x.ProductID
),
movement AS (                                   -- S = sale, W = work order, P = purchase receipt
    SELECT ProductID,
           MAX(TransactionDate)                                             AS last_movement,
           MAX(CASE WHEN TransactionType = 'S' THEN TransactionDate END)    AS last_sale,
           SUM(CASE WHEN TransactionType = 'S'
                     AND TransactionDate > DATEADD(DAY, -90, @AsOf)  THEN Quantity ELSE 0 END) AS sold_90d,
           SUM(CASE WHEN TransactionType = 'S'
                     AND TransactionDate > DATEADD(DAY, -365, @AsOf) THEN Quantity ELSE 0 END) AS sold_365d
    FROM Production.TransactionHistory
    WHERE TransactionDate <= @AsOf
    GROUP BY ProductID
),
vendor AS (                                     -- primary vendor = most recently received from
    SELECT pv.ProductID, pv.BusinessEntityID, v.Name, pv.AverageLeadTime, pv.MinOrderQty, pv.MaxOrderQty,
           ROW_NUMBER() OVER (PARTITION BY pv.ProductID
                              ORDER BY pv.LastReceiptDate DESC, pv.AverageLeadTime) AS rn
    FROM Purchasing.ProductVendor AS pv
    JOIN Purchasing.Vendor        AS v ON v.BusinessEntityID = pv.BusinessEntityID
)
SELECT
    p.ProductID                                     AS product_id,
    p.ProductNumber                                 AS sku,
    p.Name                                          AS product_name,
    pc.Name                                         AS category,
    ps.Name                                         AS subcategory,
    CASE p.MakeFlag WHEN 1 THEN 'Make' ELSE 'Buy' END AS source_type,
    CAST(p.FinishedGoodsFlag AS int)                AS is_finished_good,
    CASE WHEN p.SellEndDate IS NOT NULL OR p.DiscontinuedDate IS NOT NULL
         THEN 1 ELSE 0 END                          AS is_discontinued,
    p.SafetyStockLevel                              AS safety_stock,
    p.ReorderPoint                                  AS reorder_point,
    CAST(p.StandardCost AS decimal(12, 2))          AS standard_cost,
    CAST(p.ListPrice    AS decimal(12, 2))          AS list_price,
    ISNULL(oh.qty, 0)                               AS on_hand_qty,
    ISNULL(oh.locations, 0)                         AS stocked_locations,
    ISNULL(op.qty, 0)                               AS open_po_qty,
    CONVERT(char(10), op.next_due, 23)              AS next_po_due,
    vd.BusinessEntityID                             AS primary_vendor_id,
    vd.Name                                         AS primary_vendor,
    vd.AverageLeadTime                              AS lead_time_days,
    vd.MinOrderQty                                  AS min_order_qty,
    vd.MaxOrderQty                                  AS max_order_qty,
    CONVERT(char(10), mv.last_movement, 23)         AS last_movement_date,
    CONVERT(char(10), mv.last_sale, 23)             AS last_sale_date,
    ISNULL(mv.sold_90d, 0)                          AS sold_90d,
    ISNULL(mv.sold_365d, 0)                         AS sold_365d
FROM Production.Product                 AS p
LEFT JOIN Production.ProductSubcategory AS ps ON ps.ProductSubcategoryID = p.ProductSubcategoryID
LEFT JOIN Production.ProductCategory    AS pc ON pc.ProductCategoryID    = ps.ProductCategoryID
LEFT JOIN onhand   AS oh ON oh.ProductID = p.ProductID
LEFT JOIN open_po  AS op ON op.ProductID = p.ProductID
LEFT JOIN movement AS mv ON mv.ProductID = p.ProductID
LEFT JOIN vendor   AS vd ON vd.ProductID = p.ProductID AND vd.rn = 1
WHERE oh.ProductID IS NOT NULL
   OR op.ProductID IS NOT NULL
   OR vd.ProductID IS NOT NULL
ORDER BY p.ProductNumber;
