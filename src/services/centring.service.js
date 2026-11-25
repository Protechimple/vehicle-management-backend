const { Op, Transaction, QueryTypes } = require('sequelize');

const { sequelize, CentringCategory, CentringSubCategory, CentringSupplier, CentringItem, CentringEntry, CentringEntryLine, Site, User } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, optionalText, requireNumber, optionalNumber } = require('../utils/validation');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { recordArchive, recordCreate } = require('./audit.service');
const { nextSequentialCode } = require('./codeGenerator');
const { roundQuantity, roundMoney, roundUnitCost, requireBusinessDate, optionalDateFilter, siteNamesById } = require('./fuelCommon');
const { ownSiteFor, allowedSiteIds } = require('./siteAccess');
const { can } = require('../config/permissions');
const { canSeeSite, readSite, siteFilter, stockRows, stockAt, itemValues, averageRate, shareOfValue, valueOut } = require('./centringStock');

// Centring Inventory, site by site, like the Inventory module:
//   purchase   — bought from a supplier into a site
//   issue      — taken out of a site's stock for a purpose
//   transfer   — moved from one site to another
//   adjustment — lost, damaged, scrapped, or a stock count, at a site

const MAX_LINES = 200;
const MAX_QUANTITY = 10000000;
const MAX_PRICE = 10000000;

const ACTION_FOR = { purchase: 'PURCHASE', issue: 'ISSUE', transfer: 'TRANSFER', adjustment: 'ADJUST' };
const TYPE_LABEL = { purchase: 'Purchase', issue: 'Issue', transfer: 'Transfer', adjustment: 'Adjustment' };

const seesCost = (auth) => can(auth, 'CENTRING', 'VIEW_COST');

function formatQuantity(value, unit) {
  return `${Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`;
}

function readId(value, label) {
  const id = requireNumber(value, label, { min: 1 });
  if (!Number.isInteger(id)) throw AppError.badRequest(`Choose the ${label.toLowerCase()}`);
  return id;
}

function siteName(names, id) {
  return names.get(Number(id)) ?? 'Unknown site';
}

// ---------------------------------------------------------------------------------------------------------------------
// The sites a user picks from: their own, or every active site for the Admin. A transfer may go to any active site.

