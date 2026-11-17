const batteryService = require('../services/battery.service');
const batteryReportService = require('../services/batteryReport.service');

const ctx = (req) => ({ tenantId: req.auth.tenantId, auth: req.auth, actingUserId: req.auth.userId });

async function list(req, res) {
  const response = await batteryService.listBatteries({ ...ctx(req), query: req.query });
  res.status(200).json({ ...response, message: 'Batteries retrieved' });
}

async function summary(req, res) {
  const data = await batteryService.summary({ ...ctx(req), query: req.query });
  res.status(200).json({ data, message: 'Battery summary retrieved' });
}

async function get(req, res) {
  const data = await batteryService.getBattery({ ...ctx(req), id: req.params.id });
  res.status(200).json({ data, message: 'Battery retrieved' });
}

async function purchase(req, res) {
  const data = await batteryService.purchaseBatteries({ ...ctx(req), payload: req.body ?? {} });
  res.status(201).json({ data, message: `${data.length} ${data.length === 1 ? 'battery' : 'batteries'} added to storage` });
}

async function fit(req, res) {
  const data = await batteryService.fitBattery({ ...ctx(req), payload: req.body ?? {} });
  res.status(201).json({ data, message: `Battery ${data.batteryCode} fitted to ${data.assetLabel}` });
}

async function replace(req, res) {
  const data = await batteryService.replaceBattery({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(200).json({ data, message: `Battery replaced. ${data.batteryCode} is now fitted to ${data.assetLabel}` });
}

async function remove(req, res) {
  const data = await batteryService.removeBattery({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(200).json({ data, message: `Battery ${data.batteryCode} removed` });
}

async function sendForRepair(req, res) {
  const data = await batteryService.sendForRepair({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(200).json({ data, message: `Battery ${data.batteryCode} marked as needing repair` });
}

async function repaired(req, res) {
  const data = await batteryService.markRepaired({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(200).json({ data, message: `Battery ${data.batteryCode} is repaired and ready to use` });
}

async function scrap(req, res) {
  const data = await batteryService.scrapBattery({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(200).json({ data, message: `Battery ${data.batteryCode} scrapped` });
}

async function update(req, res) {
  const data = await batteryService.updateDetails({ ...ctx(req), id: req.params.id, payload: req.body ?? {} });
  res.status(200).json({ data, message: 'Battery details updated' });
}

async function destroy(req, res) {
  const data = await batteryService.deleteBattery({ ...ctx(req), id: req.params.id, confirmation: req.body?.confirmation });
  res.status(200).json({ data, message: 'Battery deleted' });
}

async function events(req, res) {
  const response = await batteryService.listEvents({ ...ctx(req), query: req.query });
  res.status(200).json({ ...response, message: 'Battery history retrieved' });
}

async function assetReport(req, res) {
  const data = await batteryReportService.assetReport({ ...ctx(req), query: req.query });
  res.status(200).json({ data, message: 'Battery report by asset retrieved' });
}

async function costReport(req, res) {
  const data = await batteryReportService.costReport({ ...ctx(req), query: req.query });
  res.status(200).json({ data, message: 'Battery cost report retrieved' });
}

module.exports = {
  list,
  summary,
  get,
  purchase,
  fit,
  replace,
  remove,
  sendForRepair,
  repaired,
  scrap,
  update,
  destroy,
  events,
  assetReport,
  costReport,
};
