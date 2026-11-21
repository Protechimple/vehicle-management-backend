const tyreTypeService = require('../services/tyreType.service');
const tyrePurchaseService = require('../services/tyrePurchase.service');
const tyreService = require('../services/tyre.service');
const tyreReportService = require('../services/tyreReport.service');
const tyreTransferService = require('../services/tyreTransfer.service');
const tyreHistoryService = require('../services/tyreHistory.service');

const ctx = (req) => ({ tenantId: req.auth.tenantId, auth: req.auth, actingUserId: req.auth.userId });

// Small wrappers so each route is one line: status, service call, message.
const list = (fn, message) => async (req, res) => {
  const response = await fn({ ...ctx(req), query: req.query });
  res.status(200).json({ ...response, message });
};
// Reports and summaries: one object, returned as { data, message } like every other report.
const report = (fn, message) => async (req, res) => {
  const data = await fn({ ...ctx(req), query: req.query });
  res.status(200).json({ data, message });
};
const read = (fn, message) => async (req, res) => {
  const data = await fn({ ...ctx(req), id: req.params.id, query: req.query });
  res.status(200).json({ data, message });
};
const write = (fn, message, status = 200) => async (req, res) => {
  const data = await fn({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(status).json({ data, message: typeof message === 'function' ? message(data) : message });
};

async function cancelPurchase(req, res) {
  const data = await tyrePurchaseService.cancelTyrePurchase({ ...ctx(req), id: req.params.id, confirmation: req.body?.confirmation });
  res.status(200).json({ data, message: 'Tyre purchase cancelled' });
}

async function assetTyres(req, res) {
  const data = await tyreService.getAssetTyres({ ...ctx(req), assetType: req.params.assetType, assetId: req.params.assetId });
  res.status(200).json({ data, message: 'Tyres retrieved' });
}

async function saveLayout(req, res) {
  const data = await tyreService.saveLayout({ ...ctx(req), assetType: req.params.assetType, assetId: req.params.assetId, payload: req.body ?? {} });
  res.status(200).json({ data, message: 'Axles saved' });
}

const plural = (n) => `${n} ${n === 1 ? 'tyre' : 'tyres'}`;

module.exports = {
  listTypes: list(tyreTypeService.listTyreTypes, 'Tyre types retrieved'),
  createType: write(tyreTypeService.createTyreType, 'Tyre type added', 201),
  updateType: write(tyreTypeService.updateTyreType, 'Tyre type updated'),

  listPurchases: list(tyrePurchaseService.listTyrePurchases, 'Tyre purchases retrieved'),
  getPurchase: read(tyrePurchaseService.getTyrePurchase, 'Tyre purchase retrieved'),
  createPurchase: write(tyrePurchaseService.createTyrePurchase, (d) => `Purchase ${d.purchaseNumber} saved — ${plural(d.tyreCount)} added to the New Tyre Store`, 201),
  cancelPurchase,

  listTyres: list(tyreService.listTyres, 'Tyres retrieved'),
  summary: report(tyreService.summary, 'Tyre summary retrieved'),
  getTyre: read(tyreService.getTyre, 'Tyre retrieved'),
  addSpares: write(tyreService.addSpareTyres, (d) => `${plural(d.length)} added to the Spare Tyre Store`, 201),
  updateTyre: write(tyreService.updateTyre, 'Tyre details saved'),
  fit: write(tyreService.fitTyre, (d) => `Tyre ${d.tyreCode} fitted to ${d.assetLabel} at ${d.position}`),
  remove: write(tyreService.removeTyre, (d) => `Tyre ${d.tyreCode} taken off`),
  puncture: write(tyreService.recordPuncture, (d) => `Puncture recorded for tyre ${d.tyreCode}`),
  sendForRemould: write(tyreService.sendForRemould, (d) => `Tyre ${d.tyreCode} sent for remoulding`),
  remouldBack: write(tyreService.remouldBack, (d) => `Tyre ${d.tyreCode} is back in the Spare Tyre Store`),
  scrap: write(tyreService.scrapTyre, (d) => `Tyre ${d.tyreCode} scrapped`),

  history: list(tyreHistoryService.listHistory, 'Tyre history retrieved'),
  listTransfers: list(tyreTransferService.listTransfers, 'Tyre transfers retrieved'),
  createTransfer: write(tyreTransferService.createTransfer, (d) => `${d.transferNumber}: ${plural(d.tyreCount)} moved from ${d.fromSiteName} to ${d.toSiteName}`, 201),

  assetSetups: report(tyreService.listAssetSetups, 'Tyre setups retrieved'),
  assetTyres,
  saveLayout,

  assetReport: report(tyreReportService.assetReport, 'Tyre report by asset retrieved'),
  costReport: report(tyreReportService.costReport, 'Tyre cost report retrieved'),
};
