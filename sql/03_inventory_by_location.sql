/*  03_inventory_by_location.sql
    Current on-hand stock per product per location (14 sites/areas in AdventureWorks).
    Used for multi-site views: where the stock sits, and which locations hold none.
*/
SET NOCOUNT ON;

SELECT
    p.ProductID         AS product_id,
    p.ProductNumber     AS sku,
    p.Name              AS product_name,
    l.LocationID        AS location_id,
    l.Name              AS location_name,
    i.Shelf             AS shelf,
    i.Bin               AS bin,
    i.Quantity          AS on_hand_qty
FROM Production.ProductInventory AS i
JOIN Production.Product          AS p ON p.ProductID  = i.ProductID
JOIN Production.Location         AS l ON l.LocationID = i.LocationID
ORDER BY p.ProductNumber, l.LocationID;
