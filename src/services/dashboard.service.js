const { QueryTypes } = require('sequelize');

const { sequelize } = require('../models');
const { siteFilterIds, siteSqlClause } = require('./siteAccess');
const { can } = require('../config/permissions');
const { todayDateOnly, roundMoney, roundQuantity } = require('./fuelCommon');

const TREND_MONTHS = 6;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateOnly(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function query(sql, replacements) {
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
}

function num(value) {
  return value == null ? 0 : Number(value);
}

async function fleetSummary(tenantId, siteClause, replacements) {
  const [vehicles] = await query(
    `SELECT COUNT(*) AS total
       FROM vehicles
      WHERE tenant_id = :tenantId AND status = 'active'${siteClause('current_site_id')}`,
    replacements
  );

  const [machinery] = await query(
    `SELECT COUNT(*) AS total
       FROM machinery
      WHERE tenant_id = :tenantId AND status = 'active'${siteClause('current_site_id')}`,
    replacements
  );

  const [siteRow] = await query(
    `SELECT COUNT(*) AS total FROM sites WHERE tenant_id = :tenantId AND status = 'active'${siteClause('id')}`,
    replacements
  );
  const sites = num(siteRow.total);

  return {
    vehicles: num(vehicles.total),
    machinery: num(machinery.total),
    sites,
  };
}

async function monthlyTrend(tenantId, siteClause, replacements, now) {
  const first = new Date(now.getFullYear(), now.getMonth() - (TREND_MONTHS - 1), 1);
  const months = Array.from({ length: TREND_MONTHS }, (_, i) => monthKey(new Date(first.getFullYear(), first.getMonth() + i, 1)));
  const offsetMinutes = -now.getTimezoneOffset();
  const dateRange = { ...replacements, fromDate: dateOnly(first), today: dateOnly(now) };
  const timeRange = { ...replacements, offsetMinutes, fromAt: first, nowAt: now };
  const localMonth = (column) => `DATE_FORMAT(DATE_ADD(${column}, INTERVAL :offsetMinutes MINUTE), '%Y-%m')`;

  const [fuelUsed, fuelBought, inventory, issues] = await Promise.all([
    query(
      `SELECT DATE_FORMAT(txn_date, '%Y-%m') AS month,
              COALESCE(SUM(amount), 0) AS cost, COALESCE(SUM(quantity), 0) AS litres, COUNT(*) AS fills,
              COALESCE(SUM(CASE WHEN source = 'DIRECT_PUMP' THEN amount ELSE 0 END), 0) AS directCost,
              COALESCE(SUM(CASE WHEN source = 'DIRECT_PUMP' THEN quantity ELSE 0 END), 0) AS directLitres
         FROM fuel_transactions
        WHERE tenant_id = :tenantId AND status = 'active' AND txn_date >= :fromDate AND txn_date <= :today${siteClause('site_id')}
        GROUP BY month`,
      dateRange
    ),
    query(
      `SELECT DATE_FORMAT(collection_date, '%Y-%m') AS month, COALESCE(SUM(amount), 0) AS cost, COALESCE(SUM(quantity), 0) AS litres
         FROM fuel_collections
        WHERE tenant_id = :tenantId AND status <> 'cancelled' AND collection_date >= :fromDate AND collection_date <= :today${siteClause('site_id')}
        GROUP BY month`,
      dateRange
    ),
    query(
      `SELECT ${localMonth('transaction_at')} AS month,
              COALESCE(SUM(CASE WHEN transaction_type = 'ISSUE' THEN total_cost
                                WHEN transaction_type = 'ISSUE_REVERSAL' THEN -total_cost ELSE 0 END), 0) AS parts,
              COALESCE(SUM(CASE WHEN transaction_type = 'PURCHASE_RECEIPT' THEN total_cost ELSE 0 END), 0) AS purchases
         FROM inventory_transactions
        WHERE tenant_id = :tenantId AND status = 'posted' AND transaction_type IN ('ISSUE', 'ISSUE_REVERSAL', 'PURCHASE_RECEIPT')
          AND transaction_at >= :fromAt AND transaction_at <= :nowAt${siteClause('site_id')}
        GROUP BY month`,
      timeRange
    ),
    query(
      `SELECT ${localMonth('issue_date_time')} AS month, COUNT(*) AS total
         FROM asset_issues
        WHERE tenant_id = :tenantId AND issue_date_time >= :fromAt AND issue_date_time <= :nowAt${siteClause('site_id')}
        GROUP BY month`,
      timeRange
    ),
  ]);

  const byMonth = (rows) => new Map(rows.map((r) => [r.month, r]));
  const used = byMonth(fuelUsed);
  const bought = byMonth(fuelBought);
  const stock = byMonth(inventory);
  const issued = byMonth(issues);

  return months.map((month) => {
    const u = used.get(month) ?? {};
    const b = bought.get(month) ?? {};
    const i = stock.get(month) ?? {};
    const fuel = roundMoney(num(u.cost));
    const parts = roundMoney(num(i.parts));
    return {
      month,
      fuel,
      parts,
      total: roundMoney(fuel + parts),
      fuelLitres: roundQuantity(num(u.litres)),
      fills: num(u.fills),
      issues: num(issued.get(month)?.total),
      purchases: roundMoney(num(i.purchases)),
      fuelBought: roundMoney(num(b.cost) + num(u.directCost)),
      fuelBoughtLitres: roundQuantity(num(b.litres) + num(u.directLitres)),
    };
  });
}

// The dashboard covers the sites asked for, or every site the user covers. A Site Manager sees all of theirs together.
function requestedSiteScope(tenantId, auth, query = {}) {
  const siteIds = siteFilterIds(auth, query.siteId);
  return {
    siteIds,
    replacements: { tenantId, siteIds },
    siteClause: siteSqlClause(siteIds),
  };
}

// Figures from modules the user may not open are sent as zero, so the dashboard never shows more than the screens would.
function visibility(auth) {
  return { fuel: can(auth, 'FUEL', 'READ'), parts: can(auth, 'STOCK', 'READ') };
}

function redactMonth(month, { fuel, parts }) {
  const out = { ...month };
  if (!fuel) Object.assign(out, { fuel: 0, fuelLitres: 0, fills: 0, fuelBought: 0, fuelBoughtLitres: 0 });
  if (!parts) Object.assign(out, { parts: 0, issues: 0, purchases: 0 });
  out.total = roundMoney(out.fuel + out.parts);
  return out;
}

function scopeOf(siteIds) {
  return { siteId: siteIds && siteIds.length === 1 ? siteIds[0] : null, siteIds };
}

async function getSummary({ tenantId, auth, query }) {
  const { siteIds, replacements, siteClause } = requestedSiteScope(tenantId, auth, query);

  const now = new Date();
  const today = todayDateOnly();

  const [fleet, monthly] = await Promise.all([
    fleetSummary(tenantId, siteClause, replacements),
    monthlyTrend(tenantId, siteClause, replacements, now),
  ]);

  return {
    generatedAt: now.toISOString(),
    period: { today },
    scope: scopeOf(siteIds),
    visible: visibility(auth),
    fleet,
    monthly: monthly.map((m) => redactMonth(m, visibility(auth))),
  };
}

async function getMonthlyCost({ tenantId, auth, query }) {
  const { siteIds, replacements, siteClause } = requestedSiteScope(tenantId, auth, query);

  return {
    scope: scopeOf(siteIds),
    visible: visibility(auth),
    monthly: (await monthlyTrend(tenantId, siteClause, replacements, new Date())).map((m) => redactMonth(m, visibility(auth))),
  };
}

async function getFleet({ tenantId, auth, query }) {
  const { siteIds, replacements, siteClause } = requestedSiteScope(tenantId, auth, query);

  return {
    scope: scopeOf(siteIds),
    fleet: await fleetSummary(tenantId, siteClause, replacements),
  };
}

module.exports = { getSummary, getMonthlyCost, getFleet };
