const { Op, Transaction } = require('sequelize');

const { sequelize, Tyre, TyreEvent, TyreTransfer, TyreType, User } = require('../models');
const AppError = require('../utils/AppError');
const { requireNumber, optionalText } = require('../utils/validation');
const { parseListQuery } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { createTenantScopedRepository } = require('./tenantScopedRepository');
const { recordCreate, recordUpdate } = require('./audit.service');
const { assertSiteAllowed, siteFilterIds, siteCondition } = require('./siteAccess');
const { nextSequentialCode } = require('./codeGenerator');
const { requireBusinessDate, optionalDateFilter, siteNamesById } = require('./fuelCommon');
const { assertSiteUsable, tyreTypeSummary, readTime, isBefore, formatWhen } = require('./tyreCommon');

const repo = createTenantScopedRepository(TyreTransfer);
const NUMBER_PREFIX = 'TRF-';
const MAX_TYRES = 200;
const STATUS_WORDS = { fitted: 'fitted', remould: 'away for remoulding', scrapped: 'scrapped' };

function readTyreIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw AppError.badRequest('Choose at least one tyre to transfer');
  if (value.length > MAX_TYRES) throw AppError.badRequest(`You can transfer at most ${MAX_TYRES} tyres at once`);
  const ids = value.map((v) => requireNumber(v, 'Tyre', { min: 1 }));
  if (new Set(ids).size !== ids.length) throw AppError.badRequest('The same tyre is listed twice');
  return ids;
}

async function decorate(tenantId, transfers, { withTyres = false } = {}) {
  if (transfers.length === 0) return [];
  const [siteNames, users] = await Promise.all([
    siteNamesById(tenantId, transfers.flatMap((t) => [t.fromSiteId, t.toSiteId])),
    User.findAll({ where: { tenantId, id: [...new Set(transfers.map((t) => t.createdBy))] }, attributes: ['id', 'name'] }),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.name]));

  let tyresByTransfer = new Map();
  if (withTyres) {
    const events = await TyreEvent.findAll({ where: { tenantId, transferId: transfers.map((t) => t.id) }, attributes: ['transferId', 'tyreId'], order: [['id', 'ASC']] });
    const tyres = events.length ? await Tyre.findAll({ where: { tenantId, id: events.map((e) => e.tyreId) }, include: [{ model: TyreType, as: 'tyreType' }] }) : [];
    const tyreById = new Map(tyres.map((t) => [t.id, t]));
    tyresByTransfer = events.reduce((map, e) => {
      const t = tyreById.get(e.tyreId);
      if (!t) return map;
      const row = { id: t.id, tyreCode: t.tyreCode, serialNumber: t.serialNumber, status: t.tyreStatus, ...tyreTypeSummary(t.tyreType) };
      return map.set(e.transferId, [...(map.get(e.transferId) ?? []), row]);
    }, new Map());
  }

  return transfers.map((t) => ({
    ...t.toPublicJSON(),
    fromSiteName: siteNames.get(t.fromSiteId) ?? null,
    toSiteName: siteNames.get(t.toSiteId) ?? null,
    createdByName: userNames.get(t.createdBy) ?? null,
    ...(withTyres ? { tyres: tyresByTransfer.get(t.id) ?? [] } : {}),
  }));
}

