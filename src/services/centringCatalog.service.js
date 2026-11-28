const { Op, Transaction } = require('sequelize');

const { sequelize, CentringCategory, CentringSubCategory, CentringSupplier, CentringItem, CentringUnit } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, optionalText, requireNumber, optionalPhone } = require('../utils/validation');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { recordArchive, recordCreate, recordRestore, recordUpdate } = require('./audit.service');
const { siteNamesById } = require('./fuelCommon');
const { stockRows } = require('./centringStock');

// The catalog, set up once and in order: categories, sub categories under a category, items under a sub category,
// units of measure for the items, and suppliers. Each list can be searched and shows active or archived records.

const categoryInclude = [{ model: CentringCategory, as: 'category', attributes: ['id', 'categoryName', 'status'] }];
const itemInclude = [
  { model: CentringCategory, as: 'category', attributes: ['id', 'categoryName', 'status'] },
  { model: CentringSubCategory, as: 'subCategory', attributes: ['id', 'subCategoryName', 'status'] },
];

function readId(value, label) {
  const id = requireNumber(value, label, { min: 1 });
  if (!Number.isInteger(id)) throw AppError.badRequest(`Choose the ${label.toLowerCase()}`);
  return id;
}

function optionalIdFilter(value, label) {
  if (value === undefined || value === '') return undefined;
  return readId(value, label);
}

async function findActive(Model, tenantId, id, label, transaction) {
  const record = await Model.findOne({ where: { tenantId, id }, transaction });
  if (!record) throw AppError.badRequest(`${label} not found`);
  if (record.status !== 'active') throw AppError.badRequest(`This ${label.toLowerCase()} is archived. Restore it first.`);
  return record;
}

// A generic list/create/update/archive/restore for one master table.
function master({ Model, entityType, label, nameField, searchFields, include, sort, readInput, filters, checkArchive, checkRestore, afterUpdate, duplicateMessage }) {
  async function find(tenantId, id, transaction, lock) {
    const record = await Model.findOne({ where: { tenantId, id }, include, transaction, ...(lock ? { lock: Transaction.LOCK.UPDATE } : {}) });
    if (!record) throw AppError.notFound(`${label} not found`);
    return record;
  }

  async function save(work) {
    try {
      return await sequelize.transaction(work);
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') throw AppError.conflict(duplicateMessage);
      throw error;
    }
  }

  async function reload(tenantId, id) {
    return (await find(tenantId, id)).toPublicJSON();
  }

  return {
    async list({ tenantId, query }) {
      const { page, limit, offset } = parseListQuery(query, { sortableFields: [nameField], defaultSort: `${nameField}:asc` });
      const where = { tenantId, status: parseEnumFilter(query.status, Model.STATUSES, 'Status') ?? 'active', ...(filters ? filters(query) : {}) };
      const search = typeof query.search === 'string' ? query.search.trim() : '';
      if (search) where[Op.or] = searchFields.map((field) => ({ [field]: { [Op.like]: containsPattern(search) } }));
      const { rows, count } = await Model.findAndCountAll({ where, include, order: [...sort, ['id', 'ASC']], limit, offset, distinct: true });
      return buildListResponse(rows.map((r) => r.toPublicJSON()), { page, limit, total: count });
    },

    async create({ tenantId, actingUserId, payload }) {
      const id = await save(async (transaction) => {
        const input = await readInput(tenantId, payload, transaction);
        const created = await Model.create({ ...input, tenantId, createdBy: actingUserId, updatedBy: actingUserId }, { transaction });
        await recordCreate({ tenantId, entityType, entityId: created.id, performedBy: actingUserId, after: created }, { transaction });
        return created.id;
      });
      return reload(tenantId, id);
    },

    async update({ tenantId, actingUserId, id, payload }) {
      await save(async (transaction) => {
        const record = await find(tenantId, id, transaction, true);
        const input = await readInput(tenantId, payload, transaction, record);
        const before = record.toJSON();
        await record.update({ ...input, updatedBy: actingUserId }, { transaction });
        if (afterUpdate) await afterUpdate(tenantId, before, record, transaction);
        await recordUpdate({ tenantId, entityType, entityId: record.id, performedBy: actingUserId, before, after: record }, { transaction });
      });
      return reload(tenantId, id);
    },

    async archive({ tenantId, actingUserId, id }) {
      await sequelize.transaction(async (transaction) => {
        const record = await find(tenantId, id, transaction, true);
        if (record.status === 'archived') throw AppError.conflict(`This ${label.toLowerCase()} is already archived`);
        if (checkArchive) await checkArchive(tenantId, record, transaction);
        await record.update({ status: 'archived', archivedAt: new Date(), archivedBy: actingUserId, updatedBy: actingUserId }, { transaction });
        await recordArchive({ tenantId, entityType, entityId: record.id, performedBy: actingUserId }, { transaction });
      });
      return reload(tenantId, id);
    },

    async restore({ tenantId, actingUserId, id }) {
      await save(async (transaction) => {
        const record = await find(tenantId, id, transaction, true);
        if (record.status === 'active') throw AppError.conflict(`This ${label.toLowerCase()} is already active`);
        if (checkRestore) await checkRestore(tenantId, record, transaction);
        await record.update({ status: 'active', archivedAt: null, archivedBy: null, updatedBy: actingUserId }, { transaction });
        await recordRestore({ tenantId, entityType, entityId: record.id, performedBy: actingUserId }, { transaction });
      });
      return reload(tenantId, id);
    },
  };
}

