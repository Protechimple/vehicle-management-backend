const { Op } = require('sequelize');

const { Battery, BatteryEvent, Vehicle, Machinery } = require('../models');
const AppError = require('../utils/AppError');
const { parseEnumFilter } = require('../utils/queryOptions');
const { optionalDateFilter, roundMoney, siteNamesById } = require('./fuelCommon');
const { assetsByKey, assetSummary } = require('./tyreCommon');
const { siteFilter, decorateEvents } = require('./battery.service');

function readDateRange(query) {
  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (!dateFrom && !dateTo) return null;
  return { ...(dateFrom ? { [Op.gte]: dateFrom } : {}), ...(dateTo ? { [Op.lte]: dateTo } : {}) };
}

async function assetKeysAtSite(tenantId, siteId) {
  const [vehicles, machines] = await Promise.all([
    Vehicle.findAll({ where: { tenantId, currentSiteId: siteId }, attributes: ['assetId'] }),
    Machinery.findAll({ where: { tenantId, currentSiteId: siteId }, attributes: ['assetId'] }),
  ]);
  return new Set([...vehicles.map((v) => `VEHICLE:${v.assetId}`), ...machines.map((m) => `MACHINERY:${m.assetId}`)]);
}

// Each vehicle or machine with battery activity: what is fitted now, and how often batteries were fitted and taken off.
async function assetReport({ tenantId, auth, query }) {
  const siteId = siteFilter(auth, query);
  const eventDate = readDateRange(query);
  const assetType = parseEnumFilter(query.assetType, Battery.ASSET_TYPES, 'Asset type');

  const eventWhere = { tenantId, eventType: ['fitted', 'removed'], ...(eventDate ? { eventDate } : {}), ...(assetType ? { assetType } : {}) };
  const [events, fittedNow] = await Promise.all([
    BatteryEvent.findAll({ where: eventWhere, order: [['eventDate', 'ASC'], ['id', 'ASC']] }),
    Battery.findAll({ where: { tenantId, batteryStatus: 'fitted', ...(assetType ? { assetType } : {}) }, order: [['position', 'ASC'], ['id', 'ASC']] }),
  ]);

  const keyOf = (r) => `${r.assetType}:${r.assetId}`;
  const keys = new Set(events.map(keyOf));
  if (!eventDate) for (const b of fittedNow) keys.add(keyOf(b));
  let allowed = null;
  if (siteId) allowed = await assetKeysAtSite(tenantId, siteId);

  const rowsByKey = new Map();
  for (const key of keys) {
    if (allowed && !allowed.has(key)) continue;
    const [type, ...rest] = key.split(':');
    rowsByKey.set(key, { assetType: type, assetId: rest.join(':'), fittings: 0, removals: 0, toRepair: 0, scrapped: 0, lastChange: null, fittedNow: [], events: [] });
  }

  const decorated = await decorateEvents(
    tenantId,
    events.filter((e) => rowsByKey.has(keyOf(e))),
    { withBattery: true }
  );
  for (const e of decorated) {
    const row = rowsByKey.get(keyOf(e));
    if (e.eventType === 'fitted') row.fittings += 1;
    else {
      row.removals += 1;
      if (e.outcome === 'needs_repair') row.toRepair += 1;
      if (e.outcome === 'scrapped') row.scrapped += 1;
    }
    if (!row.lastChange || e.eventDate > row.lastChange) row.lastChange = e.eventDate;
    row.events.push(e);
  }
  for (const b of fittedNow) {
    const row = rowsByKey.get(keyOf(b));
    if (row) row.fittedNow.push({ id: b.id, batteryCode: b.batteryCode, serialNumber: b.serialNumber, brand: b.brand, modelName: b.modelName, position: b.position, fittedAt: b.fittedAt });
  }

  const rows = [...rowsByKey.values()];
  const assets = await assetsByKey(tenantId, rows);
  const withAssets = rows.map((r) => ({ ...r, ...assetSummary(r.assetType, r.assetId, assets.get(keyOf(r))) }));
  const siteNames = await siteNamesById(tenantId, withAssets.map((r) => r.assetSiteId));
  const result = withAssets
    .map((r) => ({ ...r, siteName: siteNames.get(r.assetSiteId) ?? null }))
    .sort((a, b) => String(a.assetLabel).localeCompare(String(b.assetLabel)));

  return {
    rows: result,
    totals: {
      assets: result.length,
      fittedNow: result.reduce((t, r) => t + r.fittedNow.length, 0),
      fittings: result.reduce((t, r) => t + r.fittings, 0),
      removals: result.reduce((t, r) => t + r.removals, 0),
      toRepair: result.reduce((t, r) => t + r.toRepair, 0),
      scrapped: result.reduce((t, r) => t + r.scrapped, 0),
    },
  };
}

// Money and counts by site: batteries bought, repairs, and batteries scrapped in the period, plus what is at each site now.
async function costReport({ tenantId, auth, query }) {
  const siteId = siteFilter(auth, query);
  const eventDate = readDateRange(query);

  const events = await BatteryEvent.findAll({
    where: { tenantId, eventType: ['purchased', 'repaired', 'scrapped'], ...(siteId ? { siteId } : {}), ...(eventDate ? { eventDate } : {}) },
    attributes: ['siteId', 'eventType', 'amount'],
  });
  const stored = await Battery.findAll({
    where: { tenantId, batteryStatus: ['ready', 'needs_repair'], ...(siteId ? { siteId } : {}) },
    attributes: ['siteId', 'batteryStatus'],
  });

  const bySite = new Map();
  const rowFor = (id) => {
    if (!bySite.has(id)) {
      bySite.set(id, { siteId: id, purchased: 0, purchaseCost: 0, repairs: 0, repairCost: 0, scrapped: 0, scrapValue: 0, readyNow: 0, needsRepairNow: 0 });
    }
    return bySite.get(id);
  };
  for (const e of events) {
    const row = rowFor(e.siteId);
    const amount = Number(e.amount ?? 0);
    if (e.eventType === 'purchased') {
      row.purchased += 1;
      row.purchaseCost = roundMoney(row.purchaseCost + amount);
    } else if (e.eventType === 'repaired') {
      row.repairs += 1;
      row.repairCost = roundMoney(row.repairCost + amount);
    } else {
      row.scrapped += 1;
      row.scrapValue = roundMoney(row.scrapValue + amount);
    }
  }
  for (const b of stored) {
    const row = rowFor(b.siteId);
    if (b.batteryStatus === 'ready') row.readyNow += 1;
    else row.needsRepairNow += 1;
  }

  const siteNames = await siteNamesById(tenantId, [...bySite.keys()]);
  const rows = [...bySite.values()]
    .map((r) => ({ ...r, siteName: siteNames.get(r.siteId) ?? null }))
    .sort((a, b) => String(a.siteName).localeCompare(String(b.siteName)));
  const sum = (key) => roundMoney(rows.reduce((t, r) => t + r[key], 0));
  return {
    rows,
    totals: {
      purchased: sum('purchased'),
      purchaseCost: sum('purchaseCost'),
      repairs: sum('repairs'),
      repairCost: sum('repairCost'),
      scrapped: sum('scrapped'),
      scrapValue: sum('scrapValue'),
      readyNow: sum('readyNow'),
      needsRepairNow: sum('needsRepairNow'),
    },
  };
}

module.exports = { assetReport, costReport };
