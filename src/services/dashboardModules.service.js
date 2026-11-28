const { QueryTypes } = require('sequelize');

const { sequelize } = require('../models');
const { siteFilterIds, siteSqlClause } = require('./siteAccess');
const { can } = require('../config/permissions');
const { todayDateOnly, roundMoney, roundQuantity } = require('./fuelCommon');
const tyreService = require('./tyre.service');
const adblueService = require('./adblue.service');
const centringStock = require('./centringStock');

// Dashboard sections for Tyres, AdBlue and Centring: where things stand now, and what happened this month. Each one
// covers the site asked for, or every site the user may see.

const num = (value) => (value == null ? 0 : Number(value));

function query(sql, replacements) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

// The first day of this month and today, as business dates.
function thisMonth() {
  const today = todayDateOnly();
  return { month: today.slice(0, 7), monthFrom: `${today.slice(0, 7)}-01`, monthTo: today };
}

function scope(tenantId, siteIds) {
  const { month, monthFrom, monthTo } = thisMonth();
  return { month, replacements: { tenantId, siteIds, monthFrom, monthTo }, siteClause: siteSqlClause(siteIds) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tyres: how many are fitted, in each store, away for remould; this month's purchases, punctures and scraps. A scrapped
// tyre's cost is what it cost in all (bought + repairs), as Tyre Stores shows it.

async function getTyreSummary({ tenantId, auth, query: params }) {
  const siteIds = siteFilterIds(auth, params.siteId);
  const { month, replacements, siteClause } = scope(tenantId, siteIds);

  const none = siteIds && siteIds.length === 0;
  const [{ counts, newStoreValue, scrapped }, events, [scrappedThisMonth]] = await Promise.all([
    tyreService.summary({ tenantId, auth, query: { siteId: params.siteId } }),
    none
      ? []
      : query(
          `SELECT event_type AS eventType, COUNT(*) AS total, SUM(COALESCE(amount, 0)) AS amount
             FROM tyre_events
            WHERE tenant_id = :tenantId AND event_date BETWEEN :monthFrom AND :monthTo
              AND event_type IN ('purchased', 'puncture', 'remould_back')${siteClause('site_id')}
            GROUP BY event_type`,
          replacements
        ),
    none
      ? [{}]
      : query(
          `SELECT COUNT(*) AS total, SUM(purchase_cost + repair_cost) AS cost, SUM(COALESCE(scrap_value, 0)) AS scrapValue
             FROM tyres
            WHERE tenant_id = :tenantId AND tyre_status = 'scrapped' AND scrapped_at BETWEEN :monthFrom AND :monthTo${siteClause('site_id')}`,
          replacements
        ),
  ]);

  const event = (type) => events.find((e) => e.eventType === type) ?? {};
  return {
    month,
    counts,
    newStoreValue,
    scrapped,
    thisMonth: {
      purchased: { count: num(event('purchased').total), cost: roundMoney(num(event('purchased').amount)) },
      punctures: num(event('puncture').total),
      remoulds: num(event('remould_back').total),
      repairCost: roundMoney(num(event('puncture').amount) + num(event('remould_back').amount)),
      scrapped: { count: num(scrappedThisMonth.total), cost: roundMoney(num(scrappedThisMonth.cost)), scrapValue: roundMoney(num(scrappedThisMonth.scrapValue)) },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// AdBlue: litres in stock and their value; this month's purchases and fillings.

async function getAdBlueSummary({ tenantId, auth, query: params }) {
  const siteIds = siteFilterIds(auth, params.siteId);
  const { month, replacements, siteClause } = scope(tenantId, siteIds);
  const none = siteIds && siteIds.length === 0;

  const monthTotals = (table, dateColumn) =>
    none
      ? [{}]
      : query(
          `SELECT COUNT(*) AS entries, SUM(quantity) AS quantity, SUM(total_cost) AS cost
             FROM ${table}
            WHERE tenant_id = :tenantId AND status = 'active' AND ${dateColumn} BETWEEN :monthFrom AND :monthTo${siteClause('site_id')}`,
          replacements
        );

  const [overview, [bought], [used]] = await Promise.all([
    adblueService.getOverview({ tenantId, auth, query: { siteId: params.siteId } }),
    monthTotals('adblue_purchases', 'purchase_date'),
    monthTotals('adblue_fillings', 'filling_date'),
  ]);

  const totals = (row) => ({ entries: num(row.entries), quantity: roundQuantity(num(row.quantity)), cost: roundMoney(num(row.cost)) });
  return {
    month,
    stock: overview.totals.remaining,
    thisMonth: { purchased: totals(bought), filled: totals(used) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Centring: what is held at the sites (and its value, for those who see costs); this month's movements.

async function getCentringSummary({ tenantId, auth, query: params }) {
  const siteIds = centringStock.siteFilter(auth, params.siteId);
  const { month, replacements } = scope(tenantId, siteIds);
  const withCost = can(auth, 'CENTRING', 'VIEW_COST');
  const none = siteIds && siteIds.length === 0;

  const [stock, moves] = await Promise.all([
    centringStock.stockRows(tenantId, { siteIds }),
    none
      ? []
      : query(
          `SELECT x.kind, COUNT(DISTINCT x.entry_id) AS entries, SUM(x.amount) AS amount
             FROM (
               SELECT e.id AS entry_id, e.to_site_id AS site_id, e.from_site_id, l.amount,
                      CASE WHEN e.entry_type <> 'adjustment' THEN e.entry_type
                           WHEN l.direction = 'out' THEN 'loss' ELSE 'found' END AS kind
                 FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
                WHERE e.tenant_id = :tenantId AND e.status = 'active' AND e.entry_date BETWEEN :monthFrom AND :monthTo
             ) x
            WHERE 1 = 1${siteIds ? " AND (x.site_id IN (:siteIds) OR (x.kind = 'transfer' AND x.from_site_id IN (:siteIds)))" : ''}
            GROUP BY x.kind`,
          replacements
        ),
  ]);

  const held = stock.filter((r) => r.quantity > 0);
  const move = (kind) => moves.find((m) => m.kind === kind) ?? {};
  const figure = (kind) => ({ entries: num(move(kind).entries), ...(withCost ? { value: roundMoney(num(move(kind).amount)) } : {}) });

  let stockValue;
  if (withCost) {
    const values = await centringStock.itemValues(tenantId, [...new Set(held.map((r) => r.itemId))]);
    stockValue = roundMoney(held.reduce((sum, r) => sum + centringStock.shareOfValue(r.quantity, values.get(r.itemId)), 0));
  }

  return {
    month,
    withCost,
    stock: {
      items: new Set(held.map((r) => r.itemId)).size,
      ...(withCost ? { value: stockValue } : {}),
    },
    thisMonth: {
      purchase: figure('purchase'),
      issue: figure('issue'),
      transfer: { entries: num(move('transfer').entries) },
      loss: figure('loss'),
    },
  };
}

module.exports = { getTyreSummary, getAdBlueSummary, getCentringSummary };
