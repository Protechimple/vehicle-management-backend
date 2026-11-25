const centringService = require('../services/centring.service');
const catalog = require('../services/centringCatalog.service');

const read = (req) => ({ tenantId: req.auth.tenantId, auth: req.auth, query: req.query, id: req.params.id });
const write = (req) => ({ tenantId: req.auth.tenantId, auth: req.auth, actingUserId: req.auth.userId, id: req.params.id, payload: req.body ?? {} });

// The catalog lists share one set of handlers.
function catalogHandlers(service, noun, nameOf) {
  return {
    list: async (req, res) => res.status(200).json({ ...(await service.list(read(req))), message: `${noun}s retrieved` }),
    create: async (req, res) => {
      const data = await service.create(write(req));
      res.status(201).json({ data, message: `${nameOf(data)} added` });
    },
    update: async (req, res) => {
      const data = await service.update(write(req));
      res.status(200).json({ data, message: `${nameOf(data)} updated` });
    },
    archive: async (req, res) => {
      const data = await service.archive(write(req));
      res.status(200).json({ data, message: `${nameOf(data)} archived` });
    },
    restore: async (req, res) => {
      const data = await service.restore(write(req));
      res.status(200).json({ data, message: `${nameOf(data)} restored` });
    },
  };
}

const categories = catalogHandlers(catalog.categories, 'Category', (d) => d.categoryName);
const subCategories = catalogHandlers(catalog.subCategories, 'Sub category', (d) => d.subCategoryName);
const units = catalogHandlers(catalog.units, 'Unit', (d) => d.unitName);
const suppliers = catalogHandlers(catalog.suppliers, 'Supplier', (d) => d.supplierName);
const items = catalogHandlers(catalog.items, 'Item', (d) => d.itemName);

async function options(_req, res) {
  res.status(200).json({ data: { adjustmentReasons: centringService.ADJUSTMENT_REASONS }, message: 'Centring options retrieved' });
}

async function sites(req, res) {
  res.status(200).json({ data: await centringService.getSites(read(req)), message: 'Centring sites retrieved' });
}

async function stock(req, res) {
  res.status(200).json({ data: await centringService.getStock(read(req)), message: 'Centring stock retrieved' });
}

async function transactions(req, res) {
  res.status(200).json({ ...(await centringService.getTransactions(read(req))), message: 'Centring transactions retrieved' });
}

async function reports(req, res) {
  res.status(200).json({ data: await centringService.getReports(read(req)), message: 'Centring reports retrieved' });
}

async function listEntries(req, res) {
  res.status(200).json({ ...(await centringService.listEntries(read(req))), message: 'Centring entries retrieved' });
}

async function getEntry(req, res) {
  res.status(200).json({ data: await centringService.getEntry(read(req)), message: 'Centring entry retrieved' });
}

async function createEntry(req, res) {
  const data = await centringService.createEntry(write(req));
  res.status(201).json({ data, message: `${data.typeLabel} ${data.entryNumber} saved` });
}

async function deleteEntry(req, res) {
  const data = await centringService.deleteEntry({ ...write(req), confirmation: req.body?.confirmation });
  res.status(200).json({ data, message: 'Entry deleted' });
}

module.exports = { categories, subCategories, units, suppliers, items, options, sites, stock, transactions, reports, listEntries, getEntry, createEntry, deleteEntry };
