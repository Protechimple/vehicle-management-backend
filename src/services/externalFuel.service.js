const { Op, Transaction, fn, col, where: sqlWhere } = require('sequelize');

const { sequelize, ExternalFuelEntry, FuelStockLedger, Site } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, optionalText, optionalNumber, optionalPhone } = require('../utils/validation');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { createTenantScopedRepository } = require('./tenantScopedRepository');
const { recordArchive, recordCreate, recordUpdate } = require('./audit.service');
const { assertSiteAllowed, ownSiteFor } = require('./siteAccess');
const { assertSiteAssignable } = require('./site.service');
const { nextSequentialCode } = require('./codeGenerator');
const { postFuelMovement, siteScope } = require('./fuelStock.service');
const {
  roundQuantity,
  roundMoney,
  requireBusinessDate,
  optionalDateFilter,
  requirePositive,
  requireStorableFuelType,
} = require('./fuelCommon');

// Fuel given from site stock to vehicles outside the organization. Deliberately separate from
// fuelTransaction.service: there is no asset, meter sequence or asset cost here, only a stock movement.

const repo = createTenantScopedRepository(ExternalFuelEntry);

const ENTITY_TYPE = 'ExternalFuelEntry';
const ENTRY_NUMBER_PREFIX = 'EXF-';
const NOT_FOUND = 'External fuel entry not found';

const SORTABLE_FIELDS = ['entryDate', 'createdAt', 'entryNumber', 'quantity', 'amount'];
const DEFAULT_SORT = 'entryDate:desc';

const INCLUDE_SITE = [{ model: Site, as: 'site', attributes: ['id', 'name'] }];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

function readTime(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !TIME_PATTERN.test(value.trim())) {
    throw AppError.badRequest('Time must be a valid time (HH:MM)');
  }
  return `${value.trim().slice(0, 5)}:00`;
}

function normaliseVehicleNumber(value) {
  return requireText(value, 'Vehicle number', { max: 32 }).replace(/\s+/g, ' ').toUpperCase();
}

function readCategory(value) {
  const category = requireText(value, 'Category', { max: 20 }).toUpperCase();
  if (!ExternalFuelEntry.CATEGORIES.includes(category)) {
    throw AppError.badRequest(`Category must be one of: ${ExternalFuelEntry.CATEGORIES.join(', ')}`);
  }
  return category;
}

// Fields that can be set on create and changed later. Litres, site and fuel type are fixed once saved,
// because they are what the stock movement was posted with.
function readDetails(payload) {
  const entryTime = readTime(payload.entryTime);
  const meterReading = optionalNumber(payload.meterReading, 'Meter reading', { min: 0, max: 999999999999 });
  return {
    entryDate: requireBusinessDate(payload.entryDate, 'Date'),
    ...(entryTime === undefined ? {} : { entryTime }),
    vehicleNumber: normaliseVehicleNumber(payload.vehicleNumber),
    vehicleName: optionalText(payload.vehicleName, 'Vehicle name', { max: 100 }),
    category: readCategory(payload.category),
    partyName: requireText(payload.partyName, 'Party / company name', { max: 150 }),
    driverName: optionalText(payload.driverName, 'Driver name', { max: 150 }),
    driverMobile: optionalPhone(payload.driverMobile, 'Driver mobile'),
    meterReading: meterReading == null ? null : roundMoney(meterReading),
    authorisedBy: optionalText(payload.authorisedBy, 'Authorised by', { max: 150 }),
    referenceNumber: optionalText(payload.referenceNumber, 'Slip / reference number', { max: 64 }),
    notes: optionalText(payload.notes, 'Remarks', { max: 2000 }),
  };
}

function toPublic(entry) {
  return { ...entry.toPublicJSON(), siteName: entry.site?.name ?? null };
}

async function findVisible(tenantId, auth, id, options = {}) {
  const entry = await repo.findByPk(tenantId, id, options);
  if (!entry) throw AppError.notFound(NOT_FOUND);
  assertSiteAllowed(auth, entry.siteId, NOT_FOUND);
  return entry;
}

