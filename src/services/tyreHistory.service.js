const { Op } = require('sequelize');

const { Tyre, TyreEvent, TyreType, TyreTransfer } = require('../models');
const AppError = require('../utils/AppError');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { createTenantScopedRepository } = require('./tenantScopedRepository');
const { assetRefsMatchingNumber } = require('./assetIdentifier.service');
const { optionalDateFilter } = require('./fuelCommon');
const { tyreTypeSummary } = require('./tyreCommon');
const { siteFilter, decorateEvents } = require('./tyre.service');

const repo = createTenantScopedRepository(TyreEvent);

// Every entry in every tyre's history, filtered. Used by the Tyre History page and its PDF.
async function historyWhere(tenantId, auth, query) {
  const and = [];
  const siteId = siteFilter(auth, query);
  if (siteId) and.push({ siteId });
  const eventType = parseEnumFilter(query.eventType, TyreEvent.EVENT_TYPES, 'Activity');
  if (eventType) and.push({ eventType });
  const assetType = parseEnumFilter(query.assetType, Tyre.ASSET_TYPES, 'Asset type');
  if (assetType) and.push({ assetType });

  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (dateFrom) and.push({ eventDate: { [Op.gte]: dateFrom } });
  if (dateTo) and.push({ eventDate: { [Op.lte]: dateTo } });

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const like = { [Op.like]: containsPattern(search) };
    const types = await TyreType.findAll({ where: { tenantId, [Op.or]: [{ brand: like }, { pattern: like }, { size: like }] }, attributes: ['id'] });
    const tyres = await Tyre.findAll({
      where: { tenantId, [Op.or]: [{ tyreCode: like }, { serialNumber: like }, ...(types.length ? [{ tyreTypeId: types.map((t) => t.id) }] : [])] },
      attributes: ['id'],
    });
    const options = [{ vendor: like }, { notes: like }, { position: like }];
    if (tyres.length) options.push({ tyreId: tyres.map((t) => t.id) });
    options.push(...(await assetRefsMatchingNumber(tenantId, search)));
    and.push({ [Op.or]: options });
  }
  return and.length ? { [Op.and]: and } : {};
}

async function decorate(tenantId, events) {
  if (events.length === 0) return [];
  const tyres = await Tyre.findAll({
    where: { tenantId, id: [...new Set(events.map((e) => e.tyreId))] },
    attributes: ['id', 'tyreCode', 'serialNumber', 'tyreTypeId'],
    include: [{ model: TyreType, as: 'tyreType' }],
  });
  const transferIds = [...new Set(events.map((e) => e.transferId).filter(Boolean))];
  const transfers = transferIds.length ? await TyreTransfer.findAll({ where: { tenantId, id: transferIds }, attributes: ['id', 'transferNumber'] }) : [];
  const tyreById = new Map(tyres.map((t) => [t.id, t]));
  const transferById = new Map(transfers.map((t) => [t.id, t.transferNumber]));
  return (await decorateEvents(tenantId, events)).map((e) => {
    const tyre = tyreById.get(e.tyreId);
    return {
      ...e,
      tyreCode: tyre?.tyreCode ?? null,
      serialNumber: tyre?.serialNumber ?? null,
      ...tyreTypeSummary(tyre?.tyreType),
      transferNumber: e.transferId ? transferById.get(e.transferId) ?? null : null,
    };
  });
}

async function listHistory({ tenantId, auth, query }) {
  const { page, limit, offset, order } = parseListQuery(query, { sortableFields: ['eventDate', 'amount'], defaultSort: 'eventDate:desc' });
  const where = await historyWhere(tenantId, auth, query);
  const timeOrder = order.filter(([field]) => field === 'eventDate').map(([, direction]) => ['eventTime', direction]);

  const { rows, count } = await repo.findAndCountAll(tenantId, { where, order: [...order, ...timeOrder, ['id', 'DESC']], limit, offset });
  return buildListResponse(await decorate(tenantId, rows), { page, limit, total: count });
}

module.exports = { listHistory };