async function createTransfer({ tenantId, auth, actingUserId, payload }) {
  const fromSiteId = await assertSiteUsable(tenantId, payload.fromSiteId);
  // Transfer is Admin-only by default, but can be granted to a role: then tyres may only leave the user's own sites.
  assertSiteAllowed(auth, fromSiteId, 'Site not found');
  const toSiteId = await assertSiteUsable(tenantId, payload.toSiteId);
  if (fromSiteId === toSiteId) throw AppError.badRequest('Choose a different site to transfer to.');
  const date = requireBusinessDate(payload.date, 'Transfer date');
  const time = readTime(payload.time, 'Transfer time');
  const notes = optionalText(payload.notes, 'Notes', { max: 1000 });
  const tyreIds = readTyreIds(payload.tyreIds);

  const id = await sequelize.transaction(async (transaction) => {
    // Lock the tyres in id order, so two transfers can't wait on each other.
    const tyres = await Tyre.findAll({ where: { tenantId, id: tyreIds }, order: [['id', 'ASC']], transaction, lock: Transaction.LOCK.UPDATE });
    if (tyres.length !== tyreIds.length) throw AppError.badRequest('One of the tyres was not found. Reload and try again.');
    for (const tyre of tyres) {
      if (!Tyre.STORED.includes(tyre.tyreStatus)) {
        throw AppError.conflict(`Tyre ${tyre.tyreCode} is ${STATUS_WORDS[tyre.tyreStatus]}. Only tyres in the New or Spare Tyre Store can be transferred.`);
      }
      if (Number(tyre.siteId) !== fromSiteId) throw AppError.conflict(`Tyre ${tyre.tyreCode} is not at the site you are transferring from. Reload and try again.`);
    }
    // The transfer can't be dated before the latest entry of any of its tyres.
    const later = await TyreEvent.findAll({ where: { tenantId, tyreId: tyreIds, eventDate: { [Op.gte]: date } }, order: [['eventDate', 'DESC'], ['eventTime', 'DESC'], ['id', 'DESC']], transaction });
    const last = later.find((e) => isBefore(date, time, e.eventDate, e.eventTime));
    if (last) {
      const tyre = tyres.find((t) => t.id === last.tyreId);
      throw AppError.badRequest(
        `Transfer date (${formatWhen(date, time)}) can't be before ${formatWhen(last.eventDate, last.eventTime)}, the last entry in the history of tyre ${tyre.tyreCode}.`
      );
    }

    const transferNumber = await nextSequentialCode(TyreTransfer, 'transferNumber', NUMBER_PREFIX, { tenantId, transaction });
    const transfer = await repo.create(tenantId, { transferNumber, fromSiteId, toSiteId, transferDate: date, transferTime: time, tyreCount: tyres.length, notes, createdBy: actingUserId }, { transaction });
    const names = await siteNamesById(tenantId, [fromSiteId, toSiteId]);
    const note = `${transferNumber}: ${names.get(fromSiteId)} → ${names.get(toSiteId)}`;
    for (const tyre of tyres) {
      await TyreEvent.create({ tenantId, tyreId: tyre.id, eventType: 'transferred', eventDate: date, eventTime: time, siteId: toSiteId, notes: note, transferId: transfer.id, createdBy: actingUserId }, { transaction });
      const before = tyre.toJSON();
      await tyre.update({ siteId: toSiteId, updatedBy: actingUserId }, { transaction });
      await recordUpdate({ tenantId, entityType: 'Tyre', entityId: tyre.id, performedBy: actingUserId, before, after: tyre }, { transaction });
    }
    await recordCreate({ tenantId, entityType: 'TyreTransfer', entityId: transfer.id, performedBy: actingUserId, after: transfer }, { transaction });
    return transfer.id;
  });
  const [json] = await decorate(tenantId, [await repo.findByPk(tenantId, id)], { withTyres: true });
  return json;
}

// A site user sees the transfers into and out of their own sites.
async function listTransfers({ tenantId, auth, query }) {
  const { page, limit, offset, order } = parseListQuery(query, { sortableFields: ['transferDate', 'createdAt'], defaultSort: 'transferDate:desc' });
  const and = [];
  const siteIds = siteFilterIds(auth, query.siteId);
  if (siteIds) and.push({ [Op.or]: [{ fromSiteId: siteCondition(siteIds) }, { toSiteId: siteCondition(siteIds) }] });
  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom) and.push({ transferDate: { [Op.gte]: dateFrom } });
  if (dateTo) and.push({ transferDate: { [Op.lte]: dateTo } });
  const { rows, count } = await repo.findAndCountAll(tenantId, { where: and.length ? { [Op.and]: and } : {}, order: [...order, ...order.filter(([field]) => field === 'transferDate').map(([, direction]) => ['transferTime', direction]), ['id', 'DESC']], limit, offset });
  return buildListResponse(await decorate(tenantId, rows, { withTyres: true }), { page, limit, total: count });
}

module.exports = { createTransfer, listTransfers };
