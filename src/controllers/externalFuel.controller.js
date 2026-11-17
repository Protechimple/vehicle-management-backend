const externalFuelService = require('../services/externalFuel.service');

async function list(req, res) {
  const response = await externalFuelService.listExternalFuelEntries({
    tenantId: req.auth.tenantId,
    auth: req.auth,
    query: req.query,
  });
  res.status(200).json({ ...response, message: 'External fuel entries retrieved' });
}

async function get(req, res) {
  const data = await externalFuelService.getExternalFuelEntry({
    tenantId: req.auth.tenantId,
    auth: req.auth,
    id: req.params.id,
  });
  res.status(200).json({ data, message: 'External fuel entry retrieved' });
}

async function create(req, res) {
  const data = await externalFuelService.createExternalFuelEntry({
    tenantId: req.auth.tenantId,
    auth: req.auth,
    actingUserId: req.auth.userId,
    payload: req.body ?? {},
  });
  res.status(201).json({ data, message: 'External vehicle fuel recorded' });
}

async function update(req, res) {
  const data = await externalFuelService.updateExternalFuelEntry({
    tenantId: req.auth.tenantId,
    auth: req.auth,
    actingUserId: req.auth.userId,
    id: req.params.id,
    payload: req.body ?? {},
  });
  res.status(200).json({ data, message: 'External vehicle fuel updated' });
}

async function remove(req, res) {
  const data = await externalFuelService.deleteExternalFuelEntry({
    tenantId: req.auth.tenantId,
    auth: req.auth,
    actingUserId: req.auth.userId,
    id: req.params.id,
    confirmation: req.body?.confirmation,
  });
  res.status(200).json({ data, message: 'External vehicle fuel deleted' });
}

module.exports = { list, get, create, update, remove };
