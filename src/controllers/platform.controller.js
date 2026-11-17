const platformService = require('../services/platform.service');
const platformActivityService = require('../services/platformActivity.service');

function actor(req) {
  return { id: req.platformAuth.adminId, email: req.platformAuth.email };
}

async function logIn(req, res) {
  const { email, password } = req.body ?? {};
  const data = await platformService.logIn({ email, password });
  res.status(200).json({ data, message: 'Signed in' });
}

async function logOut(_req, res) {
  res.status(200).json({ data: null, message: 'Signed out' });
}

async function changeOwnPassword(req, res) {
  const { currentPassword, newPassword } = req.body ?? {};
  const data = await platformService.changeOwnPassword({
    adminId: req.platformAuth.adminId,
    currentPassword,
    newPassword,
  });
  res.status(200).json({ data, message: 'Password changed. You have been signed out on other devices.' });
}

async function overview(_req, res) {
  const data = await platformActivityService.platformOverview();
  res.status(200).json({ data, message: 'Overview retrieved' });
}

async function activity(req, res) {
  const tenantId = req.query.tenantId ? (await platformService.findTenant(req.query.tenantId)).tenantId : undefined;
  const response = await platformActivityService.listActivity({ tenantId, query: req.query });
  res.status(200).json({ ...response, message: 'Activity retrieved' });
}

async function tenantActivity(req, res) {
  const tenant = await platformService.findTenant(req.params.tenantId);
  const response = await platformActivityService.listTenantActivity({ tenantId: tenant.tenantId, query: req.query });
  res.status(200).json({ ...response, message: 'Activity retrieved' });
}

async function listTenants(req, res) {
  const response = await platformService.listTenants({ query: req.query });
  res.status(200).json({ ...response, message: 'Organizations retrieved' });
}

async function getTenant(req, res) {
  const data = await platformService.getTenant({ tenantId: req.params.tenantId });
  res.status(200).json({ data, message: 'Organization retrieved' });
}

async function createTenant(req, res) {
  const data = await platformService.createTenant({ platformAdmin: actor(req), payload: req.body ?? {} });
  res.status(201).json({ data, message: 'Organization created' });
}

async function updateTenant(req, res) {
  const data = await platformService.updateTenant({
    platformAdmin: actor(req),
    tenantId: req.params.tenantId,
    payload: req.body ?? {},
  });
  res.status(200).json({ data, message: 'Organization updated' });
}

async function setTenantStatus(req, res) {
  const data = await platformService.setTenantStatus({
    platformAdmin: actor(req),
    tenantId: req.params.tenantId,
    status: req.body?.status,
  });
  res.status(200).json({ data, message: data.status === 'active' ? 'Organization activated' : 'Organization suspended' });
}

async function resetAdminPassword(req, res) {
  const data = await platformService.resetAdminPassword({
    platformAdmin: actor(req),
    tenantId: req.params.tenantId,
    password: req.body?.password,
  });
  res.status(200).json({ data, message: 'Admin password reset. They must change it at next sign-in.' });
}

module.exports = {
  logIn,
  logOut,
  changeOwnPassword,
  overview,
  activity,
  tenantActivity,
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  setTenantStatus,
  resetAdminPassword,
};
