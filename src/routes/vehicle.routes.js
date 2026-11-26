const express = require('express');
const vehicleController = require('../controllers/vehicle.controller');
const { authenticated, requirePermission, requireAnyPermission, ASSET_LOOKUP } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');
const { uploadAssetCreationDocuments, uploadImportSheet } = require('../middleware/upload');

const router = express.Router();

router.use(authenticated);
router.param('id', validateIdParam('Vehicle not found'));

router.get('/', requireAnyPermission([['VEHICLE', 'READ'], ...ASSET_LOOKUP]), vehicleController.list);

router.post(
  '/',
  requirePermission('VEHICLE', 'CREATE'),
  uploadAssetCreationDocuments,
  vehicleController.create
);

// Bulk import. Declared before /:id so "import" is not read as a vehicle id.
router.get('/import/template', requirePermission('VEHICLE', 'CREATE'), vehicleController.importTemplate);
router.post('/import/preview', requirePermission('VEHICLE', 'CREATE'), uploadImportSheet, vehicleController.importPreview);
router.post('/import', requirePermission('VEHICLE', 'CREATE'), uploadImportSheet, vehicleController.importCommit);

router.get('/:id', requirePermission('VEHICLE', 'READ'), vehicleController.get);

router.put('/:id', requirePermission('VEHICLE', 'UPDATE'), vehicleController.update);

router.delete('/:id', requirePermission('VEHICLE', 'DELETE'), vehicleController.remove);

router.post('/:id/restore', requirePermission('VEHICLE', 'RESTORE'), vehicleController.restore);

router.get('/:id/history', requirePermission('VEHICLE', 'READ'), vehicleController.history);

router.get('/:id/costs', requirePermission('VEHICLE', 'READ'), vehicleController.costs);

module.exports = router;
