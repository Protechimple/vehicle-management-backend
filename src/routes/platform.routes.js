const express = require('express');
const platformController = require('../controllers/platform.controller');
const { authenticatePlatform } = require('../middleware/authenticatePlatform');
const { authLimiter, signupLimiter, accountChangeLimiter } = require('../middleware/rateLimit');

// Super Admin API. Kept apart from the tenant routes: its own login, its own token type.
const router = express.Router();

router.post('/auth/login', authLimiter, platformController.logIn);

router.use(authenticatePlatform);

router.post('/auth/logout', platformController.logOut);
router.put('/auth/password', accountChangeLimiter, platformController.changeOwnPassword);

router.get('/overview', platformController.overview);
router.get('/activity', platformController.activity);

router.get('/tenants', platformController.listTenants);
router.post('/tenants', signupLimiter, platformController.createTenant);
router.get('/tenants/:tenantId', platformController.getTenant);
router.get('/tenants/:tenantId/activity', platformController.tenantActivity);
router.put('/tenants/:tenantId', platformController.updateTenant);
router.patch('/tenants/:tenantId/status', platformController.setTenantStatus);
router.put('/tenants/:tenantId/admin-password', accountChangeLimiter, platformController.resetAdminPassword);

module.exports = router;
