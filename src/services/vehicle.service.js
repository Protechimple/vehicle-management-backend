const { Op } = require('sequelize');

const { sequelize, Vehicle, AuditLog, AssetDocument, AssetPhoto } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, optionalText, requireNumber } = require('../utils/validation');
const { assertMeterNotDecreasing } = require('../utils/meter');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { createTenantScopedRepository } = require('./tenantScopedRepository');
const { nextSequentialCode } = require('./codeGenerator');
const { archiveEntity, restoreEntity } = require('./archive.service');
const { recordCreate, recordUpdate } = require('./audit.service');
const { assetCostSummary } = require('./assetCost.service');
const {
  scopeToSite,
  assertSiteAllowed,
  assertSiteChangeAllowed,
  ownSiteFor,
  siteFilterIds,
  siteCondition,
} = require('./siteAccess');
const storage = require('./storage.service');
const { assertSiteAssignable } = require('./site.service');
const { recordSiteAssignment } = require('./siteAssignment.service');
const {
  assertChassisNumberAvailable,
  assertRegistrationNumberAvailable,
} = require('./assetIdentifier.service');
const {
  saveComplianceDocuments,
  readComplianceInput,
  isDocEntered,
  DOC_TYPE_PAYLOAD_KEYS,
} = require('./complianceDocument.service');
const { getMandatoryDocTypes, createDocumentsForNewAsset } = require('./assetDocument.service');

const repo = createTenantScopedRepository(Vehicle);

const SORTABLE_FIELDS = ['createdAt', 'registrationNumber', 'currentKM', 'assetId'];
const DEFAULT_SORT = 'createdAt:desc';

const ASSET_ID_GENERATION_ATTEMPTS = 5;

function toPublic(vehicle, extras) {
  const data = vehicle.toPublicJSON();
  if (!extras) return data;
  return {
    ...data,
    missingDocTypes: extras.missingDocTypes.get(vehicle.assetId) ?? [],
    coverPhotoId: extras.coverPhotoIds.get(vehicle.assetId) ?? null,
  };
}

// Which mandatory documents each vehicle still lacks, and its cover photo: one query each for the whole page.
async function loadListExtras(tenantId, vehicles) {
  const assetIds = vehicles.map((v) => v.assetId);
  const mandatory = getMandatoryDocTypes('VEHICLE');
  const [docs, covers] = assetIds.length
    ? await Promise.all([
        AssetDocument.findAll({
          where: { tenantId, assetType: 'VEHICLE', assetId: assetIds, docType: mandatory },
          attributes: ['assetId', 'docType'],
        }),
        AssetPhoto.findAll({
          where: { tenantId, assetType: 'VEHICLE', assetId: assetIds, isCover: true },
          attributes: ['id', 'assetId'],
        }),
      ])
    : [[], []];

  const present = new Set(docs.map((d) => `${d.assetId}:${d.docType}`));
  const missingDocTypes = new Map(
    assetIds.map((assetId) => [assetId, mandatory.filter((docType) => !present.has(`${assetId}:${docType}`))])
  );
  const coverPhotoIds = new Map(covers.map((c) => [c.assetId, c.id]));
  return { missingDocTypes, coverPhotoIds };
}

// Vehicles without every mandatory document, for the "documents missing" filter.
function missingMandatoryDocsCondition() {
  const docTypes = getMandatoryDocTypes('VEHICLE').map((docType) => sequelize.escape(docType)).join(', ');
  return sequelize.literal(`(
    SELECT COUNT(DISTINCT d.doc_type) FROM asset_documents d
     WHERE d.tenant_id = \`Vehicle\`.\`tenant_id\` AND d.asset_type = 'VEHICLE'
       AND d.asset_id = \`Vehicle\`.\`asset_id\` AND d.doc_type IN (${docTypes})
  ) < ${getMandatoryDocTypes('VEHICLE').length}`);
}

const ASSET_ID_PREFIX = 'VEH-';

async function generateAssetId(tenantId, { transaction } = {}) {
  return nextSequentialCode(Vehicle, 'assetId', ASSET_ID_PREFIX, { tenantId, transaction });
}

function isAssetIdCollision(error) {
  return (
    error.name === 'SequelizeUniqueConstraintError' &&
    Object.keys(error.fields ?? {}).some((indexName) => indexName.includes('asset_id'))
  );
}

function isHoursBasedType(type) {
  return type === Vehicle.HOURS_BASED_TYPE;
}

