/**
 * InventoryRisk.gs — stockout and slow-moving stock checks.
 *
 * assessInventory_() is pure; runInventoryRisk_() reads and writes the sheet.
 * Rules (each product can collect several flags; the highest decides its risk level):
 *
 *   High    out of stock, below safety stock, at/below reorder point with nothing on order,
 *           days of cover shorter than the vendor lead time
 *   Medium  below reorder point even counting open POs, make-item at reorder point,
 *           no movement for N days, discontinued item still in stock
 *   Low     reorder point reached but a PO is already open
 */

const RISK_LABEL = { 3: 'High', 2: 'Medium', 1: 'Low' };

/**
 * @param {Object[]} products   rows of raw_product_master
 * @param {Object[]} inventory  rows of raw_inventory_by_location
 * @param {Object}   settings   from getSettings_()
 */
function assessInventory_(products, inventory, settings) {
  const asOf = dayNum_(settings.asOfDate);

  const locations = new Map();   // product_id -> [[location, qty], ...]
  inventory.forEach(row => {
    if (num_(row.on_hand_qty) > 0) pushTo_(locations, String(row.product_id), [row.location_name, num_(row.on_hand_qty)]);
  });

  const flagged = [];
  products.forEach(p => {
    const onHand = num_(p.on_hand_qty);
    const safety = num_(p.safety_stock);
    const reorderPoint = num_(p.reorder_point);
    const openPo = num_(p.open_po_qty);
    const leadTime = p.lead_time_days === '' ? null : num_(p.lead_time_days);
    const sold90 = num_(p.sold_90d);
    const isBuy = p.source_type === 'Buy';
    const discontinued = num_(p.is_discontinued) === 1;
    const dailyUse = sold90 / 90;
    const cover = dailyUse > 0 ? onHand / dailyUse : null;
    const lastMove = dayNum_(p.last_movement_date);
    const idleDays = lastMove === null ? null : asOf - lastMove;
    const due = p.next_po_due ? `, due ${p.next_po_due}` : '';

    const flags = [];
    let level = 0;
    const types = [];
    const add = (lvl, type, text) => { flags.push(text); types.push(type); level = Math.max(level, lvl); };

    if (!discontinued) {
      if (onHand <= 0) add(3, 'Out of stock', 'Out of stock' + (openPo > 0 ? ` (${openPo} on order${due})` : ', nothing on order'));
      else if (onHand < safety) add(3, 'Below safety stock', `Below safety stock (${onHand} < ${safety})`);

      if (onHand > 0 && onHand <= reorderPoint) {
        if (!isBuy) add(2, 'Make item at reorder point', `At/below reorder point (${reorderPoint}); make item, check the production plan`);
        else if (openPo === 0) add(3, 'Reorder point, nothing on order', `At/below reorder point (${reorderPoint}) with nothing on order`);
        else if (onHand + openPo <= reorderPoint) add(2, 'Below reorder point incl. open POs', `Still below reorder point counting ${openPo} on order${due}`);
        else add(1, 'Reorder point, PO open', `Reorder point reached; ${openPo} on order${due}`);
      }
      if (cover !== null && leadTime !== null && cover < leadTime) {
        add(3, 'Cover shorter than lead time', `${Math.floor(cover)} days of cover vs ${leadTime}-day lead time`);
      }
    }

    if (onHand > 0) {
      if (idleDays === null) add(2, 'Slow / no movement', 'No movement in the transaction history');
      else if (idleDays >= settings.slowMoverDays) add(2, 'Slow / no movement', `No movement for ${idleDays} days`);
      if (discontinued) add(2, 'Discontinued with stock', 'Discontinued item still in stock');
    }

    if (!flags.length) return;

    const where = (locations.get(String(p.product_id)) || [])
      .sort((a, b) => b[1] - a[1])
      .map(([loc, qty]) => `${loc} ${qty}`)
      .join('; ');

    flagged.push({
      risk: RISK_LABEL[level],
      level,
      sku: p.sku,
      product: p.product_name,
      category: p.category || (p.source_type === 'Buy' ? 'Component (bought)' : 'Component (made)'),
      source: p.source_type,
      on_hand_qty: onHand,
      safety_stock: safety,
      reorder_point: reorderPoint,
      open_po_qty: openPo,
      next_po_due: p.next_po_due || '',
      lead_time_days: leadTime === null ? '' : leadTime,
      sold_90d: sold90,
      days_of_cover: cover === null ? '' : Math.floor(cover),
      last_movement: p.last_movement_date || '',
      days_idle: idleDays === null ? '' : idleDays,
      stock_value: round2_(onHand * num_(p.standard_cost)),
      stock_by_location: where,
      flags: flags.join('; '),
      flag_types: types,
    });
  });

  flagged.sort((a, b) => b.level - a.level || b.stock_value - a.stock_value || a.sku.localeCompare(b.sku));
  return { items: flagged, stats: inventoryStats_(products.length, flagged) };
}

function inventoryStats_(checked, items) {
  const byRisk = { High: 0, Medium: 0, Low: 0 };
  const byFlag = {};
  let slowValue = 0;
  items.forEach(it => {
    byRisk[it.risk]++;
    unique_(it.flag_types).forEach(type => { byFlag[type] = (byFlag[type] || 0) + 1; });
    if (it.flag_types.some(t => t === 'Slow / no movement' || t === 'Discontinued with stock')) slowValue += it.stock_value;
  });
  return { productsChecked: checked, flagged: items.length, byRisk, byFlag, slowStockValue: round2_(slowValue) };
}

/** Reads the raw tabs, runs assessInventory_, writes the Inventory Risk tab. */
function runInventoryRisk_() {
  const settings = getSettings_();
  const result = assessInventory_(readTable_('raw_product_master'), readTable_('raw_inventory_by_location'), settings);

  const headers = ['risk', 'sku', 'product', 'category', 'source', 'on_hand_qty', 'safety_stock', 'reorder_point',
    'open_po_qty', 'next_po_due', 'lead_time_days', 'sold_90d', 'days_of_cover', 'last_movement', 'days_idle',
    'stock_value', 'stock_by_location', 'flags'];
  const sheet = writeTable_('Inventory Risk', headers, result.items.map(o => headers.map(h => o[h])), {
    textColumns: ['sku'],
    formats: { next_po_due: 'yyyy-mm-dd', last_movement: 'yyyy-mm-dd', stock_value: '#,##0.00' },
  });
  colorSeverity_(sheet, 1, result.items.length);

  saveStats_('inventory', result.stats);
  const s = result.stats;
  return `Checked ${s.productsChecked} products: ${s.byRisk.High} high, ${s.byRisk.Medium} medium, ${s.byRisk.Low} low risk.`;
}