// Vehicle numbers are typed by hand, so "MH12 AB 1234" and "mh-12-ab-1234" must find the same entry.
function vehicleNumberMatches(search) {
  const compact = search.replace(/[\s-]+/g, '');
  if (!compact) return null;
  const stripped = fn('REPLACE', fn('REPLACE', col('ExternalFuelEntry.vehicle_number'), ' ', ''), '-', '');
  return sqlWhere(stripped, { [Op.like]: containsPattern(compact) });
}

function buildListWhere(auth, query) {
  const where = { ...siteScope(auth, query) };

  const status = parseEnumFilter(query.status, ExternalFuelEntry.STATUSES, 'Status') ?? 'active';
  where.status = status;
  const fuelType = parseEnumFilter(query.fuelType, ExternalFuelEntry.FUEL_TYPES, 'Fuel type');
  if (fuelType) where.fuelType = fuelType;
  const category = parseEnumFilter(
    typeof query.category === 'string' ? query.category.toUpperCase() : query.category,
    ExternalFuelEntry.CATEGORIES,
    'Category'
  );
  if (category) where.category = category;

  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (dateFrom || dateTo) {
    where.entryDate = {};
    if (dateFrom) where.entryDate[Op.gte] = dateFrom;
    if (dateTo) where.entryDate[Op.lte] = dateTo;
  }

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = containsPattern(search);
    where[Op.or] = [
      { entryNumber: { [Op.like]: pattern } },
      { vehicleNumber: { [Op.like]: pattern } },
      { partyName: { [Op.like]: pattern } },
      { driverName: { [Op.like]: pattern } },
      { referenceNumber: { [Op.like]: pattern } },
    ];
    const compactMatch = vehicleNumberMatches(search);
    if (compactMatch) where[Op.or].push(compactMatch);
  }

  return where;
}

async function listExternalFuelEntries({ tenantId, auth, query }) {
  const { page, limit, offset, order } = parseListQuery(query, {
    sortableFields: SORTABLE_FIELDS,
    defaultSort: DEFAULT_SORT,
  });
  const where = buildListWhere(auth, query);

  const timeOrder = order.filter(([field]) => field === 'entryDate').map(([, direction]) => ['entryTime', direction]);
  const { rows, count } = await repo.findAndCountAll(tenantId, {
    where,
    include: INCLUDE_SITE,
    order: [...order, ...timeOrder, ['id', 'DESC']],
    limit,
    offset,
  });

  return buildListResponse(rows.map(toPublic), { page, limit, total: count });
}

async function getExternalFuelEntry({ tenantId, auth, id }) {
  const entry = await findVisible(tenantId, auth, id, { include: INCLUDE_SITE });
  return toPublic(entry);
}

async function createExternalFuelEntry({ tenantId, auth, actingUserId, payload }) {
  const ownSiteId = ownSiteFor(auth, payload.siteId);
  const siteId = ownSiteId !== null ? ownSiteId : optionalNumber(payload.siteId, 'Site', { min: 1 });
  if (siteId == null) throw AppError.badRequest('Site is required');
  await assertSiteAssignable(tenantId, siteId);

  const fuelType = requireStorableFuelType(payload.fuelType);
  const quantity = roundQuantity(requirePositive(payload.quantity, 'Quantity (litres)'));
  const details = readDetails(payload);

  const created = await sequelize.transaction(async (transaction) => {
    const entryNumber = await nextSequentialCode(ExternalFuelEntry, 'entryNumber', ENTRY_NUMBER_PREFIX, {
      tenantId,
      transaction,
    });

    const entry = await repo.create(
      tenantId,
      {
        ...details,
        entryNumber,
        siteId,
        fuelType,
        quantity,
        pricePerLitre: 0,
        amount: 0,
        status: 'active',
        createdBy: actingUserId,
        updatedBy: actingUserId,
      },
      { transaction }
    );

    const ledger = await postFuelMovement({
      tenantId,
      siteId,
      fuelType,
      entryType: 'EXTERNAL_ISSUE',
      direction: 'OUT',
      quantity,
      entryDate: details.entryDate,
      referenceType: 'EXTERNAL_FUEL_ENTRY',
      referenceId: entry.id,
      createdBy: actingUserId,
      transaction,
    });

    await entry.update(
      { pricePerLitre: Number(ledger.unitCost), amount: Number(ledger.totalCost), ledgerEntryId: ledger.id },
      { transaction }
    );

    await recordCreate(
      { tenantId, entityType: ENTITY_TYPE, entityId: entry.id, performedBy: actingUserId, after: entry },
      { transaction }
    );

    return entry;
  });

  return getExternalFuelEntry({ tenantId, auth, id: created.id });
}

