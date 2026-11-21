const express = require('express');
const tyreController = require('../controllers/tyre.controller');
const { authenticated, requirePermission } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');

const TYRE_NOT_FOUND = Object.freeze({
  types: 'Tyre type not found',
  purchases: 'Tyre purchase not found',
  items: 'Tyre not found',
});

const router = express.Router();

router.use(authenticated);
router.param('id', validateIdParam((req) => TYRE_NOT_FOUND[req.path.split('/')[1]]));

const can = (action) => requirePermission('TYRE', action);

// Tyre types (brand / pattern / size)
router.get('/types', can('READ'), tyreController.listTypes);
router.post('/types', can('CREATE'), tyreController.createType);
router.put('/types/:id', can('UPDATE'), tyreController.updateType);

// Bulk purchases — every tyre bought goes into the New Tyre Store
router.get('/purchases', can('READ'), tyreController.listPurchases);
router.post('/purchases', can('CREATE'), tyreController.createPurchase);
router.get('/purchases/:id', can('READ'), tyreController.getPurchase);
router.delete('/purchases/:id', can('DELETE'), tyreController.cancelPurchase);

// Individual tyres and what happens to them
router.get('/summary', can('READ'), tyreController.summary);
router.get('/history', can('READ'), tyreController.history);
router.get('/items', can('READ'), tyreController.listTyres);
router.post('/items/spares', can('CREATE'), tyreController.addSpares);
router.get('/items/:id', can('READ'), tyreController.getTyre);
router.put('/items/:id', can('UPDATE'), tyreController.updateTyre);
router.post('/items/:id/fit', can('UPDATE'), tyreController.fit);
router.post('/items/:id/remove', can('UPDATE'), tyreController.remove);
router.post('/items/:id/puncture', can('UPDATE'), tyreController.puncture);
router.post('/items/:id/remould', can('UPDATE'), tyreController.sendForRemould);
router.post('/items/:id/remould-back', can('UPDATE'), tyreController.remouldBack);
router.post('/items/:id/scrap', can('UPDATE'), tyreController.scrap);

// Moving stored tyres to another site
router.get('/transfers', can('READ'), tyreController.listTransfers);
router.post('/transfers', can('TRANSFER'), tyreController.createTransfer);

// One vehicle / machine: its axle layout, fitted tyres and spares
router.get('/assets', can('READ'), tyreController.assetSetups);
router.get('/assets/:assetType/:assetId', can('READ'), tyreController.assetTyres);
router.put('/assets/:assetType/:assetId/layout', can('UPDATE'), tyreController.saveLayout);

router.get('/reports/assets', requirePermission('REPORTS', 'VIEW'), tyreController.assetReport);
router.get('/reports/costs', requirePermission('REPORTS', 'VIEW'), tyreController.costReport);

module.exports = router;