function parseComplianceField(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw AppError.badRequest('Compliance data is not valid JSON');
    }
  }
  return {};
}

function readVehicleBaseInput(payload, { partial = false } = {}) {
  const input = {};

  if (!partial || payload.registrationNumber !== undefined) {
    input.registrationNumber = requireText(payload.registrationNumber, 'Registration number', {
      max: 32,
    });
  }
  if (!partial || payload.type !== undefined) {
    const type = requireText(payload.type, 'Type', { max: 100 });
    if (!Vehicle.TYPES.includes(type)) {
      throw AppError.badRequest(`Type must be one of: ${Vehicle.TYPES.join(', ')}`);
    }
    input.type = type;
  }
  if (!partial || payload.fuelType !== undefined) {
    const fuelType = requireText(payload.fuelType, 'Fuel type', { max: 50 });
    if (!Vehicle.FUEL_TYPES.includes(fuelType)) {
      throw AppError.badRequest(`Fuel type must be one of: ${Vehicle.FUEL_TYPES.join(', ')}`);
    }
    input.fuelType = fuelType;
  }
  if (!partial || payload.modelNumber !== undefined) {
    input.modelNumber = optionalText(payload.modelNumber, 'Model number', { max: 100 });
  }
  if (!partial || payload.chassisNumber !== undefined) {
    input.chassisNumber = optionalText(payload.chassisNumber, 'Chassis number', { max: 100 });
  }
  if (!partial || payload.year !== undefined) {
    input.year =
      payload.year === undefined || payload.year === null || payload.year === ''
        ? null
        : requireNumber(payload.year, 'Year', { min: 1900, max: 2100 });
  }

  return input;
}

function readCurrentSiteIdInput(payload, { partial = false } = {}) {
  if (payload.currentSiteId === undefined) {
    return partial ? {} : { currentSiteId: null };
  }
  if (payload.currentSiteId === null || payload.currentSiteId === '') {
    return { currentSiteId: null };
  }
  return { currentSiteId: requireNumber(payload.currentSiteId, 'Site', { min: 1 }) };
}

const BLANK_KM_METER = { currentKM: null, serviceIntervalKM: null, nextServiceKM: null };
const BLANK_HOURS_METER = { currentHours: null, serviceIntervalHours: null, nextServiceHours: null };

function readMeterInputForCreate(payload, type) {
  if (isHoursBasedType(type)) {
    const currentHours = requireNumber(payload.currentHours, 'Current hours', { min: 0 });
    const serviceIntervalHours = requireNumber(payload.serviceIntervalHours, 'Service interval (hours)', {
      min: 1,
    });
    return {
      ...BLANK_KM_METER,
      currentHours,
      serviceIntervalHours,
      nextServiceHours: currentHours + serviceIntervalHours,
    };
  }

  const currentKM = requireNumber(payload.currentKM, 'Current KM', { min: 0 });
  const serviceIntervalKM = requireNumber(payload.serviceIntervalKM, 'Service interval (KM)', { min: 1 });
  return {
    currentKM,
    serviceIntervalKM,
    nextServiceKM: currentKM + serviceIntervalKM,
    ...BLANK_HOURS_METER,
  };
}

