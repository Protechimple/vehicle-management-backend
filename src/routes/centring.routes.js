const express = require('express');
const centring = require('../controllers/centring.controller');
const { authenticated, requirePermission, requireAnyPermission } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');

const READ = requirePermission('CENTRING', 'READ');
const MANAGE = requirePermission('CENTRING', 'MANAGE_CATALOG');
// Anyone who records an entry needs the catalog to pick from.
const ENTRY_ACTIONS = ['PURCHASE', 'ISSUE', 'TRANSFER', 'ADJUST'].map((action) => ['CENTRING', action]);

function catalogRouter(handlers, notFound) {
  const router = express.Router();
  router.param('id', validateIdParam(notFound));
  router.get('/', READ, handlers.list);
  router.post('/', MANAGE, handlers.create);
  router.put('/:id', MANAGE, handlers.update);
  router.post('/:id/archive', MANAGE, handlers.archive);
  router.post('/:id/restore', MANAGE, handlers.restore);
  return router;
}

const entries = express.Router();
entries.param('id', validateIdParam('Centring entry not found'));
entries.get('/', READ, centring.listEntries);
entries.get('/:id', READ, centring.getEntry);
// Each type needs its own action; the service checks which.
entries.post('/', requireAnyPermission(ENTRY_ACTIONS), centring.createEntry);
entries.delete('/:id', requirePermission('CENTRING', 'DELETE'), centring.deleteEntry);

const router = express.Router();
router.use(authenticated);
router.get('/options', READ, centring.options);
router.get('/sites', READ, centring.sites);
router.get('/stock', READ, centring.stock);
router.get('/transactions', READ, centring.transactions);
router.get('/reports', requirePermission('CENTRING', 'VIEW_COST'), centring.reports);
router.use('/categories', catalogRouter(centring.categories, 'Category not found'));
router.use('/sub-categories', catalogRouter(centring.subCategories, 'Sub category not found'));
router.use('/units', catalogRouter(centring.units, 'Unit not found'));
router.use('/suppliers', catalogRouter(centring.suppliers, 'Supplier not found'));
router.use('/items', catalogRouter(centring.items, 'Item not found'));
router.use('/entries', entries);

module.exports = router;
