const {
  ROLES,
  ROLE_LABELS,
  SITE_ROLES,
  MULTI_SITE_ROLES,
  PERMISSIONS,
  ACTION_LABELS,
  ACCESS_MODULES,
  keyOf,
  viewActionOf,
  isConfigurable,
  isDefaultAllowed,
  resolvePermissions,
} = require('../config/permissions');
const { sequelize, User, UserSite, RolePermission, UserPermission } = require('../models');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');

// ---------------------------------------------------------------------------------------------------------------------
// What a signed-in user may do and where

async function loadSiteIds(user, { transaction } = {}) {
  if (user.role === ROLES.ADMIN) return null;
  if (MULTI_SITE_ROLES.includes(user.role)) {
    const rows = await UserSite.findAll({ where: { userId: user.id }, attributes: ['siteId'], order: [['siteId', 'ASC']], transaction });
    return rows.map((row) => row.siteId);
  }
  return user.siteId ? [user.siteId] : [];
}

function toOverrideMap(rows) {
  return new Map(rows.map((row) => [keyOf(row.resource, row.action), Boolean(row.allowed)]));
}

async function loadPermissions(user, { transaction } = {}) {
  if (user.role === ROLES.ADMIN) return resolvePermissions({ role: ROLES.ADMIN });
  const [roleRows, userRows] = await Promise.all([
    RolePermission.findAll({ where: { tenantId: user.tenantId, role: user.role }, transaction }),
    UserPermission.findAll({ where: { userId: user.id }, transaction }),
  ]);
  return resolvePermissions({ role: user.role, roleOverrides: toOverrideMap(roleRows), userOverrides: toOverrideMap(userRows) });
}

async function loadAccess(user, options) {
  const [siteIds, permissions] = await Promise.all([loadSiteIds(user, options), loadPermissions(user, options)]);
  return { siteIds, permissions };
}