function readMeterInputForUpdate(payload, vehicle, nextType) {
  const wasHoursBased = isHoursBasedType(vehicle.type);
  const willBeHoursBased = isHoursBasedType(nextType);
  const basisChanged = wasHoursBased !== willBeHoursBased;

  if (willBeHoursBased) {
    if (payload.currentKM !== undefined || payload.serviceIntervalKM !== undefined) {
      throw AppError.badRequest('Current KM and service interval (KM) do not apply to a Heavy Vehicle');
    }

    if (basisChanged) {
      const currentHours = requireNumber(payload.currentHours, 'Current hours', { min: 0 });
      const serviceIntervalHours = requireNumber(payload.serviceIntervalHours, 'Service interval (hours)', {
        min: 1,
      });
      return {
        ...BLANK_KM_METER,
        currentHours,
        serviceIntervalHours,
        nextServiceHours: currentHours + serviceIntervalHours,
      };
    }

    const nextCurrentHours =
      payload.currentHours !== undefined
        ? assertMeterNotDecreasing(vehicle.currentHours, payload.currentHours, 'Hours')
        : Number(vehicle.currentHours);
    const nextIntervalHours =
      payload.serviceIntervalHours !== undefined
        ? requireNumber(payload.serviceIntervalHours, 'Service interval (hours)', { min: 1 })
        : Number(vehicle.serviceIntervalHours);
    const nextServiceHours =
      nextIntervalHours !== Number(vehicle.serviceIntervalHours)
        ? nextCurrentHours + nextIntervalHours
        : Number(vehicle.nextServiceHours);

    return {
      ...BLANK_KM_METER,
      currentHours: nextCurrentHours,
      serviceIntervalHours: nextIntervalHours,
      nextServiceHours,
    };
  }

  if (payload.currentHours !== undefined || payload.serviceIntervalHours !== undefined) {
    throw AppError.badRequest('Current hours and service interval (hours) do not apply to a Light Vehicle');
  }

  if (basisChanged) {
    const currentKM = requireNumber(payload.currentKM, 'Current KM', { min: 0 });
    const serviceIntervalKM = requireNumber(payload.serviceIntervalKM, 'Service interval (KM)', { min: 1 });
    return {
      currentKM,
      serviceIntervalKM,
      nextServiceKM: currentKM + serviceIntervalKM,
      ...BLANK_HOURS_METER,
    };
  }

  const nextCurrentKM =
    payload.currentKM !== undefined
      ? assertMeterNotDecreasing(vehicle.currentKM, payload.currentKM, 'KM')
      : Number(vehicle.currentKM);
  const nextIntervalKM =
    payload.serviceIntervalKM !== undefined
      ? requireNumber(payload.serviceIntervalKM, 'Service interval (KM)', { min: 1 })
      : Number(vehicle.serviceIntervalKM);
  const nextServiceKM =
    nextIntervalKM !== Number(vehicle.serviceIntervalKM) ? nextCurrentKM + nextIntervalKM : Number(vehicle.nextServiceKM);

  return {
    currentKM: nextCurrentKM,
    serviceIntervalKM: nextIntervalKM,
    nextServiceKM,
    ...BLANK_HOURS_METER,
  };
}

function assertMandatoryDocuments(files) {
  const missing = getMandatoryDocTypes('VEHICLE').filter((docType) => !files?.[docType]);
  if (missing.length === 0) return;

  const noun = missing.length > 1 ? 'documents are' : 'document is';
  throw AppError.badRequest(`${missing.join(' and ')} ${noun} required to create a vehicle`);
}

async function listVehicles({ tenantId, auth, query }) {
  const { page, limit, offset, order } = parseListQuery(query, {
    sortableFields: SORTABLE_FIELDS,
    defaultSort: DEFAULT_SORT,
  });

  const status = parseEnumFilter(query.status, Vehicle.STATUSES, 'Status') ?? 'active';
  const where = scopeToSite({ status }, auth);
  if (query.fuelType) where.fuelType = query.fuelType;
  if (query.siteId) where.currentSiteId = siteCondition(siteFilterIds(auth, query.siteId));

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    where[Op.or] = [
      { assetId: { [Op.like]: containsPattern(search) } },
      { registrationNumber: { [Op.like]: containsPattern(search) } },
      { modelNumber: { [Op.like]: containsPattern(search) } },
    ];
  }

  if (query.docsMissing === 'true') where[Op.and] = [missingMandatoryDocsCondition()];

  const { rows, count } = await repo.findAndCountAll(tenantId, { where, order, limit, offset });
  const extras = await loadListExtras(tenantId, rows);

  return buildListResponse(
    rows.map((vehicle) => toPublic(vehicle, extras)),
    { page, limit, total: count }
  );
}

async function getVehicle({ tenantId, auth, id }) {
  const vehicle = await repo.findByPk(tenantId, id);
  if (!vehicle) throw AppError.notFound('Vehicle not found');
  assertSiteAllowed(auth, vehicle.currentSiteId, 'Vehicle not found');
  return toPublic(vehicle, await loadListExtras(tenantId, [vehicle]));
}