async function countActive(Model, where, transaction) {
  return Model.count({ where: { ...where, status: 'active' }, transaction });
}

const categories = master({
  Model: CentringCategory,
  entityType: 'CentringCategory',
  label: 'Category',
  nameField: 'categoryName',
  searchFields: ['categoryName'],
  sort: [['categoryName', 'ASC']],
  duplicateMessage: 'A category with this name already exists.',
  readInput: async (_tenantId, payload) => ({ categoryName: requireText(payload.categoryName, 'Category name', { max: 100 }) }),
  checkArchive: async (tenantId, record, transaction) => {
    const subs = await countActive(CentringSubCategory, { tenantId, categoryId: record.id }, transaction);
    if (subs > 0) throw AppError.conflict(`${record.categoryName} still has ${subs} active sub ${subs === 1 ? 'category' : 'categories'}. Archive them first.`);
  },
});

const subCategories = master({
  Model: CentringSubCategory,
  entityType: 'CentringSubCategory',
  label: 'Sub category',
  nameField: 'subCategoryName',
  searchFields: ['subCategoryName'],
  include: categoryInclude,
  sort: [[{ model: CentringCategory, as: 'category' }, 'categoryName', 'ASC'], ['subCategoryName', 'ASC']],
  duplicateMessage: 'This category already has a sub category with this name.',
  filters: (query) => {
    const categoryId = optionalIdFilter(query.categoryId, 'Category');
    return categoryId ? { categoryId } : {};
  },
  readInput: async (tenantId, payload, transaction, existing) => {
    const categoryId = readId(payload.categoryId, 'Category');
    if (!existing || existing.categoryId !== categoryId) await findActive(CentringCategory, tenantId, categoryId, 'Category', transaction);
    if (existing && existing.categoryId !== categoryId) {
      const items = await CentringItem.count({ where: { tenantId, subCategoryId: existing.id }, transaction });
      if (items > 0) throw AppError.conflict('Items already use this sub category, so it cannot be moved to another category.');
    }
    return { categoryId, subCategoryName: requireText(payload.subCategoryName, 'Sub category name', { max: 100 }) };
  },
  checkArchive: async (tenantId, record, transaction) => {
    const items = await countActive(CentringItem, { tenantId, subCategoryId: record.id }, transaction);
    if (items > 0) throw AppError.conflict(`${record.subCategoryName} still has ${items} active ${items === 1 ? 'item' : 'items'}. Archive them first.`);
  },
  checkRestore: async (tenantId, record, transaction) => {
    await findActive(CentringCategory, tenantId, record.categoryId, 'Category', transaction);
  },
});

// Units of measure. An item stores its unit's name, so renaming a unit renames it on every item that uses it.
const units = master({
  Model: CentringUnit,
  entityType: 'CentringUnit',
  label: 'Unit',
  nameField: 'unitName',
  searchFields: ['unitName'],
  sort: [['unitName', 'ASC']],
  duplicateMessage: 'A unit with this name already exists.',
  readInput: async (_tenantId, payload) => ({ unitName: requireText(payload.unitName, 'Unit name', { max: 20 }) }),
  afterUpdate: async (tenantId, before, record, transaction) => {
    if (before.unitName === record.unitName) return;
    await CentringItem.update({ unit: record.unitName }, { where: { tenantId, unit: before.unitName }, transaction });
  },
  checkArchive: async (tenantId, record, transaction) => {
    const used = await countActive(CentringItem, { tenantId, unit: record.unitName }, transaction);
    if (used > 0) throw AppError.conflict(`${used} active ${used === 1 ? 'item uses' : 'items use'} ${record.unitName}. Change their unit or archive them first.`);
  },
});

