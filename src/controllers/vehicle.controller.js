const vehicleService = require('../services/vehicle.service');
const vehicleImportService = require('../services/vehicleImport.service');
const { AssetDocument } = require('../models');

function readAssetDocumentFiles(files) {
  const result = {};
  for (const docType of AssetDocument.DOC_TYPES) {
    result[docType] = files?.[docType]?.[0];
  }
  return result;
}

async function list(req, res) {
  const response = await vehicleService.listVehicles({ tenantId: req.auth.tenantId, auth: req.auth, query: req.query });
  res.status(200).json({ ...response, message: 'Vehicles retrieved' });
}

async function get(req, res) {
  const data = await vehicleService.getVehicle({ tenantId: req.auth.tenantId, auth: req.auth, id: req.params.id });
  res.status(200).json({ data, message: 'Vehicle retrieved' });
}

async function create(req, res) {
  const data = await vehicleService.createVehicle({
    tenantId: req.auth.tenantId, auth: req.auth,
    actingUserId: req.auth.userId,
    payload: req.body ?? {},
    files: readAssetDocumentFiles(req.files),
  });
  res.status(201).json({ data, message: 'Vehicle created' });
}

async function update(req, res) {
  const data = await vehicleService.updateVehicle({
    tenantId: req.auth.tenantId, auth: req.auth,
    actingUserId: req.auth.userId,
    id: req.params.id,
    payload: req.body ?? {},
  });
  res.status(200).json({ data, message: 'Vehicle updated' });
}

async function remove(req, res) {
  const data = await vehicleService.deleteVehicle({
    tenantId: req.auth.tenantId, auth: req.auth,
    actingUserId: req.auth.userId,
    id: req.params.id,
    confirmation: req.body?.confirmation,
  });
  res.status(200).json({ data, message: 'Vehicle archived successfully' });
}

async function restore(req, res) {
  const data = await vehicleService.restoreVehicle({
    tenantId: req.auth.tenantId, auth: req.auth,
    actingUserId: req.auth.userId,
    id: req.params.id,
  });
  res.status(200).json({ data, message: 'Vehicle restored successfully' });
}

async function history(req, res) {
  const data = await vehicleService.getVehicleHistory({ tenantId: req.auth.tenantId, auth: req.auth, id: req.params.id });
  res.status(200).json({ data, message: 'Vehicle history retrieved' });
}

async function costs(req, res) {
  const data = await vehicleService.getVehicleCosts({ tenantId: req.auth.tenantId, auth: req.auth, id: req.params.id });
  res.status(200).json({ data, message: 'Vehicle costs retrieved' });
}

async function importTemplate(req, res) {
  const buffer = await vehicleImportService.buildTemplate({ tenantId: req.auth.tenantId, auth: req.auth });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="vehicle-import-template.xlsx"');
  res.status(200).send(Buffer.from(buffer));
}

async function importPreview(req, res) {
  const data = await vehicleImportService.previewImport({ tenantId: req.auth.tenantId, auth: req.auth, file: req.file });
  res.status(200).json({ data, message: 'Sheet checked' });
}

async function importCommit(req, res) {
  const result = await vehicleImportService.commitImport({
    tenantId: req.auth.tenantId,
    auth: req.auth,
    actingUserId: req.auth.userId,
    file: req.file,
  });
  if (!result.ok) {
    return res.status(400).json({
      error: `${result.preview.summary.invalid} row(s) have errors. Nothing was imported.`,
      data: result.preview,
    });
  }
  return res.status(201).json({
    data: { created: result.created, vehicles: result.vehicles },
    message: `${result.created} vehicle(s) imported`,
  });
}

module.exports = { list, get, create, update, remove, restore, history, costs, importTemplate, importPreview, importCommit };