// Checks one candidate vehicle the way createVehicle does, but reports every problem instead of stopping at the first.
// Returns the input createVehicle would save. Uniqueness and site existence need the database and are checked by the caller.
function validateVehicleCandidate(payload, auth) {
  const errors = [];
  const attempt = (field, read) => {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      errors.push({ field, message: error.message });
      return undefined;
    }
  };

  const baseInput = {};
  const requiredBaseFields = ['registrationNumber', 'type', 'fuelType'];
  for (const field of [...requiredBaseFields, 'modelNumber', 'chassisNumber', 'year']) {
    // The partial reader skips an absent field, so a required one is passed as blank to be reported.
    const value = payload[field] ?? (requiredBaseFields.includes(field) ? '' : undefined);
    const read = attempt(field, () => readVehicleBaseInput({ [field]: value }, { partial: true }));
    if (read) Object.assign(baseInput, read);
  }

  const siteInput = attempt('currentSiteId', () => {
    const input = readCurrentSiteIdInput(payload);
    const ownSiteId = ownSiteFor(auth, input.currentSiteId);
    if (ownSiteId !== null) input.currentSiteId = ownSiteId;
    return input;
  });

  const meterInput = baseInput.type
    ? attempt(isHoursBasedType(baseInput.type) ? 'currentHours' : 'currentKM', () =>
        readMeterInputForCreate(payload, baseInput.type)
      )
    : undefined;

  const compliance = {};
  for (const [docType, key] of Object.entries(DOC_TYPE_PAYLOAD_KEYS)) {
    const raw = payload.compliance?.[key];
    if (!isDocEntered(docType, raw)) continue;
    if (attempt(`compliance.${key}`, () => readComplianceInput(docType, raw))) compliance[key] = raw;
  }

  return { input: { ...baseInput, ...siteInput, ...meterInput }, compliance, errors };
}

// Saves a validated vehicle with its audit entry, site assignment, compliance and documents. Runs inside the caller's transaction.
async function insertVehicle({ tenantId, actingUserId, input, compliance, files, savedKeys, transaction }) {
  let created;

  for (let attempt = 1; attempt <= ASSET_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const assetId = await generateAssetId(tenantId, { transaction });
    try {
      created = await repo.create(
        tenantId,
        { ...input, assetId, createdBy: actingUserId, updatedBy: actingUserId },
        { transaction }
      );
      break;
    } catch (error) {
      const isLastAttempt = attempt === ASSET_ID_GENERATION_ATTEMPTS;
      if (!isAssetIdCollision(error) || isLastAttempt) throw error;
    }
  }

  await recordCreate(
    { tenantId, entityType: 'Vehicle', entityId: created.id, performedBy: actingUserId, after: created },
    { transaction }
  );

  await recordSiteAssignment({
    tenantId,
    assetType: 'VEHICLE',
    assetId: created.assetId,
    previousSiteId: null,
    nextSiteId: created.currentSiteId,
    actingUserId,
    transaction,
  });

  await saveComplianceDocuments({
    tenantId,
    assetType: 'VEHICLE',
    assetId: created.assetId,
    actingUserId,
    compliance,
    transaction,
  });

  if (files) {
    await createDocumentsForNewAsset({
      tenantId,
      assetType: 'VEHICLE',
      assetId: created.assetId,
      actingUserId,
      files,
      savedKeys,
      transaction,
    });
  }

  return created;
}

async function createVehicle({ tenantId, auth, actingUserId, payload, files }) {
  const baseInput = readVehicleBaseInput(payload);
  const siteInput = readCurrentSiteIdInput(payload);
  const ownSiteId = ownSiteFor(auth, siteInput.currentSiteId);
  if (ownSiteId !== null) siteInput.currentSiteId = ownSiteId;
  const meterInput = readMeterInputForCreate(payload, baseInput.type);
  const input = { ...baseInput, ...siteInput, ...meterInput };
  const compliance = parseComplianceField(payload.compliance);

  assertMandatoryDocuments(files);
  await assertRegistrationNumberAvailable({ value: input.registrationNumber });
  await assertChassisNumberAvailable({ value: input.chassisNumber });
  if (input.currentSiteId != null) {
    await assertSiteAssignable(tenantId, input.currentSiteId);
  }

  const savedKeys = [];

  try {
    const vehicle = await sequelize.transaction((transaction) =>
      insertVehicle({ tenantId, actingUserId, input, compliance, files, savedKeys, transaction })
    );

    return toPublic(vehicle);
  } catch (error) {
    await Promise.all(savedKeys.map((key) => storage.deleteFile(key).catch(() => {})));
    throw error;
  }
}

