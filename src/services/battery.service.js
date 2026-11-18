const { Op, Transaction, UniqueConstraintError, fn, col } = require('sequelize');

const { sequelize, Battery, BatteryEvent, Vehicle, Machinery, User } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, optionalText, requireNumber, optionalNumber, requireIdFilter } = require('../utils/validation');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { createTenantScopedRepository } = require('./tenantScopedRepository');
const { recordAudit, recordCreate, recordUpdate } = require('./audit.service');
const { assertSiteAllowed, supervisorSiteId } = require('./siteAccess');
const { resolveAsset } = require('./asset.service');
const { assetRefsMatchingNumber } = require('./assetIdentifier.service');
const { nextSequentialCode } = require('./codeGenerator');
const { requireBusinessDate, optionalDateFilter, roundMoney, siteNamesById, todayDateOnly } = require('./fuelCommon');
const { meterTypeFor, assertSiteUsable, assetsByKey, assetSummary, formatReading, meterUnit } = require('./tyreCommon');

const repo = createTenantScopedRepository(Battery);
const eventRepo = createTenantScopedRepository(BatteryEvent);

const CODE_PREFIX = 'BAT';
const MAX_BATTERIES_PER_PURCHASE = 50;
const MAX_COST = 10000000;
const NOT_FOUND = 'Battery not found';
const STORED = ['ready', 'needs_repair'];
// The words the screens use, so error messages match what people see.
const STATUS_LABELS = { ready: 'In Store', fitted: 'Fitted', needs_repair: 'Under Repair', scrapped: 'Scrapped' };

// ---------------------------------------------------------------------------------------------------------------------
// Input helpers

