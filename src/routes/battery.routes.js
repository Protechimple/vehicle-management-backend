const express = require('express');
const batteryController = require('../controllers/battery.controller');
const { authenticated, requirePermission } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');

const router = express.Router();

router.use(authenticated);
router.param('id', validateIdParam('Battery not found'));

router.get('/', requirePermission('BATTERY', 'READ'), batteryController.list);
router.get('/summary', requirePermission('BATTERY', 'READ'), batteryController.summary);
router.get('/events', requirePermission('BATTERY', 'READ'), batteryController.events);
router.get('/reports/assets', requirePermission('REPORTS', 'VIEW'), batteryController.assetReport);
router.get('/reports/costs', requirePermission('REPORTS', 'VIEW'), batteryController.costReport);

router.post('/purchases', requirePermission('BATTERY', 'CREATE'), batteryController.purchase);
router.post('/fit', requirePermission('BATTERY', 'CREATE'), batteryController.fit);

router.get('/:id', requirePermission('BATTERY', 'READ'), batteryController.get);
router.put('/:id', requirePermission('BATTERY', 'EDIT_DETAILS'), batteryController.update);
router.delete('/:id', requirePermission('BATTERY', 'DELETE'), batteryController.destroy);
router.post('/:id/replace', requirePermission('BATTERY', 'UPDATE'), batteryController.replace);
router.post('/:id/remove', requirePermission('BATTERY', 'UPDATE'), batteryController.remove);
router.post('/:id/send-for-repair', requirePermission('BATTERY', 'UPDATE'), batteryController.sendForRepair);
router.post('/:id/repaired', requirePermission('BATTERY', 'UPDATE'), batteryController.repaired);
router.post('/:id/scrap', requirePermission('BATTERY', 'SCRAP'), batteryController.scrap);

module.exports = router;
