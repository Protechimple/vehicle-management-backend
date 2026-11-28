const { QueryTypes } = require('sequelize');

const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { allowedSiteIds, includesSite } = require('./siteAccess');
const { roundQuantity, roundMoney, roundUnitCost } = require('./fuelCommon');

// Centring is always held at a site. A user sees the sites they cover; the Admin sees every site.

function canSeeSite(auth, siteId) {
  const siteIds = allowedSiteIds(auth);
  return siteIds === null || includesSite(siteIds, siteId);
}

function readSite(value, label = 'Site') {
  const id = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isInteger(id) || id < 1) throw AppError.badRequest(`Choose the ${label.toLowerCase()}`);
  return id;
}

// The sites a list covers: the one asked for, or all this user sees. Null means every site.
function siteFilter(auth, requested) {
  const siteIds = allowedSiteIds(auth);
  if (requested === undefined || requested === null || requested === '') return siteIds ? siteIds.map(Number) : null;
  const siteId = readSite(requested);
  if (!canSeeSite(auth, siteId)) throw AppError.notFound('Site not found');
  return [siteId];
}

// ---------------------------------------------------------------------------------------------------------------------
// Stock: never stored, always the sum of the active entries. Every line adds to or takes from its entry's site
// (to_site_id) by its direction; a transfer also takes its lines from the site it left (from_site_id).

async function stockRows(tenantId, { siteIds = null, itemIds = null } = {}, transaction) {
  if (itemIds && itemIds.length === 0) return [];
  if (siteIds && siteIds.length === 0) return [];
  const filters = [siteIds ? ' AND x.site_id IN (:siteIds)' : '', itemIds ? ' AND x.item_id IN (:itemIds)' : ''].join('');
  const rows = await sequelize.query(
    `SELECT x.site_id AS siteId, x.item_id AS itemId, SUM(x.quantity) AS quantity
       FROM (
         SELECT e.to_site_id AS site_id, l.item_id, CASE WHEN l.direction = 'out' THEN -l.quantity ELSE l.quantity END AS quantity
           FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
          WHERE e.tenant_id = :tenantId AND e.status = 'active'
         UNION ALL
         SELECT e.from_site_id, l.item_id, -l.quantity
           FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
          WHERE e.tenant_id = :tenantId AND e.status = 'active' AND e.entry_type = 'transfer'
       ) x
      WHERE 1 = 1${filters}
      GROUP BY x.site_id, x.item_id`,
    { replacements: { tenantId, siteIds, itemIds }, type: QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => ({ siteId: Number(r.siteId), itemId: Number(r.itemId), quantity: roundQuantity(Number(r.quantity)) }));
}

async function stockAt(tenantId, siteId, itemIds, transaction) {
  const rows = await stockRows(tenantId, { siteIds: [siteId], itemIds }, transaction);
  return new Map(rows.map((r) => [r.itemId, r.quantity]));
}

// ---------------------------------------------------------------------------------------------------------------------
// Value: each item has one company-wide weighted average price. Purchases add value at their price; issues and
// adjustments take it away (or add it back) at the average. Transfers only move material, so they change neither.

async function itemValues(tenantId, itemIds = null, transaction) {
  if (itemIds && itemIds.length === 0) return new Map();
  const rows = await sequelize.query(
    `SELECT l.item_id AS itemId,
            SUM(CASE WHEN l.direction = 'out' THEN -l.quantity ELSE l.quantity END) AS quantity,
            SUM(CASE WHEN l.direction = 'out' THEN -l.amount ELSE l.amount END) AS value
       FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
      WHERE e.tenant_id = :tenantId AND e.status = 'active' AND e.entry_type IN ('purchase', 'issue', 'adjustment')${itemIds ? ' AND l.item_id IN (:itemIds)' : ''}
      GROUP BY l.item_id`,
    { replacements: { tenantId, itemIds }, type: QueryTypes.SELECT, transaction }
  );
  return new Map(rows.map((r) => [Number(r.itemId), { quantity: roundQuantity(Number(r.quantity)), value: roundMoney(Number(r.value)) }]));
}

function averageRate(totals) {
  if (!totals || totals.quantity <= 0) return 0;
  return roundUnitCost(Math.max(totals.value, 0) / totals.quantity);
}

// The part of an item's value this quantity carries, worked from the exact value so the parts add up to the whole.
function shareOfValue(quantity, totals) {
  if (!totals || totals.quantity <= 0) return 0;
  return roundMoney((Math.max(totals.value, 0) * quantity) / totals.quantity);
}

// What taking this quantity away is worth. The last of an item takes whatever value is left.
function valueOut(quantity, totals) {
  if (!totals || totals.quantity <= 0) return 0;
  if (roundQuantity(totals.quantity - quantity) <= 0) return roundMoney(Math.max(totals.value, 0));
  return shareOfValue(quantity, totals);
}

module.exports = { canSeeSite, readSite, siteFilter, stockRows, stockAt, itemValues, averageRate, shareOfValue, valueOut };
