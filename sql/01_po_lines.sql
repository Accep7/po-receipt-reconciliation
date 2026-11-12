/*  01_po_lines.sql
    Purchase order lines ordered in the 6 months up to the as-of date.
    This is the "ERP side" of the reconciliation: what was ordered, from whom,
    when it was due, and what the system recorded as received / rejected.

    AdventureWorks data ends in 2014, so "today" is fixed at @AsOf.
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
    CASE h.Status
        WHEN 1 THEN 'Pending'
        WHEN 2 THEN 'Approved'
        WHEN 3 THEN 'Rejected'
        WHEN 4 THEN 'Complete'
    END                                                 AS po_status,
    v.BusinessEntityID                                  AS vendor_id,
    v.Name                                              AS vendor_name,
    p.ProductID                                         AS product_id,
    p.ProductNumber                                     AS sku,
    p.Name                                              AS product_name,
    d.OrderQty                                          AS ordered_qty,
    CAST(d.ReceivedQty AS int)                          AS erp_received_qty,
    CAST(d.RejectedQty AS int)                          AS erp_rejected_qty,
    CAST(d.StockedQty  AS int)                          AS erp_stocked_qty,
    CAST(d.UnitPrice AS decimal(12, 2))                 AS unit_price,
    CAST(d.OrderQty * d.UnitPrice AS decimal(12, 2))    AS line_value
FROM Purchasing.PurchaseOrderHeader AS h
JOIN Purchasing.PurchaseOrderDetail AS d ON d.PurchaseOrderID   = h.PurchaseOrderID
JOIN Purchasing.Vendor              AS v ON v.BusinessEntityID  = h.VendorID
JOIN Production.Product             AS p ON p.ProductID         = d.ProductID
WHERE h.OrderDate >= @From
  AND h.OrderDate <= @AsOf
ORDER BY h.PurchaseOrderID, d.PurchaseOrderDetailID;
