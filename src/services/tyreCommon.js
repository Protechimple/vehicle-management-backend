const { Site, Vehicle, Machinery } = require('../models');
const AppError = require('../utils/AppError');
const { requireIdFilter } = require('../utils/validation');
const { supervisorSiteId } = require('./siteAccess');

function siteFilter(auth, query) {
  const own = supervisorSiteId(auth);
  if (own !== null) return own;
  return query.siteId ? requireIdFilter(query.siteId, 'Site') : null;
}

function meterTypeFor(assetType, asset) {
  if (assetType === 'MACHINERY') return 'HOURS';
  return asset.isHoursBased ? 'HOURS' : 'KM';
}

// Times go next to dates as HH:MM:00, the same as fuel transactions.
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

function readTime(value, label = 'Time') {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value.trim())) throw AppError.badRequest(`${label} is required (HH:MM)`);
  return `${value.trim().slice(0, 5)}:00`;
}

// True when date+time A is before date+time B. On the same day, a missing time is never "before".
function isBefore(dateA, timeA, dateB, timeB) {
  if (dateA !== dateB) return dateA < dateB;
  if (!timeA || !timeB) return false;
  return String(timeA).slice(0, 5) < String(timeB).slice(0, 5);
}

function formatWhen(dateOnly, time) {
  const [y, m, d] = String(dateOnly).split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  return time ? `${day}, ${String(time).slice(0, 5)}` : day;
}

function meterUnit(meterType) {
  return meterType === 'HOURS' ? 'hours' : 'KM';
}

function formatReading(value) {
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

async function assertSiteUsable(tenantId, siteId) {
  const id = Number(siteId);
  if (!Number.isInteger(id) || id < 1) throw AppError.badRequest('Site is required');
  const site = await Site.findOne({ where: { tenantId, id } });
  if (!site) throw AppError.badRequest('Site not found');
  if (site.status !== 'active') throw AppError.badRequest('This site is archived and cannot be used');
  return id;
}

async function assetsByKey(tenantId, rows) {
  const vehicleIds = [...new Set(rows.filter((r) => r.assetType === 'VEHICLE').map((r) => r.assetId))];
  const machineIds = [...new Set(rows.filter((r) => r.assetType === 'MACHINERY').map((r) => r.assetId))];
  const [vehicles, machines] = await Promise.all([
    vehicleIds.length ? Vehicle.findAll({ where: { tenantId, assetId: vehicleIds } }) : [],
    machineIds.length ? Machinery.findAll({ where: { tenantId, assetId: machineIds } }) : [],
  ]);
  const map = new Map();
  for (const v of vehicles) map.set(`VEHICLE:${v.assetId}`, v);
  for (const m of machines) map.set(`MACHINERY:${m.assetId}`, m);
  return map;
}

function assetSummary(assetType, assetId, asset) {
  if (!asset) return { assetType, assetId, assetLabel: assetId, assetRecordId: null, assetKind: assetType === 'VEHICLE' ? 'Vehicle' : 'Machinery', assetSiteId: null };
  const label =
    assetType === 'VEHICLE' ? asset.registrationNumber : Machinery.label(asset);
  return {
    assetType,
    assetId,
    assetLabel: label,
    assetRecordId: asset.id,
    assetKind: assetType === 'VEHICLE' ? asset.type : 'Machinery',
    assetSiteId: asset.currentSiteId ?? null,
  };
}

function tyreTypeSummary(tyreType) {
  if (!tyreType) return { tyreTypeLabel: null, tyreBrand: null, tyrePattern: null, tyreSize: null };
  // Brand, pattern / model and size separately, for their own columns; the label joins brand and pattern.
  return { tyreTypeLabel: tyreType.label, tyreBrand: tyreType.brand, tyrePattern: tyreType.pattern || null, tyreSize: tyreType.size, tyreTypeCode: tyreType.typeCode };
}

module.exports = {
  siteFilter,
  meterTypeFor,
  readTime,
  isBefore,
  formatWhen,
  meterUnit,
  formatReading,
  assertSiteUsable,
  assetsByKey,
  assetSummary,
  tyreTypeSummary,
};