// The unit an item is measured in: one from the Units of Measure list. An item may keep the archived unit it already has.
async function readUnit(tenantId, value, transaction, existing) {
  const name = requireText(value, 'Unit', { max: 20 });
  const unit = await CentringUnit.findOne({ where: { tenantId, unitName: name }, transaction });
  if (!unit) throw AppError.badRequest('Choose a unit from Units of Measure.');
  if (unit.status !== 'active' && existing?.unit !== unit.unitName) throw AppError.badRequest(`The unit ${unit.unitName} is archived. Restore it first.`);
  return unit.unitName;
}

const suppliers = master({
  Model: CentringSupplier,
  entityType: 'CentringSupplier',
  label: 'Supplier',
  nameField: 'supplierName',
  searchFields: ['supplierName', 'contactPerson', 'phone', 'gstNumber'],
  sort: [['supplierName', 'ASC']],
  duplicateMessage: 'A supplier with this name already exists.',
  readInput: async (_tenantId, payload) => ({
    supplierName: requireText(payload.supplierName, 'Supplier name', { max: 150 }),
    contactPerson: optionalText(payload.contactPerson, 'Contact person', { max: 100 }),
    phone: optionalPhone(payload.phone),
    gstNumber: optionalText(payload.gstNumber, 'GST number', { max: 20 }),
    address: optionalText(payload.address, 'Address', { max: 500 }),
  }),
});

const items = master({
  Model: CentringItem,
  entityType: 'CentringItem',
  label: 'Item',
  nameField: 'itemName',
  searchFields: ['itemName'],
  include: itemInclude,
  sort: [
    [{ model: CentringCategory, as: 'category' }, 'categoryName', 'ASC'],
    [{ model: CentringSubCategory, as: 'subCategory' }, 'subCategoryName', 'ASC'],
    ['itemName', 'ASC'],
  ],
  duplicateMessage: 'An item with this name already exists.',
  filters: (query) => {
    const categoryId = optionalIdFilter(query.categoryId, 'Category');
    const subCategoryId = optionalIdFilter(query.subCategoryId, 'Sub category');
    return { ...(categoryId ? { categoryId } : {}), ...(subCategoryId ? { subCategoryId } : {}) };
  },
  // The category always follows from the sub category, so the two can never disagree.
  readInput: async (tenantId, payload, transaction, existing) => {
    const subCategoryId = readId(payload.subCategoryId, 'Sub category');
    const sub = existing && existing.subCategoryId === subCategoryId
      ? await CentringSubCategory.findOne({ where: { tenantId, id: subCategoryId }, transaction })
      : await findActive(CentringSubCategory, tenantId, subCategoryId, 'Sub category', transaction);
    const unit = await readUnit(tenantId, payload.unit, transaction, existing);
    return { categoryId: sub.categoryId, subCategoryId, itemName: requireText(payload.itemName, 'Item name', { max: 150 }), unit };
  },
  checkArchive: async (tenantId, record, transaction) => {
    const held = (await stockRows(tenantId, { itemIds: [record.id] }, transaction)).filter((r) => r.quantity !== 0);
    if (held.length > 0) {
      const names = await siteNamesById(tenantId, held.map((r) => r.siteId));
      const where = held.map((r) => `${names.get(r.siteId) ?? 'a site'} (${r.quantity} ${record.unit})`).join(', ');
      throw AppError.conflict(`${record.itemName} is still held at ${where}. Adjust or transfer that stock before archiving it.`);
    }
  },
  checkRestore: async (tenantId, record, transaction) => {
    await findActive(CentringSubCategory, tenantId, record.subCategoryId, 'Sub category', transaction);
    const unit = await CentringUnit.findOne({ where: { tenantId, unitName: record.unit }, transaction });
    if (unit && unit.status !== 'active') throw AppError.badRequest(`The unit ${unit.unitName} is archived. Restore it first.`);
  },
});

module.exports = { categories, subCategories, units, suppliers, items };
