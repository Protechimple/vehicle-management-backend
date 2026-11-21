const accessService = require('../services/access.service');

async function getRoles(req, res) {
  const data = await accessService.getRoleAccess({ tenantId: req.auth.tenantId });
  res.status(200).json({ data, message: 'Role access retrieved' });
}

async function updateRole(req, res) {
  const data = await accessService.updateRoleAccess({
    tenantId: req.auth.tenantId,
    actingUserId: req.auth.userId,
    role: req.params.role,
    payload: req.body ?? {},
  });
  res.status(200).json({ data, message: 'Role access updated' });
}

module.exports = { getRoles, updateRole };