function assertUnchanged(payload, field, current, message, normalise = (v) => v) {
  const sent = payload[field];
  if (sent === undefined || sent === null || sent === '') return;
  if (normalise(sent) !== normalise(current)) throw AppError.badRequest(message);
}

async function updateExternalFuelEntry({ tenantId, auth, actingUserId, id, payload }) {
  const entry = await findVisible(tenantId, auth, id);
  if (entry.status !== 'active') throw AppError.conflict('A deleted entry cannot be edited');

  const relocking = "can't be changed once saved. Delete this entry (the fuel goes back to stock) and enter it again.";
  assertUnchanged(payload, 'quantity', entry.quantity, `Litres ${relocking}`, (v) => roundQuantity(Number(v)));
  assertUnchanged(payload, 'siteId', entry.siteId, `The site ${relocking}`, (v) => Number(v));
  assertUnchanged(payload, 'fuelType', entry.fuelType, `The fuel type ${relocking}`, (v) => String(v));

  const changes = readDetails(payload);

  await sequelize.transaction(async (transaction) => {
    const locked = await ExternalFuelEntry.findOne({
      where: { tenantId, id: entry.id },
      transaction,
      lock: Transaction.LOCK.UPDATE,
    });
    if (locked.status !== 'active') throw AppError.conflict('A deleted entry cannot be edited');

    // Keep the stock movement on the same day as the entry, so the site fuel register stays right.
    if (changes.entryDate !== locked.entryDate && locked.ledgerEntryId) {
      await FuelStockLedger.update(
        { entryDate: changes.entryDate },
        { where: { tenantId, id: locked.ledgerEntryId }, transaction }
      );
    }

    const before = locked.toJSON();
    await locked.update({ ...changes, updatedBy: actingUserId }, { transaction });

    await recordUpdate(
      { tenantId, entityType: ENTITY_TYPE, entityId: locked.id, performedBy: actingUserId, before, after: locked },
      { transaction }
    );
  });

  return getExternalFuelEntry({ tenantId, auth, id: entry.id });
}

async function deleteExternalFuelEntry({ tenantId, auth, actingUserId, id, confirmation }) {
  if (confirmation !== 'DELETE') {
    throw AppError.badRequest('Type DELETE to confirm this action.');
  }

  const entry = await findVisible(tenantId, auth, id);

  await sequelize.transaction(async (transaction) => {
    const locked = await ExternalFuelEntry.findOne({
      where: { tenantId, id: entry.id },
      transaction,
      lock: Transaction.LOCK.UPDATE,
    });
    if (locked.status === 'archived') throw AppError.conflict('This entry is already deleted');

    let reversalLedgerEntryId = null;
    if (locked.ledgerEntryId) {
      const reversal = await postFuelMovement({
        tenantId,
        siteId: locked.siteId,
        fuelType: locked.fuelType,
        entryType: 'EXTERNAL_ISSUE_REVERSAL',
        direction: 'IN',
        quantity: Number(locked.quantity),
        unitCost: Number(locked.pricePerLitre),
        totalCost: Number(locked.amount),
        entryDate: locked.entryDate,
        referenceType: 'EXTERNAL_FUEL_ENTRY',
        referenceId: locked.id,
        createdBy: actingUserId,
        transaction,
      });
      reversalLedgerEntryId = reversal.id;
    }

    await locked.update(
      { status: 'archived', archivedAt: new Date(), archivedBy: actingUserId, reversalLedgerEntryId, updatedBy: actingUserId },
      { transaction }
    );

    await recordArchive(
      { tenantId, entityType: ENTITY_TYPE, entityId: locked.id, performedBy: actingUserId },
      { transaction }
    );
  });

  return getExternalFuelEntry({ tenantId, auth, id: entry.id });
}

module.exports = {
  listExternalFuelEntries,
  getExternalFuelEntry,
  createExternalFuelEntry,
  updateExternalFuelEntry,
  deleteExternalFuelEntry,
  buildListWhere,
};
