const { Op, Transaction, UniqueConstraintError, fn, col } = require('sequelize');

const { sequelize, Tyre, TyreEvent, TyreType, TyreAssetLayout, Vehicle, Machinery, User, AuditLog } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, optionalText, requireNumber, optionalNumber, requireIdFilter } = require('../utils/validation');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { createTenantScopedRepository } = require('./tenantScopedRepository');
const { recordCreate, recordUpdate } = require('./audit.service');
const { assertSiteAllowed, siteFilterIds, siteCondition, includesSite } = require('./siteAccess');
const { resolveAsset } = require('./asset.service');
const { assetRefsMatchingNumber } = require('./assetIdentifier.service');
const { nextSequentialCode } = require('./codeGenerator');
const { requireBusinessDate, roundMoney, siteNamesById } = require('./fuelCommon');
const { meterTypeFor, assetsByKey, assetSummary, formatReading, meterUnit, tyreTypeSummary, readTime, isBefore, formatWhen } = require('./tyreCommon');

const repo = createTenantScopedRepository(Tyre);
const eventRepo = createTenantScopedRepository(TyreEvent);

const CODE_PREFIX = 'TYR-';
const NOT_FOUND = 'Tyre not found';
const MAX_SPARES_AT_ONCE = 50;
const MAX_MONEY = 10000000;
const MAX_READING = 99999999;
// The words the screens use, so error messages match what people see.
const STATUS_LABELS = { new: 'in the New Tyre Store', spare: 'in the Spare Tyre Store', fitted: 'fitted', remould: 'away for remoulding', scrapped: 'scrapped' };
// What can happen to a tyre that comes off an asset.
const REMOVE_OUTCOMES = ['spare', 'remould', 'scrapped'];

// ---------------------------------------------------------------------------------------------------------------------
// Input helpers

// Every tyre entry has a date and a time ("Fitting date" → "Fitting time").
function readWhen(payload, dateLabel) {
  return {
    date: requireBusinessDate(payload.date, dateLabel),
    time: readTime(payload.time, dateLabel.replace(/date/i, (word) => (word[0] === 'D' ? 'Time' : 'time'))),
  };
}

function readAssetType(value) {
  const assetType = requireText(value, 'Vehicle or machine', { max: 20 }).toUpperCase();
  if (!Tyre.ASSET_TYPES.includes(assetType)) throw AppError.badRequest('Asset type must be VEHICLE or MACHINERY');
  return assetType;
}

function readMoney(value, label) {
  const number = optionalNumber(value, label, { min: 0, max: MAX_MONEY });
  return number == null ? null : roundMoney(number);
}

function readingLabel(meterType) {
  return meterType === 'HOURS' ? 'Hours reading' : 'KM reading';
}

function readReading(value, meterType) {
  return roundMoney(requireNumber(value, readingLabel(meterType), { min: 0, max: MAX_READING }));
}

function readOutcome(value) {
  const outcome = requireText(value, 'What happens to the tyre', { max: 20 });
  if (!REMOVE_OUTCOMES.includes(outcome)) throw AppError.badRequest('Choose what happens to the tyre: spare, remould or scrapped');
  return outcome;
}

function readSerial(value, label = 'Serial number') {
  return optionalText(value, label, { max: 64 })?.toUpperCase() ?? null;
}

function isUniqueSerialError(error) {
  return error instanceof UniqueConstraintError && Object.keys(error.fields ?? {}).some((key) => key.includes('serial'));
}

