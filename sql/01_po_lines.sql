/*  01_po_lines.sql
    Purchase order lines ordered in the 6 months up to the as-of date.
    This is the "ERP side" of the reconciliation: what was ordered, from whom,
    when it was due, and what the system recorded as received / rejected.

    AdventureWorks data ends in 2014, so "today" is fixed at @AsOf.

    As-of snapshot: the sample data books a receipt even when the vendor ships after @AsOf.
    Those lines are shown as they stood on @AsOf: still open (Approved), nothing received.
*/
SET NOCOUNT ON;

DECLARE @AsOf date = '2014-08-03';               -- last transaction date in the sample data
DECLARE @From date = DATEADD(MONTH, -6, @AsOf);

SELECT
    h.PurchaseOrderID                                   AS po_id,
    d.PurchaseOrderDetailID                             AS po_line_id,
    CONVERT(char(10), h.OrderDate, 23)                  AS order_date,
    CONVERT(char(10), d.DueDate, 23)                    AS due_date,
    CONVERT(char(10), h.ShipDate, 23)                   AS vendor_ship_date,
    CASE
        WHEN h.Status = 1         THEN 'Pending'
        WHEN h.ShipDate > @AsOf   THEN 'Approved'           -- not shipped yet on @AsOf
        WHEN h.Status = 2         THEN 'Approved'
        WHEN h.Status = 3         THEN 'Rejected'
        WHEN h.Status = 4         THEN 'Complete'
    END                                                 AS po_status,
    v.BusinessEntityID                                  AS vendor_id,
    v.Name                                              AS vendor_name,
    p.ProductID                                         AS product_id,
    p.ProductNumber                                     AS sku,
    p.Name                                              AS product_name,
    d.OrderQty                                          AS ordered_qty,
    CASE WHEN h.ShipDate > @AsOf THEN 0 ELSE CAST(d.ReceivedQty AS int) END AS erp_received_qty,
    CASE WHEN h.ShipDate > @AsOf THEN 0 ELSE CAST(d.RejectedQty AS int) END AS erp_rejected_qty,
    CASE WHEN h.ShipDate > @AsOf THEN 0 ELSE CAST(d.StockedQty  AS int) END AS erp_stocked_qty,
    CAST(d.UnitPrice AS decimal(12, 2))                 AS unit_price,
    CAST(d.OrderQty * d.UnitPrice AS decimal(12, 2))    AS line_value
FROM Purchasing.PurchaseOrderHeader AS h
JOIN Purchasing.PurchaseOrderDetail AS d ON d.PurchaseOrderID   = h.PurchaseOrderID
JOIN Purchasing.Vendor              AS v ON v.BusinessEntityID  = h.VendorID
JOIN Production.Product             AS p ON p.ProductID         = d.ProductID
WHERE h.OrderDate >= @From
  AND h.OrderDate <= @AsOf
ORDER BY h.PurchaseOrderID, d.PurchaseOrderDetailID;
