const express = require('express');
const dashboardController = require('../controllers/dashboard.controller');
const { authenticated, requirePermission } = require('../middleware/authorize');

const router = express.Router();

router.use(authenticated);

router.get('/summary', requirePermission('DASHBOARD', 'VIEW_SUMMARY_METRICS'), dashboardController.summary);
router.get('/monthly-cost', requirePermission('DASHBOARD', 'VIEW_SUMMARY_METRICS'), dashboardController.monthlyCost);
router.get('/fleet', requirePermission('DASHBOARD', 'VIEW_SUMMARY_METRICS'), dashboardController.fleet);
router.get('/maintenance', requirePermission('MAINTENANCE', 'READ'), dashboardController.maintenance);
router.get('/tyres', requirePermission('TYRE', 'READ'), dashboardController.tyres);
router.get('/adblue', requirePermission('ADBLUE', 'READ'), dashboardController.adblue);
router.get('/centring', requirePermission('CENTRING', 'READ'), dashboardController.centring);

module.exports = router;