function isFittedSlotError(error) {
  return error instanceof UniqueConstraintError && Object.keys(error.fields ?? {}).some((key) => key.includes('fitted_slot'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Site visibility. A fitted tyre is where its asset is now; any other tyre is at its own site.

async function atSiteCondition(tenantId, siteId) {
  const [vehicles, machines] = await Promise.all([
    Vehicle.findAll({ where: { tenantId, currentSiteId: siteId }, attributes: ['assetId'] }),
    Machinery.findAll({ where: { tenantId, currentSiteId: siteId }, attributes: ['assetId'] }),
  ]);
  const or = [{ siteId, tyreStatus: { [Op.ne]: 'fitted' } }];
  if (vehicles.length) or.push({ tyreStatus: 'fitted', assetType: 'VEHICLE', assetId: vehicles.map((v) => v.assetId) });
  if (machines.length) or.push({ tyreStatus: 'fitted', assetType: 'MACHINERY', assetId: machines.map((m) => m.assetId) });
  return { [Op.or]: or };
}

// A where-clause value for the sites asked for, or every site the user covers. Null means every site.
function siteFilter(auth, query) {
  const siteIds = siteFilterIds(auth, query.siteId);
  return siteIds ? siteCondition(siteIds) : null;
}

async function currentSiteOf(tenantId, tyre, transaction) {
  if (tyre.tyreStatus !== 'fitted') return tyre.siteId;
  const model = tyre.assetType === 'VEHICLE' ? Vehicle : Machinery;
  const asset = await model.findOne({ where: { tenantId, assetId: tyre.assetId }, attributes: ['currentSiteId'], transaction });
  return asset?.currentSiteId ?? tyre.siteId;
}

async function findVisible(tenantId, auth, id, options = {}) {
  const tyre = await repo.findByPk(tenantId, id, options);
  if (!tyre) throw AppError.notFound(NOT_FOUND);
  assertSiteAllowed(auth, await currentSiteOf(tenantId, tyre, options.transaction), NOT_FOUND);
  return tyre;
}

async function lockTyre(tenantId, id, transaction) {
  const tyre = await Tyre.findOne({ where: { tenantId, id }, transaction, lock: Transaction.LOCK.UPDATE });
  if (!tyre) throw AppError.notFound(NOT_FOUND);
  return tyre;
}

function assertStatus(tyre, allowed, action) {
  if (allowed.includes(tyre.tyreStatus)) return;
  throw AppError.conflict(`Tyre ${tyre.tyreCode} is ${STATUS_LABELS[tyre.tyreStatus]}, so it can't be ${action}.`);
}

async function assertNotBeforeLastEvent(tenantId, tyre, date, time, label, transaction) {
  const last = await TyreEvent.findOne({ where: { tenantId, tyreId: tyre.id }, order: [['eventDate', 'DESC'], ['eventTime', 'DESC'], ['id', 'DESC']], transaction });
  if (last && isBefore(date, time, last.eventDate, last.eventTime)) {
    throw AppError.badRequest(
      `${label} (${formatWhen(date, time)}) can't be before ${formatWhen(last.eventDate, last.eventTime)}, the last entry in the history of tyre ${tyre.tyreCode}.`
    );
  }
}

// A reading on an asset can't be lower than the last tyre reading recorded for that asset up to that date.
async function assertReadingNotBelowAsset(tenantId, { assetType, assetId, assetLabel, meterType, date, reading, transaction }) {
  const previous = await TyreEvent.findOne({
    where: { tenantId, assetType, assetId, meterType, meterReading: { [Op.ne]: null }, eventDate: { [Op.lte]: date } },
    order: [['eventDate', 'DESC'], ['eventTime', 'DESC'], ['meterReading', 'DESC'], ['id', 'DESC']],
    transaction,
  });
  if (previous && reading < Number(previous.meterReading)) {
    throw AppError.badRequest(
      `${readingLabel(meterType)} can't be lower than ${formatReading(previous.meterReading)} ${meterUnit(meterType)}, recorded for ${assetLabel} on ${formatWhen(previous.eventDate, previous.eventTime)}.`
    );
  }
}

function assertReadingNotBelowFitting(tyre, reading) {
  if (reading < Number(tyre.fitReading)) {
    throw AppError.badRequest(
      `${readingLabel(tyre.meterType)} can't be lower than ${formatReading(tyre.fitReading)} ${meterUnit(tyre.meterType)}, the reading when tyre ${tyre.tyreCode} was fitted.`
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

async function decorate(tenantId, tyres) {
  if (tyres.length === 0) return [];
  const refs = [];
  for (const t of tyres) {
    if (t.assetType && t.assetId) refs.push({ assetType: t.assetType, assetId: t.assetId });
    if (t.ownerAssetType && t.ownerAssetId) refs.push({ assetType: t.ownerAssetType, assetId: t.ownerAssetId });
  }
  const [assets, types] = await Promise.all([
    assetsByKey(tenantId, refs),
    TyreType.findAll({ where: { tenantId, id: [...new Set(tyres.map((t) => t.tyreTypeId))] } }),
  ]);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const rows = tyres.map((t) => {
    const json = t.toPublicJSON();
    const fitted = t.tyreStatus === 'fitted' ? assetSummary(t.assetType, t.assetId, assets.get(`${t.assetType}:${t.assetId}`)) : null;
    const owner = t.ownerAssetType ? assetSummary(t.ownerAssetType, t.ownerAssetId, assets.get(`${t.ownerAssetType}:${t.ownerAssetId}`)) : null;
    return {
      ...json,
      ...tyreTypeSummary(typeById.get(t.tyreTypeId)),
      assetLabel: fitted?.assetLabel ?? null,
      assetRecordId: fitted?.assetRecordId ?? null,
      ownerLabel: owner?.assetLabel ?? null,
      currentSiteId: fitted?.assetSiteId ?? t.siteId,
      costPerKm: json.runKm > 0 ? roundMoney(json.totalCost / json.runKm) : null,
      costPerHour: json.runHours > 0 ? roundMoney(json.totalCost / json.runHours) : null,
    };
  });
  const siteNames = await siteNamesById(tenantId, rows.map((r) => r.currentSiteId));
  return rows.map((r) => ({ ...r, siteName: siteNames.get(r.currentSiteId) ?? null }));
}

async function decorateEvents(tenantId, events) {
  if (events.length === 0) return [];
  const [assets, siteNames, users] = await Promise.all([
    assetsByKey(tenantId, events.filter((e) => e.assetType && e.assetId)),
    siteNamesById(tenantId, events.map((e) => e.siteId)),
    User.findAll({ where: { tenantId, id: [...new Set(events.map((e) => e.createdBy))] }, attributes: ['id', 'name'] }),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  return events.map((e) => ({
    ...e.toPublicJSON(),
    assetLabel: e.assetType ? assetSummary(e.assetType, e.assetId, assets.get(`${e.assetType}:${e.assetId}`)).assetLabel : null,
    siteName: siteNames.get(e.siteId) ?? null,
    createdByName: userNames.get(e.createdBy) ?? null,
  }));
}

async function detailOf(tenantId, tyre) {
  const [row] = await decorate(tenantId, [tyre]);
  const events = await TyreEvent.findAll({ where: { tenantId, tyreId: tyre.id }, order: [['eventDate', 'ASC'], ['eventTime', 'ASC'], ['id', 'ASC']] });
  return { ...row, events: await decorateEvents(tenantId, events) };
}

function createEvent(tenantId, data, { actingUserId, transaction }) {
  return eventRepo.create(tenantId, { ...data, createdBy: actingUserId }, { transaction });
}

async function saveTyre(tenantId, tyre, changes, { actingUserId, transaction }) {
  const before = tyre.toJSON();
  await tyre.update({ ...changes, updatedBy: actingUserId }, { transaction });
  await recordUpdate({ tenantId, entityType: 'Tyre', entityId: tyre.id, performedBy: actingUserId, before, after: tyre }, { transaction });
}

// ---------------------------------------------------------------------------------------------------------------------
// Creating tyres: bought (called by the purchase service) or an asset's existing spare tyres

async function createPurchasedTyres(tenantId, { purchase, lines, actingUserId, transaction }) {
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i += 1) {
      const tyreCode = await nextSequentialCode(Tyre, 'tyreCode', CODE_PREFIX, { tenantId, transaction });
      const tyre = await repo.create(
        tenantId,
        { tyreCode, tyreTypeId: line.tyreTypeId, siteId: purchase.siteId, purchaseId: purchase.id, purchaseCost: line.unitCost, tyreStatus: 'new', createdBy: actingUserId, updatedBy: actingUserId },
        { transaction }
      );
      await createEvent(
        tenantId,
        { tyreId: tyre.id, eventType: 'purchased', eventDate: purchase.purchaseDate, eventTime: purchase.purchaseTime, siteId: purchase.siteId, amount: line.unitCost, vendor: purchase.supplierName, notes: `Purchase ${purchase.purchaseNumber}` },
        { actingUserId, transaction }
      );
    }
  }
}

async function addSpareTyres({ tenantId, auth, actingUserId, payload }) {
  const assetType = readAssetType(payload.assetType);
  const assetId = requireText(payload.assetId, 'Vehicle or machine', { max: 64 });
  const tyreTypeId = requireNumber(payload.tyreTypeId, 'Tyre type', { min: 1 });
  const quantity = requireNumber(payload.quantity, 'How many tyres', { min: 1, max: MAX_SPARES_AT_ONCE });
  if (!Number.isInteger(quantity)) throw AppError.badRequest('How many tyres must be a whole number');
  const { date, time } = readWhen(payload, 'Date');
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  const serials = (Array.isArray(payload.serialNumbers) ? payload.serialNumbers : []).map((s, i) => readSerial(s, `Serial number ${i + 1}`)).filter(Boolean);
  if (serials.length > quantity) throw AppError.badRequest(`You entered ${serials.length} serial numbers for ${quantity} tyres.`);
  if (new Set(serials).size !== serials.length) throw AppError.badRequest('The same serial number is listed twice.');

  const tyreType = await TyreType.findOne({ where: { tenantId, id: tyreTypeId } });
  if (!tyreType) throw AppError.badRequest('Tyre type not found');
  if (tyreType.status !== 'active') throw AppError.badRequest('This tyre type is archived');

  try {
    const ids = await sequelize.transaction(async (transaction) => {
      const asset = await resolveAsset(tenantId, assetType, assetId, { transaction, auth });
      if (!asset.currentSiteId) throw AppError.badRequest(`This ${assetType === 'VEHICLE' ? 'vehicle' : 'machine'} isn't assigned to a site. Assign it to a site first.`);
      const created = [];
      for (let i = 0; i < quantity; i += 1) {
        const tyreCode = await nextSequentialCode(Tyre, 'tyreCode', CODE_PREFIX, { tenantId, transaction });
        const tyre = await repo.create(
          tenantId,
          {
            tyreCode,
            serialNumber: serials[i] ?? null,
            tyreTypeId,
            siteId: asset.currentSiteId,
            purchaseCost: 0,
            tyreStatus: 'spare',
            ownerAssetType: assetType,
            ownerAssetId: asset.assetId,
            notes,
            createdBy: actingUserId,
            updatedBy: actingUserId,
          },
          { transaction }
        );
        await createEvent(tenantId, { tyreId: tyre.id, eventType: 'added_spare', eventDate: date, eventTime: time, siteId: asset.currentSiteId, assetType, assetId: asset.assetId, notes }, { actingUserId, transaction });
        await recordCreate({ tenantId, entityType: 'Tyre', entityId: tyre.id, performedBy: actingUserId, after: tyre }, { transaction });
        created.push(tyre.id);
      }
      return created;
    });
    return decorate(tenantId, await Tyre.findAll({ where: { tenantId, id: ids }, order: [['id', 'ASC']] }));
  } catch (error) {
    if (isUniqueSerialError(error)) throw AppError.conflict('One of these serial numbers is already recorded for another tyre.');
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Axle layout

async function layoutOf(tenantId, assetType, assetId, transaction) {
  return TyreAssetLayout.findOne({ where: { tenantId, assetType, assetId }, transaction });
}

function allPositions(layout) {
  return layout ? TyreAssetLayout.positionsFor(layout.axleList).flatMap((a) => a.positions) : [];
}

async function saveLayout({ tenantId, auth, actingUserId, assetType: rawType, assetId, payload }) {
  const assetType = readAssetType(rawType);
  if (!Array.isArray(payload.axles) || payload.axles.length === 0) throw AppError.badRequest('Add at least one axle');
  if (payload.axles.length > TyreAssetLayout.MAX_AXLES) throw AppError.badRequest(`A vehicle can have at most ${TyreAssetLayout.MAX_AXLES} axles`);
  const axles = payload.axles.map((n, i) => {
    const count = Number(n);
    if (!TyreAssetLayout.TYRES_PER_AXLE.includes(count)) throw AppError.badRequest(`Axle ${i + 1}: choose 1, 2 or 4 tyres`);
    return count;
  });

  await sequelize.transaction(async (transaction) => {
    const asset = await resolveAsset(tenantId, assetType, assetId, { transaction, auth, lock: transaction.LOCK.UPDATE });
    const keep = new Set(TyreAssetLayout.positionsFor(axles).flatMap((a) => a.positions).map((p) => p.toLowerCase()));
    const fitted = await Tyre.findAll({ where: { tenantId, tyreStatus: 'fitted', assetType, assetId: asset.assetId }, transaction });
    const stranded = fitted.filter((t) => !keep.has(t.position.toLowerCase()));
    if (stranded.length) {
      throw AppError.conflict(`Take off the tyre at ${stranded.map((t) => t.position).join(', ')} first — that position is not in the new layout.`);
    }
    const existing = await layoutOf(tenantId, assetType, asset.assetId, transaction);
    if (existing) {
      const before = existing.toJSON();
      await existing.update({ axles: axles.join(','), updatedBy: actingUserId }, { transaction });
      await recordUpdate({ tenantId, entityType: 'TyreAssetLayout', entityId: existing.id, performedBy: actingUserId, before, after: existing }, { transaction });
    } else {
      const created = await TyreAssetLayout.create({ tenantId, assetType, assetId: asset.assetId, axles: axles.join(','), createdBy: actingUserId, updatedBy: actingUserId }, { transaction });
      await recordCreate({ tenantId, entityType: 'TyreAssetLayout', entityId: created.id, performedBy: actingUserId, after: created }, { transaction });
    }
  });
  return getAssetTyres({ tenantId, auth, assetType, assetId });
}

async function userNamesById(tenantId, ids) {
  const unique = [...new Set(ids.filter((id) => id != null))];
  if (!unique.length) return new Map();
  const users = await User.findAll({ where: { tenantId, id: unique }, attributes: ['id', 'name'] });
  return new Map(users.map((u) => [u.id, u.name]));
}

const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value ?? null);
const axlesFrom = (snapshot) => (snapshot?.axles != null ? TyreAssetLayout.parseAxles(snapshot.axles) : null);

// Every time the axles of an asset were set or changed, newest first (from the audit log).
async function layoutHistory(tenantId, layout) {
  if (!layout) return [];
  const rows = await AuditLog.findAll({ where: { tenantId, entityType: 'TyreAssetLayout', entityId: String(layout.id) }, order: [['createdAt', 'DESC'], ['id', 'DESC']] });
  const names = await userNamesById(tenantId, rows.map((r) => r.performedBy));
  return rows
    .map((r) => ({ id: r.id, action: r.action, at: r.createdAt, by: names.get(r.performedBy) ?? null, from: axlesFrom(parseJson(r.before)), to: axlesFrom(parseJson(r.after)) }))
    .filter((r) => r.action === 'CREATED' || r.to);
}

// The overview on the Vehicle Tyres screen: every asset with axles set or spare tyres, with its setup.
async function listAssetSetups({ tenantId, auth, query }) {
  const siteIds = siteFilterIds(auth, query.siteId);
  const [layouts, fitted, spares] = await Promise.all([
    TyreAssetLayout.findAll({ where: { tenantId } }),
    Tyre.findAll({ where: { tenantId, tyreStatus: 'fitted' }, attributes: ['assetType', 'assetId', [fn('COUNT', col('id')), 'count']], group: ['assetType', 'assetId'], raw: true }),
    Tyre.findAll({
      where: { tenantId, tyreStatus: ['spare', 'remould'], ownerAssetType: { [Op.ne]: null } },
      attributes: ['ownerAssetType', 'ownerAssetId', 'tyreStatus', [fn('COUNT', col('id')), 'count']],
      group: ['ownerAssetType', 'ownerAssetId', 'tyreStatus'],
      raw: true,
    }),
  ]);

  const rows = new Map();
  const row = (assetType, assetId) => {
    const key = `${assetType}:${assetId}`;
    if (!rows.has(key)) rows.set(key, { key, assetType, assetId, layout: null, fitted: 0, spares: 0, atRemould: 0 });
    return rows.get(key);
  };
  for (const l of layouts) row(l.assetType, l.assetId).layout = l;
  for (const f of fitted) row(f.assetType, f.assetId).fitted = Number(f.count);
  for (const s of spares) {
    const r = row(s.ownerAssetType, s.ownerAssetId);
    if (s.tyreStatus === 'spare') r.spares += Number(s.count);
    else r.atRemould += Number(s.count);
  }

  const assets = await assetsByKey(tenantId, [...rows.values()]);
  const visible = [...rows.values()]
    .map((r) => ({ ...r, record: assets.get(r.key) }))
    .filter((r) => r.record && (!siteIds || includesSite(siteIds, r.record.currentSiteId)));
  // The last real change of each layout's axles, from the audit log (saving the same axles again isn't logged).
  const layoutIds = visible.filter((r) => r.layout).map((r) => String(r.layout.id));
  const changes = layoutIds.length
    ? await AuditLog.findAll({ where: { tenantId, entityType: 'TyreAssetLayout', entityId: layoutIds, action: 'UPDATED' }, order: [['createdAt', 'DESC'], ['id', 'DESC']] })
    : [];
  const lastChange = new Map();
  for (const c of changes) if (!lastChange.has(c.entityId) && axlesFrom(parseJson(c.after))) lastChange.set(c.entityId, c);
  const [siteNames, userNames] = await Promise.all([
    siteNamesById(tenantId, visible.map((r) => r.record.currentSiteId)),
    userNamesById(tenantId, [...visible.map((r) => r.layout?.createdBy), ...[...lastChange.values()].map((c) => c.performedBy)]),
  ]);

  const data = visible
    .map(({ record, layout, ...r }) => {
      const axles = layout?.axleList ?? null;
      const change = layout ? lastChange.get(String(layout.id)) : null;
      return {
        ...r,
        ...assetSummary(r.assetType, r.assetId, record),
        siteName: siteNames.get(record.currentSiteId) ?? null,
        assetStatus: record.status,
        axles,
        tyresNeeded: axles ? axles.reduce((t, n) => t + n, 0) : null,
        setAt: layout?.createdAt ?? null,
        setBy: layout ? userNames.get(layout.createdBy) ?? null : null,
        changedAt: change?.createdAt ?? null,
        changedBy: change ? userNames.get(change.performedBy) ?? null : null,
      };
    })
    .sort((a, b) => Number(Boolean(b.axles)) - Number(Boolean(a.axles)) || String(a.assetLabel).localeCompare(String(b.assetLabel)));

  return {
    rows: data,
    totals: {
      configured: data.filter((r) => r.axles).length,
      notConfigured: data.filter((r) => !r.axles).length,
      tyresNeeded: data.reduce((t, r) => t + (r.tyresNeeded ?? 0), 0),
      fitted: data.reduce((t, r) => t + r.fitted, 0),
      spares: data.reduce((t, r) => t + r.spares, 0),
    },
  };
}

// Everything the Vehicle Tyres screen needs for one asset.
async function getAssetTyres({ tenantId, auth, assetType: rawType, assetId }) {
  const assetType = readAssetType(rawType);
  const asset = await resolveAsset(tenantId, assetType, assetId, { auth });
  const [layout, fitted, spares, lastReading] = await Promise.all([
    layoutOf(tenantId, assetType, asset.assetId),
    Tyre.findAll({ where: { tenantId, tyreStatus: 'fitted', assetType, assetId: asset.assetId } }),
    Tyre.findAll({ where: { tenantId, ownerAssetType: assetType, ownerAssetId: asset.assetId, tyreStatus: ['spare', 'remould'] }, order: [['tyreCode', 'ASC']] }),
    TyreEvent.findOne({
      where: { tenantId, assetType, assetId: asset.assetId, meterType: meterTypeFor(assetType, asset), meterReading: { [Op.ne]: null } },
      order: [['eventDate', 'DESC'], ['eventTime', 'DESC'], ['meterReading', 'DESC'], ['id', 'DESC']],
    }),
  ]);
  const [fittedRows, spareRows, cost] = await Promise.all([decorate(tenantId, fitted), decorate(tenantId, spares), assetTyreCost({ tenantId, assetType, assetId: asset.assetId })]);
  const byPosition = new Map(fittedRows.map((t) => [t.position.toLowerCase(), t]));
  const layoutJson = layout?.toPublicJSON() ?? null;
  const [siteNames, history] = await Promise.all([siteNamesById(tenantId, [asset.currentSiteId]), layoutHistory(tenantId, layout)]);
  return {
    asset: { ...assetSummary(assetType, asset.assetId, asset), meterType: meterTypeFor(assetType, asset), siteName: siteNames.get(asset.currentSiteId) ?? null, status: asset.status },
    layout: layoutJson,
    layoutHistory: history,
    axles: (layoutJson?.layout ?? []).map((a) => ({ axle: a.axle, positions: a.positions.map((position) => ({ position, tyre: byPosition.get(position.toLowerCase()) ?? null })) })),
    // Tyres at positions the layout doesn't have (e.g. fitted before a layout was set).
    otherFitted: fittedRows.filter((t) => !allPositions(layout).some((p) => p.toLowerCase() === t.position.toLowerCase())),
    spares: spareRows,
    lastReading: lastReading ? { reading: Number(lastReading.meterReading), date: lastReading.eventDate, time: lastReading.eventTime ? String(lastReading.eventTime).slice(0, 5) : null, meterType: lastReading.meterType } : null,
    tyreCost: cost,
  };
}

// Money spent on tyres for an asset: each tyre's purchase cost the first time it goes on, plus punctures while on it.
async function assetTyreCost({ tenantId, assetType, assetId }) {
  const total = await TyreEvent.sum('amount', { where: { tenantId, assetType, assetId, eventType: ['fitted', 'puncture'] } });
  return roundMoney(Number(total ?? 0));
}

// ---------------------------------------------------------------------------------------------------------------------
// Fit and take off

async function takeOff(tenantId, tyre, asset, { date, time, reading, outcome, scrapReason, scrapValue, vendor, notes, actingUserId, transaction }) {
  assertStatus(tyre, ['fitted'], 'taken off');
  await assertNotBeforeLastEvent(tenantId, tyre, date, time, 'Date', transaction);
  assertReadingNotBelowFitting(tyre, reading);
  const run = roundMoney(reading - Number(tyre.fitReading));
  const siteId = asset.currentSiteId ?? tyre.siteId;
  const { assetType, assetId, position, meterType } = tyre;

  await createEvent(tenantId, { tyreId: tyre.id, eventType: 'removed', eventDate: date, eventTime: time, siteId, assetType, assetId, position, meterType, meterReading: reading, runValue: run, notes }, { actingUserId, transaction });
  if (outcome === 'remould') {
    await createEvent(tenantId, { tyreId: tyre.id, eventType: 'remould_sent', eventDate: date, eventTime: time, siteId, vendor }, { actingUserId, transaction });
  }
  if (outcome === 'scrapped') {
    await createEvent(tenantId, { tyreId: tyre.id, eventType: 'scrapped', eventDate: date, eventTime: time, siteId, amount: scrapValue, notes: scrapReason }, { actingUserId, transaction });
  }
  await saveTyre(
    tenantId,
    tyre,
    {
      tyreStatus: outcome,
      siteId,
      // A tyre that comes off becomes a spare of that asset.
      ownerAssetType: assetType,
      ownerAssetId: assetId,
      assetType: null,
      assetId: null,
      position: null,
      fittedAt: null,
      fittedTime: null,
      fitReading: null,
      meterType: null,
      runKm: meterType === 'KM' ? roundMoney(Number(tyre.runKm) + run) : tyre.runKm,
      runHours: meterType === 'HOURS' ? roundMoney(Number(tyre.runHours) + run) : tyre.runHours,
      ...(outcome === 'scrapped' ? { scrappedAt: date, scrappedTime: time, scrapReason, scrapValue } : {}),
    },
    { actingUserId, transaction }
  );
}

function readTakeOff(payload) {
  const outcome = readOutcome(payload.outcome);
  return {
    outcome,
    scrapReason: outcome === 'scrapped' ? requireText(payload.scrapReason, 'Why is it scrapped?', { max: 500 }) : null,
    scrapValue: outcome === 'scrapped' ? readMoney(payload.scrapValue, 'Scrap value') : null,
    vendor: outcome === 'remould' ? optionalText(payload.vendor, 'Remould shop', { max: 255 }) : null,
  };
}

async function fitTyre({ tenantId, auth, actingUserId, id, payload }) {
  const assetType = readAssetType(payload.assetType);
  const assetId = requireText(payload.assetId, 'Vehicle or machine', { max: 64 });
  const positionInput = requireText(payload.position, 'Position', { max: 50 });
  const { date, time } = readWhen(payload, 'Fitting date');
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  const oldTyre = payload.oldTyre ? readTakeOff(payload.oldTyre) : null;

  await findVisible(tenantId, auth, id);
  try {
    await sequelize.transaction(async (transaction) => {
      // The asset is locked before tyres, the same order everywhere, so two saves can't wait on each other.
      const asset = await resolveAsset(tenantId, assetType, assetId, { transaction, auth, lock: transaction.LOCK.UPDATE });
      const noun = assetType === 'VEHICLE' ? 'vehicle' : 'machine';
      if (asset.status !== 'active') throw AppError.badRequest(`This ${noun} is archived, so a tyre can't be fitted to it.`);
      if (!asset.currentSiteId) throw AppError.badRequest(`This ${noun} isn't assigned to a site. Assign it to a site first.`);
      const meterType = meterTypeFor(assetType, asset);
      const reading = readReading(payload.meterReading, meterType);
      const assetLabel = assetSummary(assetType, asset.assetId, asset).assetLabel;

      const layout = await layoutOf(tenantId, assetType, asset.assetId, transaction);
      if (!layout) throw AppError.badRequest(`Set the axles for ${assetLabel} first, so its tyre positions are known.`);
      const position = allPositions(layout).find((p) => p.toLowerCase() === positionInput.toLowerCase());
      if (!position) throw AppError.badRequest(`${positionInput} is not a position on ${assetLabel}.`);

      const occupant = await Tyre.findOne({ where: { tenantId, tyreStatus: 'fitted', assetType, assetId: asset.assetId, position }, transaction });
      const ids = [Number(id), occupant?.id].filter(Boolean).sort((a, b) => a - b);
      const locked = new Map();
      for (const tyreId of ids) locked.set(tyreId, await lockTyre(tenantId, tyreId, transaction));
      const tyre = locked.get(Number(id));
      if (tyre.tyreStatus === 'fitted') throw AppError.conflict(`Tyre ${tyre.tyreCode} is already fitted at ${tyre.position}. Reload and choose another tyre.`);
      assertStatus(tyre, Tyre.STORED, 'fitted');
      // A tyre is used only at the site it is stored at. Moving it to another site is a Tyre Transfer.
      if (Number(tyre.siteId) !== Number(asset.currentSiteId)) {
        const names = await siteNamesById(tenantId, [tyre.siteId, asset.currentSiteId]);
        throw AppError.badRequest(
          `Tyre ${tyre.tyreCode} is stored at ${names.get(tyre.siteId) ?? 'another site'}, but ${assetLabel} is at ${names.get(asset.currentSiteId) ?? 'another site'}. Transfer the tyre to that site first.`
        );
      }

      await assertReadingNotBelowAsset(tenantId, { assetType, assetId: asset.assetId, assetLabel, meterType, date, reading, transaction });

      if (occupant) {
        const old = locked.get(occupant.id);
        if (old.tyreStatus === 'fitted' && old.assetId === asset.assetId && old.position === position) {
          if (!oldTyre) throw AppError.conflict(`Tyre ${old.tyreCode} is fitted at ${position}. Choose what to do with it.`);
          await takeOff(tenantId, old, asset, { date, time, reading, ...oldTyre, notes: `Replaced by ${tyre.tyreCode}`, actingUserId, transaction });
        }
      }

      await assertNotBeforeLastEvent(tenantId, tyre, date, time, 'Fitting date', transaction);
      const fittedBefore = await TyreEvent.count({ where: { tenantId, tyreId: tyre.id, eventType: 'fitted' }, transaction });
      const amount = fittedBefore === 0 ? Number(tyre.purchaseCost) : 0;
      await createEvent(
        tenantId,
        { tyreId: tyre.id, eventType: 'fitted', eventDate: date, eventTime: time, siteId: asset.currentSiteId, assetType, assetId: asset.assetId, position, meterType, meterReading: reading, amount, notes },
        { actingUserId, transaction }
      );
      await saveTyre(
        tenantId,
        tyre,
        { tyreStatus: 'fitted', siteId: asset.currentSiteId, assetType, assetId: asset.assetId, position, fittedAt: date, fittedTime: time, meterType, fitReading: reading },
        { actingUserId, transaction }
      );
    });
  } catch (error) {
    if (isFittedSlotError(error)) throw AppError.conflict('Someone just fitted a tyre at that position. Reload and try again.');
    throw error;
  }
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function removeTyre({ tenantId, auth, actingUserId, id, payload }) {
  const { date, time } = readWhen(payload, 'Date');
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  const choice = readTakeOff(payload);

  const current = await findVisible(tenantId, auth, id);
  assertStatus(current, ['fitted'], 'taken off');
  await sequelize.transaction(async (transaction) => {
    const asset = await resolveAsset(tenantId, current.assetType, current.assetId, { transaction, auth, lock: transaction.LOCK.UPDATE });
    const tyre = await lockTyre(tenantId, id, transaction);
    if (tyre.tyreStatus !== 'fitted' || tyre.assetId !== current.assetId) throw AppError.conflict('This tyre was just changed by someone else. Reload the page and try again.');
    const reading = readReading(payload.meterReading, tyre.meterType);
    await takeOff(tenantId, tyre, asset, { date, time, reading, ...choice, notes, actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Puncture, remould, scrap

async function addRepairCost(tenantId, tyre, cost, { actingUserId, transaction }) {
  if (!cost) {
    // Nothing to add, but the tyre still counts as just updated, so it moves to the top of its store.
    tyre.changed('updatedAt', true);
    await tyre.save({ transaction });
    return;
  }
  await saveTyre(tenantId, tyre, { repairCost: roundMoney(Number(tyre.repairCost) + cost) }, { actingUserId, transaction });
}

async function recordPuncture({ tenantId, auth, actingUserId, id, payload }) {
  const { date, time } = readWhen(payload, 'Puncture date');
  const cost = readMoney(payload.cost, 'Repair cost');
  const vendor = optionalText(payload.vendor, 'Repaired by', { max: 255 });
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });

  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    const tyre = await lockTyre(tenantId, id, transaction);
    assertStatus(tyre, ['new', 'spare', 'fitted'], 'marked punctured');
    await assertNotBeforeLastEvent(tenantId, tyre, date, time, 'Puncture date', transaction);
    let reading = null;
    if (tyre.tyreStatus === 'fitted') {
      reading = readReading(payload.meterReading, tyre.meterType);
      assertReadingNotBelowFitting(tyre, reading);
    }
    const fitted = tyre.tyreStatus === 'fitted';
    await createEvent(
      tenantId,
      {
        tyreId: tyre.id,
        eventType: 'puncture',
        eventDate: date,
        eventTime: time,
        siteId: tyre.siteId,
        ...(fitted ? { assetType: tyre.assetType, assetId: tyre.assetId, position: tyre.position, meterType: tyre.meterType, meterReading: reading } : {}),
        amount: cost,
        vendor,
        notes,
      },
      { actingUserId, transaction }
    );
    await addRepairCost(tenantId, tyre, cost, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function sendForRemould({ tenantId, auth, actingUserId, id, payload }) {
  const { date, time } = readWhen(payload, 'Date');
  const vendor = optionalText(payload.vendor, 'Remould shop', { max: 255 });
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    const tyre = await lockTyre(tenantId, id, transaction);
    if (tyre.tyreStatus === 'fitted') throw AppError.conflict(`Tyre ${tyre.tyreCode} is fitted. Use Take off and choose "Send for remoulding".`);
    assertStatus(tyre, Tyre.STORED, 'sent for remoulding');
    await assertNotBeforeLastEvent(tenantId, tyre, date, time, 'Date', transaction);
    await createEvent(tenantId, { tyreId: tyre.id, eventType: 'remould_sent', eventDate: date, eventTime: time, siteId: tyre.siteId, vendor, notes }, { actingUserId, transaction });
    await saveTyre(tenantId, tyre, { tyreStatus: 'remould' }, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function remouldBack({ tenantId, auth, actingUserId, id, payload }) {
  const { date, time } = readWhen(payload, 'Date received');
  const cost = readMoney(payload.cost, 'Remould cost');
  const vendor = optionalText(payload.vendor, 'Remould shop', { max: 255 });
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    const tyre = await lockTyre(tenantId, id, transaction);
    assertStatus(tyre, ['remould'], 'received back from remoulding');
    await assertNotBeforeLastEvent(tenantId, tyre, date, time, 'Date received', transaction);
    await createEvent(tenantId, { tyreId: tyre.id, eventType: 'remould_back', eventDate: date, eventTime: time, siteId: tyre.siteId, amount: cost, vendor, notes }, { actingUserId, transaction });
    await saveTyre(tenantId, tyre, { tyreStatus: 'spare', repairCost: roundMoney(Number(tyre.repairCost) + (cost ?? 0)) }, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function scrapTyre({ tenantId, auth, actingUserId, id, payload }) {
  const { date, time } = readWhen(payload, 'Scrap date');
  const reason = requireText(payload.reason, 'Why is it scrapped?', { max: 500 });
  const scrapValue = readMoney(payload.scrapValue, 'Scrap value');
  await findVisible(tenantId, auth, id);
  await sequelize.transaction(async (transaction) => {
    const tyre = await lockTyre(tenantId, id, transaction);
    if (tyre.tyreStatus === 'fitted') throw AppError.conflict(`Tyre ${tyre.tyreCode} is fitted. Use Take off and choose "Scrap it".`);
    assertStatus(tyre, ['new', 'spare', 'remould'], 'scrapped');
    await assertNotBeforeLastEvent(tenantId, tyre, date, time, 'Scrap date', transaction);
    await createEvent(tenantId, { tyreId: tyre.id, eventType: 'scrapped', eventDate: date, eventTime: time, siteId: tyre.siteId, amount: scrapValue, notes: reason }, { actingUserId, transaction });
    await saveTyre(tenantId, tyre, { tyreStatus: 'scrapped', scrappedAt: date, scrappedTime: time, scrapReason: reason, scrapValue }, { actingUserId, transaction });
  });
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

async function updateTyre({ tenantId, auth, actingUserId, id, payload }) {
  const serialNumber = readSerial(payload.serialNumber);
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  await findVisible(tenantId, auth, id);
  try {
    await sequelize.transaction(async (transaction) => {
      const tyre = await lockTyre(tenantId, id, transaction);
      await saveTyre(tenantId, tyre, { serialNumber, notes }, { actingUserId, transaction });
    });
  } catch (error) {
    if (isUniqueSerialError(error)) throw AppError.conflict(`Serial number ${serialNumber} is already recorded for another tyre.`);
    throw error;
  }
  return detailOf(tenantId, await repo.findByPk(tenantId, id));
}

// ---------------------------------------------------------------------------------------------------------------------
// Lists

async function tyreWhere(tenantId, auth, query) {
  const and = [];
  const siteId = siteFilter(auth, query);
  if (siteId) and.push(await atSiteCondition(tenantId, siteId));

  if (query.status === 'stored') and.push({ tyreStatus: Tyre.STORED });
  else {
    const status = parseEnumFilter(query.status, Tyre.STATUSES, 'Status');
    if (status) and.push({ tyreStatus: status });
  }
  if (query.tyreTypeId) and.push({ tyreTypeId: requireIdFilter(query.tyreTypeId, 'Tyre type') });

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const like = { [Op.like]: containsPattern(search) };
    const types = await TyreType.findAll({ where: { tenantId, [Op.or]: [{ brand: like }, { pattern: like }, { size: like }] }, attributes: ['id'] });
    const options = [{ tyreCode: like }, { serialNumber: like }, { position: like }];
    if (types.length) options.push({ tyreTypeId: types.map((t) => t.id) });
    for (const ref of await assetRefsMatchingNumber(tenantId, search)) {
      options.push({ assetType: ref.assetType, assetId: ref.assetId });
      options.push({ ownerAssetType: ref.assetType, ownerAssetId: ref.assetId });
    }
    and.push({ [Op.or]: options });
  }
  return and.length ? { [Op.and]: and } : {};
}

async function listTyres({ tenantId, auth, query }) {
  // Newest first: the tyre added or changed most recently (bought, fitted, taken off, punctured, moved...) is on top.
  const { page, limit, offset, order } = parseListQuery(query, { sortableFields: ['updatedAt', 'tyreCode', 'createdAt', 'purchaseCost'], defaultSort: 'updatedAt:desc' });
  const where = await tyreWhere(tenantId, auth, query);
  const { rows, count } = await repo.findAndCountAll(tenantId, { where, order: [...order, ['id', 'DESC']], limit, offset });
  return buildListResponse(await decorate(tenantId, rows), { page, limit, total: count });
}

async function summary({ tenantId, auth, query }) {
  const siteId = siteFilter(auth, query);
  const where = siteId ? await atSiteCondition(tenantId, siteId) : {};
  const rows = await Tyre.findAll({
    where: { [Op.and]: [{ tenantId }, where] },
    attributes: [
      'tyreStatus',
      [fn('COUNT', col('id')), 'count'],
      [fn('SUM', col('purchase_cost')), 'value'],
      [fn('SUM', col('repair_cost')), 'repairs'],
      [fn('SUM', col('scrap_value')), 'scrapValue'],
    ],
    group: ['tyreStatus'],
    raw: true,
  });
  const counts = Object.fromEntries(Tyre.STATUSES.map((s) => [s, 0]));
  let newStoreValue = 0;
  // Scrapped tyres: what they cost (bought + repairs, like each tyre's total cost) and what their scrap brought back.
  const scrapped = { cost: 0, scrapValue: 0 };
  for (const r of rows) {
    counts[r.tyreStatus] = Number(r.count);
    if (r.tyreStatus === 'new') newStoreValue = roundMoney(Number(r.value ?? 0));
    if (r.tyreStatus === 'scrapped') {
      scrapped.cost = roundMoney(Number(r.value ?? 0) + Number(r.repairs ?? 0));
      scrapped.scrapValue = roundMoney(Number(r.scrapValue ?? 0));
    }
  }
  return { counts, newStoreValue, scrapped };
}

async function getTyre({ tenantId, auth, id }) {
  return detailOf(tenantId, await findVisible(tenantId, auth, id));
}

module.exports = {
  createPurchasedTyres,
  addSpareTyres,
  saveLayout,
  getAssetTyres,
  listAssetSetups,
  assetTyreCost,
  fitTyre,
  removeTyre,
  recordPuncture,
  sendForRemould,
  remouldBack,
  scrapTyre,
  updateTyre,
  listTyres,
  summary,
  getTyre,
  // shared with the report service
  siteFilter,
  decorateEvents,
};