async function getSites({ tenantId, auth }) {
  const own = allowedSiteIds(auth);
  const sites = await Site.findAll({ where: { tenantId, status: 'active' }, attributes: ['id', 'name'], order: [['name', 'ASC']] });
  const all = sites.map((s) => ({ id: s.id, name: s.name }));
  return { own: own ? all.filter((s) => own.map(Number).includes(s.id)) : all, all: can(auth, 'CENTRING', 'TRANSFER') ? all : [] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Stock: item by item, how much is at each site, and (for those who see costs) its value.

const itemInclude = [
  { model: CentringCategory, as: 'category', attributes: ['id', 'categoryName'] },
  { model: CentringSubCategory, as: 'subCategory', attributes: ['id', 'subCategoryName'] },
];

async function getStock({ tenantId, auth, query }) {
  const siteIds = siteFilter(auth, query.siteId);
  const withCost = seesCost(auth);
  const rows = (await stockRows(tenantId, { siteIds })).filter((r) => r.quantity !== 0);
  if (rows.length === 0) return { items: [], ...(withCost ? { totalValue: 0 } : {}) };

  const itemWhere = { tenantId, id: [...new Set(rows.map((r) => r.itemId))] };
  if (query.categoryId) itemWhere.categoryId = readId(query.categoryId, 'Category');
  if (query.subCategoryId) itemWhere.subCategoryId = readId(query.subCategoryId, 'Sub category');
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) itemWhere.itemName = { [Op.like]: containsPattern(search) };

  const [items, names, values] = await Promise.all([
    CentringItem.findAll({ where: itemWhere, include: itemInclude, order: [['itemName', 'ASC']] }),
    siteNamesById(tenantId, rows.map((r) => r.siteId)),
    withCost ? itemValues(tenantId, itemWhere.id) : null,
  ]);

  const byItem = new Map();
  for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);

  const result = items
    .map((item) => {
      const sites = (byItem.get(item.id) ?? [])
        .map((r) => ({ siteId: r.siteId, siteName: siteName(names, r.siteId), quantity: r.quantity, ...(withCost ? { value: shareOfValue(r.quantity, values.get(item.id)) } : {}) }))
        .sort((a, b) => a.siteName.localeCompare(b.siteName));
      const quantity = roundQuantity(sites.reduce((sum, s) => sum + s.quantity, 0));
      const base = { ...item.toPublicJSON(), quantity, sites };
      if (!withCost) return base;
      return { ...base, averageRate: averageRate(values.get(item.id)), value: shareOfValue(quantity, values.get(item.id)) };
    })
    .sort(
      (a, b) =>
        String(a.categoryName).localeCompare(String(b.categoryName)) ||
        String(a.subCategoryName).localeCompare(String(b.subCategoryName)) ||
        a.itemName.localeCompare(b.itemName)
    );

  return withCost ? { items: result, totalValue: roundMoney(result.reduce((sum, i) => sum + i.value, 0)) } : { items: result };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading an entry

function readLines(value, { label = 'quantity', priced = false, counted = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) throw AppError.badRequest('Add at least one item');
  if (value.length > MAX_LINES) throw AppError.badRequest(`An entry can list at most ${MAX_LINES} items`);
  const lines = value.map((line, index) => {
    const name = `Item ${index + 1}`;
    const itemId = readId(line?.itemId, `${name}: item`);
    const quantity = roundQuantity(requireNumber(counted ? line?.countedQuantity : line?.quantity, `${name}: ${label}`, { min: 0 }));
    if (!counted && quantity <= 0) throw AppError.badRequest(`${name}: ${label} must be greater than 0`);
    if (quantity > MAX_QUANTITY) throw AppError.badRequest(`${name}: ${label} cannot be more than ${MAX_QUANTITY.toLocaleString('en-IN')}`);
    if (!priced) return { itemId, quantity };
    const unitPrice = roundUnitCost(requireNumber(line?.unitPrice, `${name}: unit price`, { min: 0 }));
    if (unitPrice > MAX_PRICE) throw AppError.badRequest(`${name}: unit price is too large`);
    const taxPercent = optionalNumber(line?.taxPercent, `${name}: tax %`, { min: 0, max: 100 }) ?? 0;
    return { itemId, quantity, unitPrice, taxPercent: roundMoney(taxPercent) };
  });
  if (new Set(lines.map((l) => l.itemId)).size !== lines.length) throw AppError.badRequest('The same item is listed twice. Put its full quantity on one line.');
  return lines;
}

// The site an entry happens at. A user with one site always gets it; others must name one of theirs.
function readOwnSite(auth, value, label = 'Site') {
  return ownSiteFor(auth, value) ?? readSite(value, label);
}

// Turns a request into the entry to save: where it happens and what it moves.
async function readEntry(tenantId, auth, payload) {
  const entryType = parseEnumFilter(payload.entryType, CentringEntry.TYPES, 'Entry type');
  if (!entryType) throw AppError.badRequest('Entry type is required');
  if (!can(auth, 'CENTRING', ACTION_FOR[entryType])) throw AppError.forbidden(`You are not allowed to record a centring ${TYPE_LABEL[entryType].toLowerCase()}`);
  const common = { entryType, entryDate: requireBusinessDate(payload.entryDate, 'Date'), remarks: optionalText(payload.remarks, 'Remarks', { max: 1000 }) };

  if (entryType === 'purchase') {
    const supplierId = readId(payload.supplierId, 'Supplier');
    const supplier = await CentringSupplier.findOne({ where: { tenantId, id: supplierId } });
    if (!supplier) throw AppError.badRequest('Supplier not found');
    if (supplier.status !== 'active') throw AppError.badRequest('This supplier is archived. Restore it first.');
    return {
      ...common,
      from: null,
      to: readOwnSite(auth, payload.siteId),
      supplierId,
      billNumber: optionalText(payload.billNumber, 'Bill no.', { max: 60 }),
      lines: readLines(payload.lines, { priced: true }),
    };
  }

  if (entryType === 'issue') {
    return {
      ...common,
      from: null,
      to: readOwnSite(auth, payload.siteId),
      purpose: requireText(payload.purpose, 'Purpose', { max: 255 }),
      issuedTo: optionalText(payload.issuedTo, 'Issued to', { max: 150 }),
      lines: readLines(payload.lines),
    };
  }

  if (entryType === 'transfer') {
    const from = readSite(payload.fromSiteId, 'From site');
    if (!canSeeSite(auth, from)) throw AppError.forbidden('You can only transfer from your own sites');
    const to = readSite(payload.toSiteId, 'To site');
    if (to === from) throw AppError.badRequest('Choose a different site to transfer to');
    return { ...common, from, to, lines: readLines(payload.lines) };
  }

  const reason = requireText(payload.reason, 'Reason', { max: 40 });
  if (!CentringEntry.ADJUSTMENT_REASONS.includes(reason)) throw AppError.badRequest(`Reason must be one of: ${CentringEntry.ADJUSTMENT_REASONS.join(', ')}`);
  const counted = reason === 'Stock count';
  return {
    ...common,
    from: null,
    to: readOwnSite(auth, payload.siteId),
    reason,
    counted,
    lines: readLines(payload.lines, { counted, label: counted ? 'counted quantity' : 'quantity' }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Saving an entry

// Items are locked in id order: every stock change of an item, at any site, takes its turn.
async function lockItems(tenantId, itemIds, transaction) {
  const ids = [...new Set(itemIds)].sort((a, b) => a - b);
  const items = await CentringItem.findAll({ where: { tenantId, id: ids }, order: [['id', 'ASC']], transaction, lock: Transaction.LOCK.UPDATE });
  return new Map(items.map((i) => [i.id, i]));
}

async function assertSitesActive(tenantId, siteIds, transaction) {
  const ids = siteIds.filter((id) => id !== null);
  const sites = await Site.findAll({ where: { tenantId, id: ids }, transaction });
  for (const id of ids) {
    const site = sites.find((s) => s.id === id);
    if (!site) throw AppError.badRequest('Site not found');
    if (site.status !== 'active') throw AppError.badRequest(`${site.name} is archived, so centring cannot be recorded at it`);
  }
  return new Map(sites.map((s) => [s.id, s.name]));
}

function assertEnough(lines, available, itemsById, place) {
  for (const line of lines) {
    const item = itemsById.get(line.itemId);
    const have = available.get(line.itemId) ?? 0;
    if (line.quantity > have) {
      throw AppError.conflict(have > 0 ? `Only ${formatQuantity(have, item.unit)} of ${item.itemName} is at ${place}.` : `There is no ${item.itemName} at ${place}.`);
    }
  }
}

// The lines as saved, with their direction and value.
async function valueLines(tenantId, entry, itemsById, siteNames, transaction) {
  if (entry.entryType === 'purchase') {
    return entry.lines.map((l) => ({ ...l, direction: 'in', amount: roundMoney(l.quantity * l.unitPrice * (1 + l.taxPercent / 100)) }));
  }

  const values = await itemValues(tenantId, entry.lines.map((l) => l.itemId), transaction);
  const source = entry.from ?? entry.to;
  const available = await stockAt(tenantId, source, entry.lines.map((l) => l.itemId), transaction);

  // A count sets the stock to what was counted: the difference is added or taken away.
  if (entry.counted) {
    const lines = entry.lines
      .map((l) => {
        const difference = roundQuantity(l.quantity - (available.get(l.itemId) ?? 0));
        return { itemId: l.itemId, direction: difference < 0 ? 'out' : 'in', quantity: Math.abs(difference) };
      })
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) throw AppError.badRequest('The counted quantities match the stock, so there is nothing to adjust.');
    return lines.map((l) => {
      const totals = values.get(l.itemId);
      const amount = l.direction === 'out' ? valueOut(l.quantity, totals) : roundMoney(l.quantity * averageRate(totals));
      return { ...l, unitPrice: roundUnitCost(amount / l.quantity), taxPercent: 0, amount };
    });
  }

  assertEnough(entry.lines, available, itemsById, siteNames.get(source) ?? 'this site');
  // A transfer's lines arrive at the receiving site (and are taken from the site it left); issues and other
  // adjustments take stock away.
  const direction = entry.entryType === 'transfer' ? 'in' : 'out';
  return entry.lines.map((l) => {
    const totals = values.get(l.itemId);
    const amount = direction === 'out' ? valueOut(l.quantity, totals) : shareOfValue(l.quantity, totals);
    return { ...l, direction, unitPrice: roundUnitCost(amount / l.quantity), taxPercent: 0, amount };
  });
}

async function createEntry({ tenantId, auth, actingUserId, payload }) {
  const entry = await readEntry(tenantId, auth, payload);

  const id = await sequelize.transaction(async (transaction) => {
    const siteNames = await assertSitesActive(tenantId, [entry.from, entry.to], transaction);
    const itemsById = await lockItems(tenantId, entry.lines.map((l) => l.itemId), transaction);
    for (const line of entry.lines) {
      const item = itemsById.get(line.itemId);
      if (!item) throw AppError.badRequest('One of the items was not found. Reload and try again.');
      if (item.status !== 'active') throw AppError.badRequest(`${item.itemName} is archived. Restore it first.`);
    }
    const lines = await valueLines(tenantId, entry, itemsById, siteNames, transaction);

    const entryNumber = await nextSequentialCode(CentringEntry, 'entryNumber', CentringEntry.PREFIXES[entry.entryType], { tenantId, transaction });
    const saved = await CentringEntry.create(
      {
        tenantId,
        entryNumber,
        entryType: entry.entryType,
        entryDate: entry.entryDate,
        fromSiteId: entry.from,
        toSiteId: entry.to,
        supplierId: entry.supplierId ?? null,
        billNumber: entry.billNumber ?? null,
        reason: entry.reason ?? null,
        purpose: entry.purpose ?? null,
        issuedTo: entry.issuedTo ?? null,
        remarks: entry.remarks,
        totalAmount: roundMoney(lines.reduce((sum, l) => sum + l.amount, 0)),
        createdBy: actingUserId,
      },
      { transaction }
    );
    await CentringEntryLine.bulkCreate(
      lines.map((l) => ({ tenantId, entryId: saved.id, itemId: l.itemId, direction: l.direction, quantity: l.quantity, unitPrice: l.unitPrice, taxPercent: l.taxPercent, amount: l.amount })),
      { transaction }
    );
    await recordCreate({ tenantId, entityType: 'CentringEntry', entityId: saved.id, performedBy: actingUserId, after: { ...saved.toPublicJSON(), lines } }, { transaction });
    return saved.id;
  });

  return getEntry({ tenantId, auth, id });
}

// ---------------------------------------------------------------------------------------------------------------------
// Listing and showing entries

function canSeeEntry(auth, entry) {
  return canSeeSite(auth, entry.toSiteId) || (entry.fromSiteId !== null && canSeeSite(auth, entry.fromSiteId));
}

async function decorate(tenantId, auth, entries) {
  if (entries.length === 0) return [];
  const withCost = seesCost(auth);
  const [names, users, suppliers, lines] = await Promise.all([
    siteNamesById(tenantId, entries.flatMap((e) => [e.fromSiteId, e.toSiteId])),
    User.findAll({ where: { tenantId, id: [...new Set(entries.map((e) => e.createdBy))] }, attributes: ['id', 'name'] }),
    CentringSupplier.findAll({ where: { tenantId, id: [...new Set(entries.map((e) => e.supplierId).filter(Boolean))] }, attributes: ['id', 'supplierName'] }),
    CentringEntryLine.findAll({
      where: { tenantId, entryId: entries.map((e) => e.id) },
      include: [{ model: CentringItem, as: 'item', attributes: ['id', 'itemName', 'unit'], include: itemInclude }],
      order: [['id', 'ASC']],
    }),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const supplierNames = new Map(suppliers.map((s) => [s.id, s.supplierName]));
  const linesByEntry = new Map();
  for (const l of lines) {
    linesByEntry.set(l.entryId, [
      ...(linesByEntry.get(l.entryId) ?? []),
      {
        itemId: l.itemId,
        itemName: l.item?.itemName ?? null,
        unit: l.item?.unit ?? null,
        categoryName: l.item?.category?.categoryName ?? null,
        subCategoryName: l.item?.subCategory?.subCategoryName ?? null,
        direction: l.direction,
        quantity: Number(l.quantity),
        ...(withCost ? { unitPrice: Number(l.unitPrice), taxPercent: Number(l.taxPercent), amount: Number(l.amount) } : {}),
      },
    ]);
  }

  return entries.map((e) => {
    const json = e.toPublicJSON();
    if (!withCost) delete json.totalAmount;
    return {
      ...json,
      typeLabel: TYPE_LABEL[e.entryType],
      siteName: siteName(names, e.toSiteId),
      fromSiteName: e.fromSiteId ? siteName(names, e.fromSiteId) : null,
      supplierName: e.supplierId ? (supplierNames.get(e.supplierId) ?? null) : null,
      createdByName: userNames.get(e.createdBy) ?? null,
      lines: linesByEntry.get(e.id) ?? [],
    };
  });
}

async function listEntries({ tenantId, auth, query }) {
  const { page, limit, offset } = parseListQuery(query, { sortableFields: ['entryDate'], defaultSort: 'entryDate:desc' });
  const and = [{ tenantId, status: 'active' }];
  const siteIds = siteFilter(auth, query.siteId);
  if (siteIds) and.push({ [Op.or]: [{ toSiteId: { [Op.in]: siteIds } }, { fromSiteId: { [Op.in]: siteIds } }] });
  const entryType = parseEnumFilter(query.entryType, CentringEntry.TYPES, 'Type');
  if (entryType) and.push({ entryType });
  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (dateFrom) and.push({ entryDate: { [Op.gte]: dateFrom } });
  if (dateTo) and.push({ entryDate: { [Op.lte]: dateTo } });
  if (query.itemId) {
    const itemId = readId(query.itemId, 'Item');
    and.push({ id: { [Op.in]: sequelize.literal(`(SELECT entry_id FROM centring_entry_lines WHERE tenant_id = ${sequelize.escape(tenantId)} AND item_id = ${itemId})`) } });
  }
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = { [Op.like]: containsPattern(search) };
    and.push({ [Op.or]: [{ entryNumber: pattern }, { billNumber: pattern }, { purpose: pattern }] });
  }

  const { rows, count } = await CentringEntry.findAndCountAll({ where: { [Op.and]: and }, order: [['entryDate', 'DESC'], ['id', 'DESC']], limit, offset });
  return buildListResponse(await decorate(tenantId, auth, rows), { page, limit, total: count });
}

async function getEntry({ tenantId, auth, id }) {
  const entry = await CentringEntry.findOne({ where: { tenantId, id } });
  if (!entry || entry.status !== 'active' || !canSeeEntry(auth, entry)) throw AppError.notFound('Centring entry not found');
  const [json] = await decorate(tenantId, auth, [entry]);
  return json;
}

// ---------------------------------------------------------------------------------------------------------------------
// Deleting an entry undoes it. That is refused when the stock it brought to a site has since been used, or when later
// issues or losses were valued using a purchase's price.

async function deleteEntry({ tenantId, auth, actingUserId, id, confirmation }) {
  if (confirmation !== 'DELETE') throw AppError.badRequest('Type DELETE to confirm this action.');
  const found = await CentringEntry.findOne({ where: { tenantId, id } });
  if (!found || !canSeeEntry(auth, found)) throw AppError.notFound('Centring entry not found');

  await sequelize.transaction(async (transaction) => {
    const lines = await CentringEntryLine.findAll({ where: { tenantId, entryId: found.id }, transaction });
    const itemsById = await lockItems(tenantId, lines.map((l) => l.itemId), transaction);
    const entry = await CentringEntry.findOne({ where: { tenantId, id }, transaction, lock: Transaction.LOCK.UPDATE });
    if (entry.status !== 'active') throw AppError.conflict('This entry is already deleted');

    const added = lines.filter((l) => l.direction === 'in');
    if (added.length) {
      const available = await stockAt(tenantId, entry.toSiteId, added.map((l) => l.itemId), transaction);
      const place = siteName(await siteNamesById(tenantId, [entry.toSiteId]), entry.toSiteId);
      for (const line of added) {
        const item = itemsById.get(line.itemId);
        const have = available.get(line.itemId) ?? 0;
        if (Number(line.quantity) > have) {
          throw AppError.conflict(
            `${entry.entryNumber} can't be deleted: it brought ${formatQuantity(line.quantity, item.unit)} of ${item.itemName} to ${place}, but only ${formatQuantity(have, item.unit)} is there now. Delete the later entries that used it first.`
          );
        }
      }
    }

    if (entry.entryType === 'purchase') {
      const later = await CentringEntryLine.findOne({
        where: { tenantId, itemId: lines.map((l) => l.itemId), direction: 'out', entryId: { [Op.gt]: entry.id } },
        include: [{ model: CentringEntry, as: 'entry', where: { status: 'active', entryType: { [Op.in]: ['issue', 'adjustment'] } }, attributes: ['entryNumber'] }],
        transaction,
      });
      if (later) {
        throw AppError.conflict(
          `${entry.entryNumber} can't be deleted: ${later.entry.entryNumber}, a later entry for ${itemsById.get(later.itemId).itemName}, was valued using its price. Delete ${later.entry.entryNumber} first.`
        );
      }
    }

    await entry.update({ status: 'archived', archivedAt: new Date(), archivedBy: actingUserId }, { transaction });
    await recordArchive({ tenantId, entityType: 'CentringEntry', entityId: entry.id, performedBy: actingUserId }, { transaction });
  });

  return { id: Number(id) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reports: for each site what was bought, issued, moved and lost in a period, with the value it holds now; and
// purchases by supplier.

async function getReports({ tenantId, auth, query }) {
  const siteIds = siteFilter(auth, query.siteId);
  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  const period = [dateFrom ? ' AND e.entry_date >= :dateFrom' : '', dateTo ? ' AND e.entry_date <= :dateTo' : ''].join('');
  const sites = (column) => (siteIds ? ` AND ${column} IN (:siteIds)` : '');
  const replacements = { tenantId, dateFrom, dateTo, siteIds };
  const run = (sql) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

  const [moves, purchases, stock, values] = await Promise.all([
    run(`SELECT x.site_id AS siteId, x.kind, SUM(x.amount) AS amount
           FROM (
             SELECT e.to_site_id AS site_id,
                    CASE WHEN e.entry_type = 'purchase' THEN 'purchased'
                         WHEN e.entry_type = 'issue' THEN 'issued'
                         WHEN e.entry_type = 'transfer' THEN 'transferIn'
                         WHEN l.direction = 'out' THEN 'loss' ELSE 'found' END AS kind,
                    l.amount
               FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
              WHERE e.tenant_id = :tenantId AND e.status = 'active'${period}
             UNION ALL
             SELECT e.from_site_id, 'transferOut', l.amount
               FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
              WHERE e.tenant_id = :tenantId AND e.status = 'active' AND e.entry_type = 'transfer'${period}
           ) x
          WHERE 1 = 1${sites('x.site_id')}
          GROUP BY x.site_id, x.kind`),
    run(`SELECT e.supplier_id AS supplierId, COUNT(*) AS bills, SUM(e.total_amount) AS amount
           FROM centring_entries e
          WHERE e.tenant_id = :tenantId AND e.status = 'active' AND e.entry_type = 'purchase'${period}${sites('e.to_site_id')}
          GROUP BY e.supplier_id`),
    stockRows(tenantId, { siteIds }),
    itemValues(tenantId),
  ]);

  const rows = new Map();
  const row = (id) => {
    const key = Number(id);
    if (!rows.has(key)) rows.set(key, { siteId: key, purchased: 0, issued: 0, transferIn: 0, transferOut: 0, loss: 0, found: 0, stockValue: 0 });
    return rows.get(key);
  };
  for (const m of moves) row(m.siteId)[m.kind] += Number(m.amount);
  for (const s of stock) if (s.quantity !== 0) row(s.siteId).stockValue += shareOfValue(s.quantity, values.get(s.itemId));

  const names = await siteNamesById(tenantId, [...rows.keys()]);
  const siteRows = [...rows.values()]
    .map((r) => {
      const done = { ...r, netLoss: r.loss - r.found };
      for (const key of Object.keys(done)) if (key !== 'siteId') done[key] = roundMoney(done[key]);
      return { ...done, siteName: siteName(names, r.siteId) };
    })
    .sort((a, b) => a.siteName.localeCompare(b.siteName));

  const supplierNames = new Map(
    (await CentringSupplier.findAll({ where: { tenantId, id: purchases.map((p) => p.supplierId) }, attributes: ['id', 'supplierName'] })).map((s) => [s.id, s.supplierName])
  );

  const totals = { purchased: 0, issued: 0, transferIn: 0, transferOut: 0, netLoss: 0, stockValue: 0 };
  for (const r of siteRows) for (const key of Object.keys(totals)) totals[key] = roundMoney(totals[key] + r[key]);

  return {
    sites: siteRows,
    suppliers: purchases
      .map((p) => ({ supplierId: p.supplierId, supplierName: supplierNames.get(p.supplierId) ?? '—', bills: Number(p.bills), amount: roundMoney(Number(p.amount)) }))
      .sort((a, b) => b.amount - a.amount),
    totals,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Transaction history: every item an entry moved, one row per item per site, newest first — like Inventory's ledger.
// A transfer is two rows: out of the site it left, into the site it reached.

const LEDGER_COLUMNS = `l.id AS lineId, e.entry_number AS entryNumber, e.entry_type AS entryType, e.entry_date AS entryDate,
       e.created_at AS createdAt, l.item_id AS itemId, l.amount AS amount, e.supplier_id AS supplierId,
       e.bill_number AS billNumber, e.purpose AS purpose, e.issued_to AS issuedTo, e.reason AS reason, e.created_by AS createdBy`;

const LEDGER_SQL = `
  SELECT e.id AS entryId, 0 AS leg, e.to_site_id AS siteId, e.from_site_id AS otherSiteId,
         CASE WHEN l.direction = 'out' THEN -l.quantity ELSE l.quantity END AS quantity, ${LEDGER_COLUMNS}
    FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
   WHERE e.tenant_id = :tenantId AND e.status = 'active'
  UNION ALL
  SELECT e.id, 1, e.from_site_id, e.to_site_id, -l.quantity, ${LEDGER_COLUMNS}
    FROM centring_entries e JOIN centring_entry_lines l ON l.entry_id = e.id
   WHERE e.tenant_id = :tenantId AND e.status = 'active' AND e.entry_type = 'transfer'`;

async function getTransactions({ tenantId, auth, query }) {
  const { page, limit, offset } = parseListQuery(query, { sortableFields: ['entryDate'], defaultSort: 'entryDate:desc' });
  const withCost = seesCost(auth);
  const siteIds = siteFilter(auth, query.siteId);
  const itemId = query.itemId ? readId(query.itemId, 'Item') : null;
  const entryType = parseEnumFilter(query.entryType, CentringEntry.TYPES, 'Type');
  const dateFrom = optionalDateFilter(query.dateFrom, 'From date');
  const dateTo = optionalDateFilter(query.dateTo, 'To date');
  if (dateFrom && dateTo && dateFrom > dateTo) throw AppError.badRequest('From date must be on or before To date');
  if (siteIds && siteIds.length === 0) return buildListResponse([], { page, limit, total: 0 });

  const where = [
    siteIds ? ' AND x.siteId IN (:siteIds)' : '',
    itemId ? ' AND x.itemId = :itemId' : '',
    entryType ? ' AND x.entryType = :entryType' : '',
    dateFrom ? ' AND x.entryDate >= :dateFrom' : '',
    dateTo ? ' AND x.entryDate <= :dateTo' : '',
  ].join('');
  const replacements = { tenantId, siteIds, itemId, entryType, dateFrom, dateTo, limit, offset };
  const [[{ total }], rows] = await Promise.all([
    sequelize.query(`SELECT COUNT(*) AS total FROM (${LEDGER_SQL}) x WHERE 1 = 1${where}`, { replacements, type: QueryTypes.SELECT }),
    sequelize.query(
      `SELECT x.* FROM (${LEDGER_SQL}) x WHERE 1 = 1${where}
        ORDER BY x.entryDate DESC, x.createdAt DESC, x.entryId DESC, x.leg DESC, x.lineId ASC
        LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT }
    ),
  ]);
  if (rows.length === 0) return buildListResponse([], { page, limit, total: Number(total) });

  const [names, items, users, suppliers] = await Promise.all([
    siteNamesById(tenantId, rows.flatMap((r) => [r.siteId, r.otherSiteId].filter(Boolean))),
    CentringItem.findAll({ where: { tenantId, id: [...new Set(rows.map((r) => r.itemId))] }, attributes: ['id', 'itemName', 'unit'] }),
    User.findAll({ where: { tenantId, id: [...new Set(rows.map((r) => r.createdBy))] }, attributes: ['id', 'name'] }),
    CentringSupplier.findAll({ where: { tenantId, id: [...new Set(rows.map((r) => r.supplierId).filter(Boolean))] }, attributes: ['id', 'supplierName'] }),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const supplierNames = new Map(suppliers.map((s) => [s.id, s.supplierName]));

  const data = rows.map((r) => {
    const quantity = roundQuantity(Number(r.quantity));
    const amount = roundMoney(Number(r.amount));
    const item = itemById.get(Number(r.itemId));
    return {
      id: `${r.entryId}-${r.lineId}-${r.leg}`,
      entryId: Number(r.entryId),
      entryNumber: r.entryNumber,
      entryType: r.entryType,
      entryDate: r.entryDate,
      createdAt: r.createdAt,
      siteId: Number(r.siteId),
      siteName: siteName(names, r.siteId),
      // For a transfer, the other end: where it went (row at the site it left) or came from (row at the site it reached).
      otherSiteName: r.otherSiteId ? siteName(names, r.otherSiteId) : null,
      itemId: Number(r.itemId),
      itemName: item?.itemName ?? null,
      unit: item?.unit ?? null,
      quantity,
      supplierName: r.supplierId ? (supplierNames.get(Number(r.supplierId)) ?? null) : null,
      billNumber: r.billNumber,
      purpose: r.purpose,
      issuedTo: r.issuedTo,
      reason: r.reason,
      createdByName: userNames.get(Number(r.createdBy)) ?? null,
      // What the material is worth: the purchase price incl. tax, or the average rate it moved at.
      ...(withCost ? { rate: quantity ? roundUnitCost(amount / Math.abs(quantity)) : 0, amount: quantity < 0 ? -amount : amount } : {}),
    };
  });
  return buildListResponse(data, { page, limit, total: Number(total) });
}

module.exports = {
  getSites,
  getStock,
  getTransactions,
  createEntry,
  listEntries,
  getEntry,
  deleteEntry,
  getReports,
  ADJUSTMENT_REASONS: CentringEntry.ADJUSTMENT_REASONS,
};