async function updateVehicle({ tenantId, auth, actingUserId, id, payload }) {
  const vehicle = await repo.findByPk(tenantId, id);
  if (!vehicle) throw AppError.notFound('Vehicle not found');
  assertSiteAllowed(auth, vehicle.currentSiteId, 'Vehicle not found');

  const baseInput = readVehicleBaseInput(payload, { partial: true });

  if (baseInput.registrationNumber && baseInput.registrationNumber !== vehicle.registrationNumber) {
    await assertRegistrationNumberAvailable({ value: baseInput.registrationNumber, excludeVehicleId: id });
  }
  if (baseInput.chassisNumber && baseInput.chassisNumber !== vehicle.chassisNumber) {
    await assertChassisNumberAvailable({ value: baseInput.chassisNumber, excludeVehicleId: id });
  }

  const siteInput = readCurrentSiteIdInput(payload, { partial: true });
  assertSiteChangeAllowed(auth, vehicle.currentSiteId, siteInput);
  // Only a new site must be assignable: an asset may stay at a site that was archived after it arrived.
  if (siteInput.currentSiteId != null && siteInput.currentSiteId !== vehicle.currentSiteId) {
    await assertSiteAssignable(tenantId, siteInput.currentSiteId);
  }
  const compliance = parseComplianceField(payload.compliance);

  const updated = await sequelize.transaction(async (transaction) => {
    // Re-read under a row lock so simultaneous saves see each other's site and meter changes.
    const current = await repo.findByPk(tenantId, vehicle.id, { transaction, lock: transaction.LOCK.UPDATE });
    const before = current.toJSON();
    const previousSiteId = current.currentSiteId;
    const nextSiteId = 'currentSiteId' in siteInput ? siteInput.currentSiteId : previousSiteId;
    const meterInput = readMeterInputForUpdate(payload, current, baseInput.type ?? current.type);

    await current.update(
      {
        ...baseInput,
        ...siteInput,
        ...meterInput,
        updatedBy: actingUserId,
      },
      { transaction }
    );

    await recordUpdate(
      { tenantId, entityType: 'Vehicle', entityId: current.id, performedBy: actingUserId, before, after: current },
      { transaction }
    );

    await recordSiteAssignment({
      tenantId,
      assetType: 'VEHICLE',
      assetId: current.assetId,
      previousSiteId,
      nextSiteId,
      actingUserId,
      transaction,
    });

    await saveComplianceDocuments({
      tenantId,
      assetType: 'VEHICLE',
      assetId: current.assetId,
      actingUserId,
      compliance,
      transaction,
    });

    return current;
  });

  return toPublic(updated);
}

async function deleteVehicle({ tenantId, auth, actingUserId, id, confirmation }) {
  const archived = await archiveEntity({
    model: Vehicle,
    entityType: 'Vehicle',
    dependencyCheck: (record) => assertSiteAllowed(auth, record.currentSiteId, 'Vehicle not found'),
    tenantId,
    id,
    confirmation,
    performedBy: actingUserId,
  });

  return toPublic(archived);
}

async function restoreVehicle({ tenantId, auth, actingUserId, id }) {
  const restored = await restoreEntity({
    model: Vehicle,
    entityType: 'Vehicle',
    dependencyCheck: (record) => assertSiteAllowed(auth, record.currentSiteId, 'Vehicle not found'),
    tenantId,
    id,
    performedBy: actingUserId,
  });

  return toPublic(restored);
}

async function getVehicleHistory({ tenantId, auth, id }) {
  const vehicle = await repo.findByPk(tenantId, id);
  if (!vehicle) throw AppError.notFound('Vehicle not found');
  assertSiteAllowed(auth, vehicle.currentSiteId, 'Vehicle not found');

  const entries = await AuditLog.findAll({
    where: { tenantId, entityType: 'Vehicle', entityId: String(id) },
    order: [['createdAt', 'DESC']],
  });

  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    before: entry.before,
    after: entry.after,
    performedBy: entry.performedBy,
    createdAt: entry.createdAt,
  }));
}

async function getVehicleCosts({ tenantId, auth, id }) {
  const vehicle = await repo.findByPk(tenantId, id);
  if (!vehicle) throw AppError.notFound('Vehicle not found');
  assertSiteAllowed(auth, vehicle.currentSiteId, 'Vehicle not found');
  return assetCostSummary({ tenantId, assetType: 'VEHICLE', assetId: vehicle.assetId });
}

module.exports = {
  listVehicles,
  getVehicle,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  restoreVehicle,
  getVehicleHistory,
  getVehicleCosts,
  validateVehicleCandidate,
  insertVehicle,
};
