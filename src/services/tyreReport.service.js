const { Op } = require('sequelize');

const { Tyre, TyreEvent, TyreAssetLayout, TyrePurchase, TyrePurchaseItem, TyreType } = require('../models');
const AppError = require('../utils/AppError');
const { parseEnumFilter } = require('../utils/queryOptions');
const { optionalDateFilter, roundMoney, siteNamesById } = require('./fuelCommon');
const { siteFilter, assetsByKey, assetSummary } = require('./tyreCommon');

function readRange(query) {
  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  return { dateFrom: dateFrom ?? null, dateTo: dateTo ?? null };
}

function dateRange(column, { dateFrom, dateTo }) {
  if (!dateFrom && !dateTo) return {};
  const range = {};
  if (dateFrom) range[Op.gte] = dateFrom;
  if (dateTo) range[Op.lte] = dateTo;
  return { [column]: range };
}

const sum = (list, pick) => roundMoney(list.reduce((t, x) => t + Number(pick(x) ?? 0), 0));

// One row per vehicle / machine: tyres fitted, punctures, run and money spent on its tyres in the period.
async function assetReport({ tenantId, auth, query }) {
  const range = readRange(query);
  const siteId = siteFilter(auth, query);
  const assetType = parseEnumFilter(query.assetType, Tyre.ASSET_TYPES, 'Asset type');
  const assetWhere = assetType ? { assetType } : { assetType: { [Op.ne]: null } };

  const [events, fittedNow] = await Promise.all([
    TyreEvent.findAll({
      where: { tenantId, eventType: ['fitted', 'removed', 'puncture'], ...assetWhere, ...(siteId ? { siteId } : {}), ...dateRange('eventDate', range) },
      order: [['eventDate', 'ASC'], ['id', 'ASC']],
    }),
    Tyre.findAll({ where: { tenantId, tyreStatus: 'fitted', ...(assetType ? { assetType } : {}) }, attributes: ['assetType', 'assetId'] }),
  ]);
  const assets = await assetsByKey(tenantId, events);
  const layouts = await TyreAssetLayout.findAll({ where: { tenantId }, attributes: ['assetType', 'assetId', 'axles'] });
  const needed = new Map(layouts.map((l) => [`${l.assetType}:${l.assetId}`, l.axleList.reduce((t, n) => t + n, 0)]));
  const onNow = fittedNow.reduce((map, t) => map.set(`${t.assetType}:${t.assetId}`, (map.get(`${t.assetType}:${t.assetId}`) ?? 0) + 1), new Map());

  const groups = new Map();
  for (const e of events) {
    const key = `${e.assetType}:${e.assetId}`;
    if (!groups.has(key)) {
      const asset = assets.get(key);
      groups.set(key, { ...assetSummary(e.assetType, e.assetId, asset), meterType: e.meterType, fitted: 0, punctures: 0, run: 0, tyreCost: 0, punctureCost: 0 });
    }
    const g = groups.get(key);
    if (e.eventType === 'fitted') {
      g.fitted += 1;
      g.tyreCost = roundMoney(g.tyreCost + Number(e.amount ?? 0));
    }
    if (e.eventType === 'puncture') {
      g.punctures += 1;
      g.punctureCost = roundMoney(g.punctureCost + Number(e.amount ?? 0));
    }
    if (e.eventType === 'removed' && e.meterType === g.meterType) g.run = roundMoney(g.run + Number(e.runValue ?? 0));
  }

  const siteNames = await siteNamesById(tenantId, [...groups.values()].map((g) => g.assetSiteId));
  const rows = [...groups.entries()]
    .map(([key, g]) => ({
      ...g,
      key,
      siteName: siteNames.get(g.assetSiteId) ?? null,
      tyresNeeded: needed.get(key) ?? null,
      tyresOnNow: onNow.get(key) ?? 0,
      totalCost: roundMoney(g.tyreCost + g.punctureCost),
    }))
    .sort((a, b) => b.totalCost - a.totalCost || String(a.assetLabel).localeCompare(String(b.assetLabel)));

  return {
    ...range,
    totals: {
      assets: rows.length,
      tyresFitted: rows.reduce((t, r) => t + r.fitted, 0),
      punctures: rows.reduce((t, r) => t + r.punctures, 0),
      tyreCost: sum(rows, (r) => r.tyreCost),
      punctureCost: sum(rows, (r) => r.punctureCost),
      totalCost: sum(rows, (r) => r.totalCost),
    },
    rows,
  };
}

