const express = require('express');
const externalFuelController = require('../controllers/externalFuel.controller');
const { authenticated, requirePermission } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');

const router = express.Router();

router.use(authenticated);
router.param('id', validateIdParam('External fuel entry not found'));

router.get('/', requirePermission('FUEL', 'READ'), externalFuelController.list);

router.post('/', requirePermission('FUEL', 'CREATE'), externalFuelController.create);

router.get('/:id', requirePermission('FUEL', 'READ'), externalFuelController.get);

router.put('/:id', requirePermission('FUEL', 'UPDATE'), externalFuelController.update);

router.delete('/:id', requirePermission('FUEL', 'DELETE'), externalFuelController.remove);

module.exports = router;