// The form the browser keeps: the sites as a list and the permissions as "RESOURCE:ACTION" strings.
function publicAccess({ siteIds, permissions }) {
  return { siteIds, permissions: [...permissions].sort() };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Admin's access screen

function catalog() {
  return {
    roles: SITE_ROLES.map((role) => ({ role, label: ROLE_LABELS[role] })),
    modules: ACCESS_MODULES.map((module) => ({
      key: module.key,
      label: module.label,
      resources: module.resources.map(({ resource, label }) => ({
        resource,
        label,
        viewAction: viewActionOf(resource),
        actions: Object.keys(PERMISSIONS[resource])
          .filter((action) => isConfigurable(resource, action))
          // View first: everything else on a screen depends on it.
          .sort((a, b) => (b === viewActionOf(resource)) - (a === viewActionOf(resource)))
          .map((action) => ({
            action,
            label: ACTION_LABELS[action] ?? action,
            defaults: Object.fromEntries(SITE_ROLES.map((role) => [role, isDefaultAllowed(role, resource, action)])),
          })),
      })),
    })),
  };
}

function requireSiteRole(role) {
  if (!SITE_ROLES.includes(role)) {
    throw AppError.badRequest(`Role must be one of: ${SITE_ROLES.join(', ')}`);
  }
  return role;
}

// Reads [{ resource, action, allowed }] and keeps only real, configurable actions. allowed: true, false, or null for
// "go back to the default".
function readChanges(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw AppError.badRequest('Send at least one permission change');
  if (raw.length > 500) throw AppError.badRequest('Too many permission changes at once');

  const changes = new Map();
  for (const entry of raw) {
    const resource = typeof entry?.resource === 'string' ? entry.resource : '';
    const action = typeof entry?.action === 'string' ? entry.action : '';
    if (!isConfigurable(resource, action)) {
      throw AppError.badRequest(`${resource || 'That'} ${action || 'action'} cannot be changed`);
    }
    if (entry.allowed !== true && entry.allowed !== false && entry.allowed !== null) {
      throw AppError.badRequest('Each change needs allowed set to true, false or null');
    }
    changes.set(keyOf(resource, action), { resource, action, allowed: entry.allowed });
  }
  return [...changes.values()];
}

function matrixFor(granted, overrides) {
  const result = {};
  for (const { resources } of ACCESS_MODULES) {
    for (const { resource } of resources) {
      for (const action of Object.keys(PERMISSIONS[resource])) {
        if (!isConfigurable(resource, action)) continue;
        const key = keyOf(resource, action);
        result[key] = { allowed: granted.has(key), overridden: overrides.has(key) };
      }
    }
  }
  return result;
}

async function getRoleAccess({ tenantId }) {
  const rows = await RolePermission.findAll({ where: { tenantId } });
  const roles = {};
  for (const role of SITE_ROLES) {
    const overrides = toOverrideMap(rows.filter((row) => row.role === role));
    roles[role] = matrixFor(resolvePermissions({ role, roleOverrides: overrides }), overrides);
  }
  return { ...catalog(), access: roles };
}

// Saves only what differs from the built-in rule, so a later change to a default reaches every organization that
// never touched it.
async function upsertOverrides({ model, where, changes, isDefault, actingUserId, transaction }) {
  for (const { resource, action, allowed } of changes) {
    const scope = { ...where, resource, action };
    if (allowed === null || allowed === isDefault(resource, action)) {
      await model.destroy({ where: scope, transaction });
    } else {
      const existing = await model.findOne({ where: scope, transaction, lock: transaction.LOCK.UPDATE });
      if (existing) await existing.update({ allowed, updatedBy: actingUserId }, { transaction });
      else await model.create({ ...scope, allowed, updatedBy: actingUserId }, { transaction });
    }
  }
}

async function updateRoleAccess({ tenantId, actingUserId, role: rawRole, payload }) {
  const role = requireSiteRole(rawRole);
  const changes = readChanges(payload?.permissions);

  await sequelize.transaction(async (transaction) => {
    await upsertOverrides({
      model: RolePermission,
      where: { tenantId, role },
      changes,
      isDefault: (resource, action) => isDefaultAllowed(role, resource, action),
      actingUserId,
      transaction,
    });
    await recordAudit(
      { tenantId, entityType: 'RoleAccess', entityId: role, action: 'ROLE_ACCESS_UPDATED', after: { changes }, performedBy: actingUserId },
      { transaction }
    );
  });

  return getRoleAccess({ tenantId });
}

async function findMember(tenantId, userId, { transaction } = {}) {
  const user = await User.findOne({ where: { id: userId, tenantId }, transaction });
  if (!user || user.role === ROLES.ADMIN) throw AppError.notFound('User not found');
  return user;
}

async function getUserAccess({ tenantId, userId }) {
  const user = await findMember(tenantId, userId);
  const [roleRows, userRows] = await Promise.all([
    RolePermission.findAll({ where: { tenantId, role: user.role } }),
    UserPermission.findAll({ where: { userId: user.id } }),
  ]);
  const roleOverrides = toOverrideMap(roleRows);
  const userOverrides = toOverrideMap(userRows);
  const roleGranted = resolvePermissions({ role: user.role, roleOverrides });

  return {
    ...catalog(),
    user: user.toPublicJSON(),
    roleAccess: matrixFor(roleGranted, roleOverrides),
    access: matrixFor(resolvePermissions({ role: user.role, roleOverrides, userOverrides }), userOverrides),
  };
}

async function updateUserAccess({ tenantId, actingUserId, userId, payload }) {
  const changes = readChanges(payload?.permissions);

  await sequelize.transaction(async (transaction) => {
    const user = await findMember(tenantId, userId, { transaction });
    const roleOverrides = toOverrideMap(await RolePermission.findAll({ where: { tenantId, role: user.role }, transaction }));
    // A person's exception is kept only while it differs from what their role would give them.
    const roleGives = (resource, action) => {
      const key = keyOf(resource, action);
      return roleOverrides.has(key) ? roleOverrides.get(key) : isDefaultAllowed(user.role, resource, action);
    };

    await upsertOverrides({
      model: UserPermission,
      where: { tenantId, userId: user.id },
      changes,
      isDefault: roleGives,
      actingUserId,
      transaction,
    });
    await recordAudit(
      { tenantId, entityType: 'User', entityId: user.id, action: 'USER_ACCESS_UPDATED', after: { changes }, performedBy: actingUserId },
      { transaction }
    );
  });

  return getUserAccess({ tenantId, userId });
}

// A user's exceptions are worked out against their role, so they no longer mean anything once the role changes.
async function clearUserOverrides(userId, { transaction }) {
  await UserPermission.destroy({ where: { userId }, transaction });
}

module.exports = {
  loadSiteIds,
  loadPermissions,
  loadAccess,
  publicAccess,
  catalog,
  getRoleAccess,
  updateRoleAccess,
  getUserAccess,
  updateUserAccess,
  clearUserOverrides,
};