// Where the tyre money went in the period, and what is in the stores now.
async function costReport({ tenantId, auth, query }) {
  const range = readRange(query);
  const siteId = siteFilter(auth, query);
  const siteWhere = siteId ? { siteId } : {};

  const [purchases, events, tyres] = await Promise.all([
    TyrePurchase.findAll({ where: { tenantId, status: 'active', ...siteWhere, ...dateRange('purchaseDate', range) } }),
    TyreEvent.findAll({ where: { tenantId, eventType: ['added_spare', 'puncture', 'remould_back', 'scrapped'], ...siteWhere, ...dateRange('eventDate', range) } }),
    Tyre.findAll({ where: { tenantId, ...siteWhere } }),
  ]);
  const items = purchases.length ? await TyrePurchaseItem.findAll({ where: { tenantId, purchaseId: purchases.map((p) => p.id) } }) : [];
  const tyreById = new Map(tyres.map((t) => [t.id, t]));
  const byKind = (type) => events.filter((e) => e.eventType === type);
  const scrapped = byKind('scrapped');

  const typeIds = [...new Set([...items.map((i) => i.tyreTypeId), ...tyres.map((t) => t.tyreTypeId)])];
  const types = typeIds.length ? await TyreType.findAll({ where: { tenantId, id: typeIds } }) : [];
  const byType = new Map(
    types.map((t) => [t.id, { tyreTypeId: t.id, tyreTypeLabel: t.label, tyreSize: t.size, bought: 0, purchaseCost: 0, newStore: 0, spareStore: 0, fitted: 0, scrapped: 0, repairCost: 0 }])
  );
  for (const i of items) {
    const row = byType.get(i.tyreTypeId);
    row.bought += i.quantity;
    row.purchaseCost = roundMoney(row.purchaseCost + Number(i.lineTotal));
  }
  for (const t of tyres) {
    const row = byType.get(t.tyreTypeId);
    if (t.tyreStatus === 'new') row.newStore += 1;
    if (t.tyreStatus === 'spare') row.spareStore += 1;
    if (t.tyreStatus === 'fitted') row.fitted += 1;
  }
  for (const e of events) {
    const tyre = tyreById.get(e.tyreId);
    const row = tyre && byType.get(tyre.tyreTypeId);
    if (!row) continue;
    if (e.eventType === 'scrapped') row.scrapped += 1;
    if (TyreEvent.REPAIR_EVENTS.includes(e.eventType)) row.repairCost = roundMoney(row.repairCost + Number(e.amount ?? 0));
  }

  const bySupplier = new Map();
  for (const p of purchases) {
    const name = p.supplierName?.trim() || null;
    const key = name ? name.toLowerCase() : 'none';
    const row = bySupplier.get(key) ?? { key, supplierName: name ?? 'No supplier', purchases: 0, tyres: 0, beforeTax: 0, tax: 0, total: 0 };
    row.purchases += 1;
    row.tyres += p.tyreCount;
    row.beforeTax = roundMoney(row.beforeTax + Number(p.subtotalAmount));
    row.tax = roundMoney(row.tax + Number(p.taxAmount));
    row.total = roundMoney(row.total + Number(p.totalAmount));
    bySupplier.set(key, row);
  }

  const inStatus = (status) => tyres.filter((t) => t.tyreStatus === status);
  return {
    ...range,
    totals: {
      purchaseCost: sum(purchases, (p) => p.totalAmount),
      purchaseTax: sum(purchases, (p) => p.taxAmount),
      tyresBought: purchases.reduce((t, p) => t + p.tyreCount, 0),
      sparesAdded: byKind('added_spare').length,
      punctures: byKind('puncture').length,
      punctureCost: sum(byKind('puncture'), (e) => e.amount),
      remoulds: byKind('remould_back').length,
      remouldCost: sum(byKind('remould_back'), (e) => e.amount),
      scrapped: scrapped.length,
      scrapValue: sum(scrapped, (e) => e.amount),
      // What the scrapped tyres had cost in all (purchase + punctures + remoulds).
      scrappedTyreCost: sum(scrapped, (e) => tyreById.get(e.tyreId)?.totalCost),
      newStore: inStatus('new').length,
      newStoreValue: sum(inStatus('new'), (t) => t.purchaseCost),
      spareStore: inStatus('spare').length,
      fitted: inStatus('fitted').length,
      atRemould: inStatus('remould').length,
    },
    byType: [...byType.values()]
      .filter((r) => r.bought || r.newStore || r.spareStore || r.fitted || r.scrapped || r.repairCost)
      .sort((a, b) => b.purchaseCost - a.purchaseCost || a.tyreTypeLabel.localeCompare(b.tyreTypeLabel)),
    bySupplier: [...bySupplier.values()].sort((a, b) => b.total - a.total),
  };
}

module.exports = { assetReport, costReport };
