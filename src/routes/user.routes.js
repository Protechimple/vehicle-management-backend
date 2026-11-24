const express = require('express');
const userController = require('../controllers/user.controller');
const { authenticated, adminOnly, requirePermission } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');
const { accountChangeLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.param('id', validateIdParam('User not found'));

// A Site Manager's own team. Everything after this is the Admin's.
router.get('/team', authenticated, requirePermission('USERS', 'VIEW_TEAM'), userController.team);

router.use(adminOnly);

router.get('/', requirePermission('USERS', 'LIST'), userController.list);

const asSupervisor = (req, _res, next) => {
  req.defaultRole = 'supervisor';
  next();
};

// /members covers every role. /supervisors is the older path and stays for anything still calling it.
router.post('/members', requirePermission('USERS', 'CREATE_SUPERVISOR'), userController.createMember);
router.post('/supervisors', requirePermission('USERS', 'CREATE_SUPERVISOR'), asSupervisor, userController.createMember);

router.put(['/members/:id', '/supervisors/:id'], requirePermission('USERS', 'UPDATE_SUPERVISOR'), userController.updateMember);

router.patch(
  ['/members/:id/status', '/supervisors/:id/status'],
  requirePermission('USERS', 'SET_SUPERVISOR_STATUS'),
  userController.setMemberStatus
);

router.put(
  ['/members/:id/password', '/supervisors/:id/password'],
  requirePermission('USERS', 'CHANGE_SUPERVISOR_PASSWORD'),
  accountChangeLimiter,
  userController.changeMemberPassword
);

router.get('/members/:id/access', requirePermission('USERS', 'MANAGE_ACCESS'), userController.getMemberAccess);
router.put('/members/:id/access', requirePermission('USERS', 'MANAGE_ACCESS'), userController.updateMemberAccess);

router.put(
  '/me',
  requirePermission('USERS', 'UPDATE_OWN_PROFILE'),
  accountChangeLimiter,
  userController.updateOwnProfile
);

router.put(
  '/me/password',
  requirePermission('USERS', 'CHANGE_OWN_PASSWORD'),
  accountChangeLimiter,
  userController.changeOwnPassword
);

module.exports = router;
