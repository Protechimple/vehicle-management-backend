const userService = require('../services/user.service');
const authService = require('../services/auth.service');
const accessService = require('../services/access.service');

async function list(req, res) {
  const data = await userService.listOrganizationUsers({ tenantId: req.auth.tenantId });
  res.status(200).json({ data, message: 'Users retrieved' });
}

// The older /supervisors route creates a Supervisor unless a role is given; /members always needs one.
function defaultRoleFor(req) {
  return req.defaultRole ?? null;
}

async function createMember(req, res) {
  const data = await userService.createMember({
    tenantId: req.auth.tenantId,
    actingUserId: req.auth.userId,
    payload: req.body ?? {},
    defaultRole: defaultRoleFor(req),
  });

  res.status(201).json({ data, message: `${data.roleLabel} created` });
}

async function updateMember(req, res) {
  const data = await userService.updateMember({
    tenantId: req.auth.tenantId,
    actingUserId: req.auth.userId,
    memberId: req.params.id,
    payload: req.body ?? {},
  });

  res.status(200).json({ data, message: `${data.roleLabel} updated` });
}

async function setMemberStatus(req, res) {
  const { status } = req.body ?? {};

  const data = await userService.setMemberStatus({
    tenantId: req.auth.tenantId,
    actingUserId: req.auth.userId,
    memberId: req.params.id,
    status,
  });

  res.status(200).json({ data, message: `${data.roleLabel} ${status === 'active' ? 'reactivated' : 'deactivated'}` });
}

async function changeMemberPassword(req, res) {
  const { password } = req.body ?? {};

  const data = await userService.changeMemberPassword({
    tenantId: req.auth.tenantId,
    actingUserId: req.auth.userId,
    memberId: req.params.id,
    password,
  });

  res.status(200).json({ data, message: `${data.roleLabel} password changed` });
}

async function team(req, res) {
  const data = await userService.listTeam({ tenantId: req.auth.tenantId, auth: req.auth });
  res.status(200).json({ data, message: 'Team retrieved' });
}

async function getMemberAccess(req, res) {
  const data = await accessService.getUserAccess({ tenantId: req.auth.tenantId, userId: req.params.id });
  res.status(200).json({ data, message: 'Access retrieved' });
}

async function updateMemberAccess(req, res) {
  const data = await accessService.updateUserAccess({
    tenantId: req.auth.tenantId,
    actingUserId: req.auth.userId,
    userId: req.params.id,
    payload: req.body ?? {},
  });
  res.status(200).json({ data, message: 'Access updated' });
}

async function updateOwnProfile(req, res) {
  const { name, email, organizationName, currentPassword } = req.body ?? {};

  const data = await authService.updateOwnProfile({
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    name,
    email,
    organizationName,
    currentPassword,
  });

  res.status(200).json({ data, message: 'Profile updated' });
}

async function changeOwnPassword(req, res) {
  const { currentPassword, newPassword } = req.body ?? {};

  const data = await authService.changeOwnPassword({
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    currentPassword,
    newPassword,
  });

  res.status(200).json({ data, message: 'Password changed. You have been signed out on other devices.' });
}

module.exports = {
  list,
  createMember,
  updateMember,
  setMemberStatus,
  changeMemberPassword,
  team,
  getMemberAccess,
  updateMemberAccess,
  updateOwnProfile,
  changeOwnPassword,
};