function formatDate(dateOnly) {
  const [y, m, d] = String(dateOnly).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function readAssetType(value) {
  const assetType = requireText(value, 'Asset type', { max: 20 }).toUpperCase();
  if (!Battery.ASSET_TYPES.includes(assetType)) throw AppError.badRequest('Asset type must be VEHICLE or MACHINERY');
  return assetType;
}

function readMoney(value, label, { required = false } = {}) {
  const number = required ? requireNumber(value, label, { min: 0, max: MAX_COST }) : optionalNumber(value, label, { min: 0, max: MAX_COST });
  return number == null ? null : roundMoney(number);
}

function readWholeNumber(value, label, { min, max }) {
  const number = optionalNumber(value, label, { min, max });
  if (number != null && !Number.isInteger(number)) throw AppError.badRequest(`${label} must be a whole number`);
  return number;
}

function readReading(value) {
  const number = optionalNumber(value, 'Meter reading', { min: 0, max: 99999999 });
  return number == null ? null : roundMoney(number);
}

function readOutcome(value) {
  const outcome = requireText(value, 'What happens to the removed battery', { max: 20 });
  if (!Battery.STATUSES.includes(outcome) || outcome === 'fitted') {
    throw AppError.badRequest('Choose what happens to the removed battery: ready, needs_repair or scrapped');
  }
  return outcome;
}

function readScrapReason(outcome, value) {
  if (outcome !== 'scrapped') return null;
  return requireText(value, 'Scrap reason', { max: 500 });
}

function readBatteryDetails(raw, prefix = '') {
  return {
    serialNumber: requireText(raw?.serialNumber, `${prefix}Serial number`, { max: 64 }).toUpperCase(),
    brand: requireText(raw?.brand, `${prefix}Brand`, { max: 100 }),
    modelName: optionalText(raw?.modelName, `${prefix}Model`, { max: 100 }),
    capacityAh: readWholeNumber(raw?.capacityAh, `${prefix}Capacity (Ah)`, { min: 1, max: 10000 }),
    voltage: readWholeNumber(raw?.voltage, `${prefix}Voltage`, { min: 1, max: 1000 }),
    purchaseCost: readMoney(raw?.purchaseCost, `${prefix}Cost`, { required: true }),
    warrantyMonths: readWholeNumber(raw?.warrantyMonths, `${prefix}Warranty (months)`, { min: 0, max: 240 }),
  };
}

function isUniqueSerialError(error) {
  return error instanceof UniqueConstraintError && Object.keys(error.fields ?? {}).some((key) => key.includes('serial'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Site visibility. A fitted battery is where its asset is now; a stored battery is at its own site.

async function atSiteCondition(tenantId, siteId) {
  const [vehicles, machines] = await Promise.all([
    Vehicle.findAll({ where: { tenantId, currentSiteId: siteId }, attributes: ['assetId'] }),
    Machinery.findAll({ where: { tenantId, currentSiteId: siteId }, attributes: ['assetId'] }),
  ]);
  const or = [{ siteId, batteryStatus: { [Op.ne]: 'fitted' } }];
  if (vehicles.length) or.push({ batteryStatus: 'fitted', assetType: 'VEHICLE', assetId: vehicles.map((v) => v.assetId) });
  if (machines.length) or.push({ batteryStatus: 'fitted', assetType: 'MACHINERY', assetId: machines.map((m) => m.assetId) });
  return { [Op.or]: or };
}

function siteFilter(auth, query) {
  const own = supervisorSiteId(auth);
  if (own !== null) return own;
  return query.siteId ? requireIdFilter(query.siteId, 'Site') : null;
}

async function currentSiteOf(tenantId, battery, transaction) {
  if (battery.batteryStatus !== 'fitted') return battery.siteId;
  const model = battery.assetType === 'VEHICLE' ? Vehicle : Machinery;
  const asset = await model.findOne({ where: { tenantId, assetId: battery.assetId }, attributes: ['currentSiteId'], transaction });
  return asset?.currentSiteId ?? battery.siteId;
}

async function findVisible(tenantId, auth, id, options = {}) {
  const battery = await repo.findByPk(tenantId, id, options);
  if (!battery) throw AppError.notFound(NOT_FOUND);
  assertSiteAllowed(auth, await currentSiteOf(tenantId, battery, options.transaction), NOT_FOUND);
  return battery;
}

async function lockBattery(tenantId, id, transaction) {
  const battery = await Battery.findOne({ where: { tenantId, id }, transaction, lock: Transaction.LOCK.UPDATE });
  if (!battery) throw AppError.notFound(NOT_FOUND);
  return battery;
}

async function lastEvent(tenantId, batteryId, transaction) {
  return BatteryEvent.findOne({ where: { tenantId, batteryId }, order: [['eventDate', 'DESC'], ['id', 'DESC']], transaction });
}

async function assertNotBeforeLastEvent(tenantId, battery, date, label, transaction) {
  const last = await lastEvent(tenantId, battery.id, transaction);
  if (last && date < last.eventDate) {
    throw AppError.badRequest(`${label} (${formatDate(date)}) can't be before ${formatDate(last.eventDate)}, the last entry in the history of battery ${battery.batteryCode}.`);
  }
}

function assertStatus(battery, allowed, action) {
  if (allowed.includes(battery.batteryStatus)) return;
  throw AppError.conflict(`Battery ${battery.batteryCode} is ${STATUS_LABELS[battery.batteryStatus]}, so it can't be ${action}.`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

function assetSummaryFor(row, assets) {
  if (!row.assetType || !row.assetId) return {};
  return assetSummary(row.assetType, row.assetId, assets.get(`${row.assetType}:${row.assetId}`));
}

async function decorate(tenantId, batteries) {
  if (batteries.length === 0) return [];
  const fitted = batteries.filter((b) => b.batteryStatus === 'fitted');
  const assets = await assetsByKey(tenantId, fitted);
  const today = todayDateOnly();
  const rows = batteries.map((b) => {
    const json = b.toPublicJSON();
    const isFitted = b.batteryStatus === 'fitted';
    const record = isFitted ? assets.get(`${b.assetType}:${b.assetId}`) : null;
    const asset = isFitted ? assetSummaryFor(b, assets) : {};
    const currentSiteId = isFitted ? asset.assetSiteId ?? b.siteId : b.siteId;
    return {
      ...json,
      ...asset,
      assetMeterType: record ? meterTypeFor(b.assetType, record) : null,
      currentSiteId,
      inWarranty: json.warrantyUntil != null && json.warrantyUntil >= today,
    };
  });
  const siteNames = await siteNamesById(tenantId, rows.map((r) => r.currentSiteId));
  return rows.map((r) => ({ ...r, siteName: siteNames.get(r.currentSiteId) ?? null }));
}

async function decorateEvents(tenantId, events, { withBattery = false } = {}) {
  if (events.length === 0) return [];
  const batteryIds = new Set();
  for (const e of events) {
    if (withBattery) batteryIds.add(e.batteryId);
    if (e.relatedBatteryId) batteryIds.add(e.relatedBatteryId);
  }
  const [assets, siteNames, users, batteries] = await Promise.all([
    assetsByKey(tenantId, events.filter((e) => e.assetType && e.assetId)),
    siteNamesById(tenantId, events.map((e) => e.siteId)),
    User.findAll({ where: { tenantId, id: [...new Set(events.map((e) => e.createdBy))] }, attributes: ['id', 'name'] }),
    batteryIds.size ? Battery.findAll({ where: { tenantId, id: [...batteryIds] }, attributes: ['id', 'batteryCode', 'serialNumber', 'brand', 'modelName'] }) : [],
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const batteryById = new Map(batteries.map((b) => [b.id, b]));
  return events.map((e) => {
    const battery = batteryById.get(e.batteryId);
    const related = batteryById.get(e.relatedBatteryId);
    return {
      ...e.toPublicJSON(),
      ...assetSummaryFor(e, assets),
      siteName: siteNames.get(e.siteId) ?? null,
      createdByName: userNames.get(e.createdBy) ?? null,
      ...(withBattery && battery
        ? { batteryCode: battery.batteryCode, serialNumber: battery.serialNumber, brand: battery.brand, modelName: battery.modelName }
        : {}),
      relatedBatteryCode: related?.batteryCode ?? null,
      relatedSerialNumber: related?.serialNumber ?? null,
    };
  });
}

async function detailOf(tenantId, battery) {
  const [row] = await decorate(tenantId, [battery]);
  const events = await BatteryEvent.findAll({ where: { tenantId, batteryId: battery.id }, order: [['eventDate', 'ASC'], ['id', 'ASC']] });
  return { ...row, events: await decorateEvents(tenantId, events) };
}

// ---------------------------------------------------------------------------------------------------------------------
// History rows

function createEvent(tenantId, data, { actingUserId, transaction }) {
  return eventRepo.create(tenantId, { ...data, createdBy: actingUserId }, { transaction });
}

async function saveBattery(tenantId, battery, changes, { actingUserId, transaction }) {
  const before = battery.toJSON();
  await battery.update({ ...changes, updatedBy: actingUserId }, { transaction });
  await recordUpdate({ tenantId, entityType: 'Battery', entityId: battery.id, performedBy: actingUserId, before, after: battery }, { transaction });
}

// ---------------------------------------------------------------------------------------------------------------------
// Purchase

async function purchaseBatteries({ tenantId, auth, actingUserId, payload }) {
  const own = supervisorSiteId(auth);
  const siteId = own ?? requireNumber(payload.siteId, 'Site', { min: 1 });
  const purchaseDate = requireBusinessDate(payload.purchaseDate, 'Purchase date');
  const supplierName = optionalText(payload.supplierName, 'Supplier', { max: 255 });
  const invoiceNumber = optionalText(payload.invoiceNumber, 'Invoice number', { max: 64 });
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });

  if (!Array.isArray(payload.batteries) || payload.batteries.length === 0) throw AppError.badRequest('Add at least one battery');
  if (payload.batteries.length > MAX_BATTERIES_PER_PURCHASE) {
    throw AppError.badRequest(`You can add at most ${MAX_BATTERIES_PER_PURCHASE} batteries at once`);
  }
  const lines = payload.batteries.map((raw, index) => readBatteryDetails(raw, `Battery ${index + 1}: `));
  const seen = new Set();
  for (const line of lines) {
    if (seen.has(line.serialNumber)) throw AppError.badRequest(`Serial number ${line.serialNumber} is listed twice.`);
    seen.add(line.serialNumber);
  }

  await assertSiteUsable(tenantId, siteId);
  const existing = await Battery.findAll({ where: { tenantId, serialNumber: [...seen] }, attributes: ['serialNumber', 'batteryCode'] });
  if (existing.length) {
    const taken = existing[0];
    throw AppError.conflict(`Serial number ${taken.serialNumber} is already recorded as battery ${taken.batteryCode}.`);
  }

  try {
    const created = await sequelize.transaction(async (transaction) => {
      const records = [];
      for (const line of lines) {
        const batteryCode = await nextSequentialCode(Battery, 'batteryCode', CODE_PREFIX, { tenantId, transaction });
        const battery = await repo.create(
          tenantId,
          { ...line, batteryCode, purchaseDate, supplierName, invoiceNumber, notes, siteId, batteryStatus: 'ready', createdBy: actingUserId, updatedBy: actingUserId },
          { transaction }
        );
        await createEvent(
          tenantId,
          { batteryId: battery.id, eventType: 'purchased', eventDate: purchaseDate, siteId, amount: line.purchaseCost, vendor: supplierName, notes: invoiceNumber ? `Invoice ${invoiceNumber}` : null },
          { actingUserId, transaction }
        );
        await recordCreate({ tenantId, entityType: 'Battery', entityId: battery.id, performedBy: actingUserId, after: battery }, { transaction });
        records.push(battery);
      }
      return records;
    });
    return decorate(tenantId, created);
  } catch (error) {
    if (isUniqueSerialError(error)) throw AppError.conflict('One of these serial numbers was just recorded by someone else. Reload and check the serial numbers.');
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fit, remove, replace

async function lockActiveAsset(tenantId, auth, assetType, assetId, transaction) {
  const asset = await resolveAsset(tenantId, assetType, assetId, { transaction, auth, lock: transaction.LOCK.UPDATE });
  const noun = assetType === 'VEHICLE' ? 'vehicle' : 'machine';
  if (asset.status !== 'active') throw AppError.badRequest(`This ${noun} is archived, so a battery can't be fitted to it.`);
  if (!asset.currentSiteId) throw AppError.badRequest(`This ${noun} isn't assigned to a site, so there is no battery storage to fit from. Assign it to a site first.`);
  return asset;
}

async function assertPositionFree(tenantId, { assetType, assetId, position, exceptId = null, transaction }) {
  if (!position) return;
  const fitted = await Battery.findAll({
    where: { tenantId, batteryStatus: 'fitted', assetType, assetId, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    transaction,
  });
  const taken = fitted.find((b) => (b.position ?? '').toLowerCase() === position.toLowerCase());
  if (taken) {
    throw AppError.conflict(`Battery ${taken.batteryCode} is already fitted at "${taken.position}". Use Replace to change it, or enter a different position.`);
  }
}

async function assertReadingNotBelowLast(tenantId, { assetType, assetId, assetLabel, meterType, date, reading, transaction }) {
  if (reading == null) return;
  const previous = await BatteryEvent.findOne({
    where: { tenantId, assetType, assetId, meterType, meterReading: { [Op.ne]: null }, eventDate: { [Op.lte]: date } },
    order: [['eventDate', 'DESC'], ['id', 'DESC']],
    transaction,
  });
  if (previous && reading < Number(previous.meterReading)) {
    throw AppError.badRequest(
      `Meter reading can't be lower than ${formatReading(previous.meterReading)} ${meterUnit(meterType)}, recorded for ${assetLabel} on ${formatDate(previous.eventDate)}.`
    );
  }
}

async function fitOnto(tenantId, battery, asset, { assetType, position, date, reading, notes, relatedBatteryId = null, actingUserId, transaction }) {
  assertStatus(battery, ['ready'], 'fitted');
  const noun = assetType === 'VEHICLE' ? 'vehicle' : 'machine';
  if (Number(battery.siteId) !== Number(asset.currentSiteId)) {
    throw AppError.badRequest(`Battery ${battery.batteryCode} is stored at a different site from this ${noun}. Choose a battery from the ${noun}'s site.`);
  }
  await assertNotBeforeLastEvent(tenantId, battery, date, 'Fitting date', transaction);
  await assertPositionFree(tenantId, { assetType, assetId: asset.assetId, position, transaction });
  const meterType = meterTypeFor(assetType, asset);
  const assetLabel = assetSummary(assetType, asset.assetId, asset).assetLabel;
  await assertReadingNotBelowLast(tenantId, { assetType, assetId: asset.assetId, assetLabel, meterType, date, reading, transaction });

  await saveBattery(tenantId, battery, { batteryStatus: 'fitted', assetType, assetId: asset.assetId, position, fittedAt: date, siteId: asset.currentSiteId }, { actingUserId, transaction });
  await createEvent(
    tenantId,
    { batteryId: battery.id, eventType: 'fitted', eventDate: date, siteId: asset.currentSiteId, assetType, assetId: asset.assetId, position, meterType, meterReading: reading, notes, relatedBatteryId },
    { actingUserId, transaction }
  );
}

async function takeOff(tenantId, battery, asset, { date, reading, outcome, scrapReason, scrapValue = null, notes, relatedBatteryId = null, actingUserId, transaction }) {
  assertStatus(battery, ['fitted'], 'removed');
  await assertNotBeforeLastEvent(tenantId, battery, date, 'Removal date', transaction);
  const meterType = meterTypeFor(battery.assetType, asset);
  if (reading != null) {
    const fitting = await BatteryEvent.findOne({
      where: { tenantId, batteryId: battery.id, eventType: 'fitted' },
      order: [['eventDate', 'DESC'], ['id', 'DESC']],
      transaction,
    });
    if (fitting?.meterReading != null && fitting.meterType === meterType && reading < Number(fitting.meterReading)) {
      throw AppError.badRequest(`Meter reading can't be lower than ${formatReading(fitting.meterReading)} ${meterUnit(meterType)}, the reading when this battery was fitted.`);
    }
  }

  const storeSiteId = asset.currentSiteId ?? battery.siteId;
  const { assetType, assetId, position } = battery;
  await createEvent(
    tenantId,
    { batteryId: battery.id, eventType: 'removed', eventDate: date, siteId: storeSiteId, assetType, assetId, position, meterType, meterReading: reading, outcome, notes, relatedBatteryId },
    { actingUserId, transaction }
  );
  if (outcome === 'scrapped') {
    await createEvent(tenantId, { batteryId: battery.id, eventType: 'scrapped', eventDate: date, siteId: storeSiteId, amount: scrapValue, notes: scrapReason }, { actingUserId, transaction });
  }
  await saveBattery(
    tenantId,
    battery,
    {
      batteryStatus: outcome,
      assetType: null,
      assetId: null,
      position: null,
      fittedAt: null,
      siteId: storeSiteId,
      ...(outcome === 'scrapped' ? { scrappedAt: date, scrapReason } : {}),
    },
    { actingUserId, transaction }
  );
}

async function fitBattery({ tenantId, auth, actingUserId, payload }) {
  const batteryId = requireNumber(payload.batteryId, 'Battery', { min: 1 });
  const assetType = readAssetType(payload.assetType);
  const assetId = requireText(payload.assetId, 'Asset', { max: 64 });
  const position = optionalText(payload.position, 'Position', { max: 50 });
  const date = requireBusinessDate(payload.fittedAt, 'Fitting date');
  const reading = readReading(payload.meterReading);
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });

  const id = await sequelize.transaction(async (transaction) => {
    const asset = await lockActiveAsset(tenantId, auth, assetType, assetId, transaction);
    const battery = await lockBattery(tenantId, batteryId, transaction);
    assertSiteAllowed(auth, battery.siteId, NOT_FOUND);
    await fitOnto(tenantId, battery, asset, { assetType, position, date, reading, notes, actingUserId, transaction });
    return battery.id;
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function lockFittedAsset(tenantId, auth, battery, transaction) {
  // Supervisors may remove only from an asset at their own site.
  return resolveAsset(tenantId, battery.assetType, battery.assetId, { transaction, auth, lock: transaction.LOCK.UPDATE });
}

async function removeBattery({ tenantId, auth, actingUserId, id, payload }) {
  const date = requireBusinessDate(payload.removedAt, 'Removal date');
  const reading = readReading(payload.meterReading);
  const outcome = readOutcome(payload.outcome);
  const scrapReason = readScrapReason(outcome, payload.scrapReason);
  const scrapValue = outcome === 'scrapped' ? readMoney(payload.scrapValue, 'Scrap value') : null;
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });

  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    // The asset is locked before the battery, the same order as fitting, so the two can't wait on each other.
    const current = await Battery.findOne({ where: { tenantId, id }, transaction });
    if (!current) throw AppError.notFound(NOT_FOUND);
    assertStatus(current, ['fitted'], 'removed');
    const asset = await lockFittedAsset(tenantId, auth, current, transaction);
    const battery = await lockBattery(tenantId, id, transaction);
    if (battery.assetType !== current.assetType || battery.assetId !== current.assetId) {
      throw AppError.conflict('This battery was just changed by someone else. Reload the page and try again.');
    }
    await takeOff(tenantId, battery, asset, { date, reading, outcome, scrapReason, scrapValue, notes, actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function replaceBattery({ tenantId, auth, actingUserId, id, payload }) {
  const newBatteryId = requireNumber(payload.newBatteryId, 'Replacement battery', { min: 1 });
  if (Number(newBatteryId) === Number(id)) throw AppError.badRequest('Choose a different battery as the replacement.');
  const date = requireBusinessDate(payload.replacedAt, 'Replacement date');
  const reading = readReading(payload.meterReading);
  const outcome = readOutcome(payload.outcome);
  const scrapReason = readScrapReason(outcome, payload.scrapReason);
  const scrapValue = outcome === 'scrapped' ? readMoney(payload.scrapValue, 'Scrap value') : null;
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  const hasPosition = Object.prototype.hasOwnProperty.call(payload, 'position');
  const newPosition = hasPosition ? optionalText(payload.position, 'Position', { max: 50 }) : undefined;

  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    const current = await Battery.findOne({ where: { tenantId, id }, transaction });
    if (!current) throw AppError.notFound(NOT_FOUND);
    assertStatus(current, ['fitted'], 'replaced');
    const asset = await lockFittedAsset(tenantId, auth, current, transaction);

    // Lock both batteries in id order, so two replacements can't wait on each other.
    const [firstId, secondId] = [Number(id), Number(newBatteryId)].sort((a, b) => a - b);
    const first = await lockBattery(tenantId, firstId, transaction);
    const second = await lockBattery(tenantId, secondId, transaction);
    const old = first.id === Number(id) ? first : second;
    const replacement = first.id === Number(id) ? second : first;
    assertStatus(old, ['fitted'], 'replaced');
    if (old.assetType !== current.assetType || old.assetId !== current.assetId) {
      throw AppError.conflict('This battery was just changed by someone else. Reload the page and try again.');
    }
    if (asset.status !== 'active') throw AppError.badRequest("This asset is archived, so a battery can't be fitted to it. Use Remove instead.");
    if (!asset.currentSiteId) throw AppError.badRequest("This asset isn't assigned to a site. Use Remove instead.");
    assertStatus(replacement, ['ready'], 'fitted');

    const assetType = old.assetType;
    const position = newPosition === undefined ? old.position : newPosition;
    await takeOff(tenantId, old, asset, { date, reading, outcome, scrapReason, scrapValue, notes, relatedBatteryId: replacement.id, actingUserId, transaction });
    await fitOnto(tenantId, replacement, asset, { assetType, position, date, reading, notes, relatedBatteryId: old.id, actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, newBatteryId));
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage actions: send for repair, repaired, scrap

async function storageAction({ tenantId, auth, id, transaction }) {
  const battery = await lockBattery(tenantId, id, transaction);
  assertSiteAllowed(auth, await currentSiteOf(tenantId, battery, transaction), NOT_FOUND);
  return battery;
}

async function sendForRepair({ tenantId, auth, actingUserId, id, payload }) {
  const date = requireBusinessDate(payload.date, 'Date');
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  await sequelize.transaction(async (transaction) => {
    const battery = await storageAction({ tenantId, auth, id, transaction });
    assertStatus(battery, ['ready'], 'sent for repair');
    await assertNotBeforeLastEvent(tenantId, battery, date, 'Date', transaction);
    await createEvent(tenantId, { batteryId: battery.id, eventType: 'sent_for_repair', eventDate: date, siteId: battery.siteId, notes }, { actingUserId, transaction });
    await saveBattery(tenantId, battery, { batteryStatus: 'needs_repair' }, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function markRepaired({ tenantId, auth, actingUserId, id, payload }) {
  const date = requireBusinessDate(payload.date, 'Repair date');
  const cost = readMoney(payload.repairCost, 'Repair cost');
  const vendor = optionalText(payload.vendor, 'Repaired by', { max: 255 });
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  await sequelize.transaction(async (transaction) => {
    const battery = await storageAction({ tenantId, auth, id, transaction });
    assertStatus(battery, ['needs_repair'], 'marked repaired');
    await assertNotBeforeLastEvent(tenantId, battery, date, 'Repair date', transaction);
    await createEvent(tenantId, { batteryId: battery.id, eventType: 'repaired', eventDate: date, siteId: battery.siteId, amount: cost, vendor, notes }, { actingUserId, transaction });
    await saveBattery(tenantId, battery, { batteryStatus: 'ready' }, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function scrapBattery({ tenantId, auth, actingUserId, id, payload }) {
  const date = requireBusinessDate(payload.date, 'Scrap date');
  const reason = requireText(payload.reason, 'Scrap reason', { max: 500 });
  const scrapValue = readMoney(payload.scrapValue, 'Scrap value');
  await sequelize.transaction(async (transaction) => {
    const battery = await storageAction({ tenantId, auth, id, transaction });
    if (battery.batteryStatus === 'fitted') {
      throw AppError.conflict(`Battery ${battery.batteryCode} is fitted. Remove or replace it first, and choose Scrap for the removed battery.`);
    }
    assertStatus(battery, STORED, 'scrapped');
    await assertNotBeforeLastEvent(tenantId, battery, date, 'Scrap date', transaction);
    await createEvent(tenantId, { batteryId: battery.id, eventType: 'scrapped', eventDate: date, siteId: battery.siteId, amount: scrapValue, notes: reason }, { actingUserId, transaction });
    await saveBattery(tenantId, battery, { batteryStatus: 'scrapped', scrappedAt: date, scrapReason: reason }, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin corrections

async function hasOnlyPurchase(tenantId, batteryId, transaction) {
  const count = await BatteryEvent.count({ where: { tenantId, batteryId, eventType: { [Op.ne]: 'purchased' } }, transaction });
  return count === 0;
}

async function updateDetails({ tenantId, auth, actingUserId, id, payload }) {
  const details = readBatteryDetails(payload);
  const purchaseDate = requireBusinessDate(payload.purchaseDate, 'Purchase date');
  const supplierName = optionalText(payload.supplierName, 'Supplier', { max: 255 });
  const invoiceNumber = optionalText(payload.invoiceNumber, 'Invoice number', { max: 64 });
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  const wantsSite = payload.siteId !== undefined && payload.siteId !== null && payload.siteId !== '';
  const siteId = wantsSite ? requireNumber(payload.siteId, 'Site', { min: 1 }) : null;

  await findVisible(tenantId, auth, id);
  try {
    await sequelize.transaction(async (transaction) => {
      const battery = await lockBattery(tenantId, id, transaction);
      const taken = await Battery.findOne({ where: { tenantId, serialNumber: details.serialNumber, id: { [Op.ne]: battery.id } }, transaction });
      if (taken) throw AppError.conflict(`Serial number ${details.serialNumber} is already recorded as battery ${taken.batteryCode}.`);

      const firstUse = await BatteryEvent.findOne({
        where: { tenantId, batteryId: battery.id, eventType: { [Op.ne]: 'purchased' } },
        order: [['eventDate', 'ASC'], ['id', 'ASC']],
        transaction,
      });
      if (firstUse && purchaseDate > firstUse.eventDate) {
        throw AppError.badRequest(`Purchase date can't be after ${formatDate(firstUse.eventDate)}, the first time this battery was used.`);
      }
      const changes = { ...details, purchaseDate, supplierName, invoiceNumber, notes };
      if (wantsSite && Number(siteId) !== Number(battery.siteId)) {
        if (firstUse) throw AppError.conflict("This battery has already been used, so its purchase site can't be changed.");
        await assertSiteUsable(tenantId, siteId);
        changes.siteId = siteId;
      }
      await saveBattery(tenantId, battery, changes, { actingUserId, transaction });
      await BatteryEvent.update(
        { eventDate: purchaseDate, amount: details.purchaseCost, vendor: supplierName, siteId: changes.siteId ?? battery.siteId, notes: invoiceNumber ? `Invoice ${invoiceNumber}` : null },
        { where: { tenantId, batteryId: battery.id, eventType: 'purchased' }, transaction }
      );
    });
  } catch (error) {
    if (isUniqueSerialError(error)) throw AppError.conflict(`Serial number ${details.serialNumber} is already recorded.`);
    throw error;
  }
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function deleteBattery({ tenantId, auth, actingUserId, id, confirmation }) {
  if (confirmation !== 'DELETE') throw AppError.badRequest('Type DELETE to confirm this action.');
  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    const battery = await lockBattery(tenantId, id, transaction);
    if (!(await hasOnlyPurchase(tenantId, battery.id, transaction))) {
      throw AppError.conflict(`Battery ${battery.batteryCode} has already been used, so it can't be deleted. Scrap it instead.`);
    }
    const before = battery.toJSON();
    await BatteryEvent.destroy({ where: { tenantId, batteryId: battery.id }, transaction });
    await battery.destroy({ transaction });
    await recordAudit({ tenantId, entityType: 'Battery', entityId: before.id, action: 'DELETED', before, performedBy: actingUserId }, { transaction });
  });
  return { id: Number(id) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lists

async function batteryWhere(tenantId, auth, query) {
  const and = [];
  const siteId = siteFilter(auth, query);
  if (siteId) and.push(await atSiteCondition(tenantId, siteId));

  if (query.status === 'in_storage') and.push({ batteryStatus: STORED });
  else {
    const status = parseEnumFilter(query.status, Battery.STATUSES, 'Status');
    if (status) and.push({ batteryStatus: status });
  }
  const assetType = parseEnumFilter(query.assetType, Battery.ASSET_TYPES, 'Asset type');
  if (assetType) and.push({ assetType });
  if (query.assetId) and.push({ assetId: String(query.assetId) });

  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (dateFrom) and.push({ purchaseDate: { [Op.gte]: dateFrom } });
  if (dateTo) and.push({ purchaseDate: { [Op.lte]: dateTo } });

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const like = { [Op.like]: containsPattern(search) };
    const options = [{ batteryCode: like }, { serialNumber: like }, { brand: like }, { modelName: like }, { supplierName: like }, { invoiceNumber: like }, { position: like }];
    for (const ref of await assetRefsMatchingNumber(tenantId, search)) options.push({ ...ref, batteryStatus: 'fitted' });
    and.push({ [Op.or]: options });
  }
  return and.length ? { [Op.and]: and } : {};
}

async function listBatteries({ tenantId, auth, query }) {
  const { page, limit, offset, order } = parseListQuery(query, {
    sortableFields: ['batteryCode', 'purchaseDate', 'purchaseCost', 'createdAt', 'fittedAt'],
    defaultSort: 'batteryCode:desc',
  });
  const where = await batteryWhere(tenantId, auth, query);
  const [{ rows, count }, totals] = await Promise.all([
    repo.findAndCountAll(tenantId, { where, order: [...order, ['id', 'DESC']], limit, offset }),
    Battery.findOne({ where: { [Op.and]: [{ tenantId }, where] }, attributes: [[fn('SUM', col('purchase_cost')), 'purchaseCost']], raw: true }),
  ]);
  const response = buildListResponse(await decorate(tenantId, rows), { page, limit, total: count });
  return { ...response, totals: { batteries: count, purchaseCost: roundMoney(Number(totals?.purchaseCost ?? 0)) } };
}

async function summary({ tenantId, auth, query }) {
  const siteId = siteFilter(auth, query);
  const where = siteId ? await atSiteCondition(tenantId, siteId) : {};
  const rows = await Battery.findAll({
    where: { [Op.and]: [{ tenantId }, where] },
    attributes: ['batteryStatus', [fn('COUNT', col('id')), 'count']],
    group: ['batteryStatus'],
    raw: true,
  });
  const counts = Object.fromEntries(Battery.STATUSES.map((s) => [s, 0]));
  for (const r of rows) counts[r.batteryStatus] = Number(r.count);
  return counts;
}

async function getBattery({ tenantId, auth, id }) {
  return detailOf(tenantId, await findVisible(tenantId, auth, id));
}

async function listEvents({ tenantId, auth, query }) {
  const { page, limit, offset, order } = parseListQuery(query, { sortableFields: ['eventDate', 'createdAt'], defaultSort: 'eventDate:desc' });
  const and = [];
  const siteId = siteFilter(auth, query);
  if (siteId) and.push({ siteId });
  const eventType = parseEnumFilter(query.eventType, BatteryEvent.EVENT_TYPES, 'Event');
  if (eventType) and.push({ eventType });
  const assetType = parseEnumFilter(query.assetType, Battery.ASSET_TYPES, 'Asset type');
  if (assetType) and.push({ assetType });
  if (query.assetId) and.push({ assetId: String(query.assetId) });
  if (query.batteryId) and.push({ batteryId: requireIdFilter(query.batteryId, 'Battery') });

  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (dateFrom) and.push({ eventDate: { [Op.gte]: dateFrom } });
  if (dateTo) and.push({ eventDate: { [Op.lte]: dateTo } });

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const like = { [Op.like]: containsPattern(search) };
    const batteries = await Battery.findAll({
      where: { tenantId, [Op.or]: [{ batteryCode: like }, { serialNumber: like }, { brand: like }, { modelName: like }] },
      attributes: ['id'],
    });
    const options = [{ vendor: like }, { notes: like }, { position: like }];
    if (batteries.length) options.push({ batteryId: batteries.map((b) => b.id) });
    options.push(...(await assetRefsMatchingNumber(tenantId, search)));
    and.push({ [Op.or]: options });
  }

  const { rows, count } = await eventRepo.findAndCountAll(tenantId, {
    where: and.length ? { [Op.and]: and } : {},
    order: [...order, ['id', 'DESC']],
    limit,
    offset,
  });
  return buildListResponse(await decorateEvents(tenantId, rows, { withBattery: true }), { page, limit, total: count });
}

module.exports = {
  purchaseBatteries,
  fitBattery,
  removeBattery,
  replaceBattery,
  sendForRepair,
  markRepaired,
  scrapBattery,
  updateDetails,
  deleteBattery,
  listBatteries,
  summary,
  getBattery,
  listEvents,
  // shared with the report service
  siteFilter,
  decorateEvents,
  STATUS_LABELS,
};
