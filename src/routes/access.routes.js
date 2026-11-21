const express = require('express');
const accessController = require('../controllers/access.controller');
const { adminOnly, requirePermission } = require('../middleware/authorize');

// What each role may do in this organization. The Admin's alone.
const router = express.Router();

router.use(adminOnly, requirePermission('USERS', 'MANAGE_ACCESS'));

router.get('/roles', accessController.getRoles);
router.put('/roles/:role', accessController.updateRole);

module.exports = router;
