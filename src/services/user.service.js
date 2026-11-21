const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

const env = require('../config/env');
const { ROLES, ROLE_LABELS, SITE_ROLES, MULTI_SITE_ROLES, MANAGEABLE_ROLES } = require('../config/permissions');
const { sequelize, User, Tenant, Site, UserSite, PasswordResetToken } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, requireEmail, requireNumber, requirePassword } = require('../utils/validation');
const { recordAudit } = require('./audit.service');
const { issueResetToken } = require('./passwordReset.service');
const { clearUserOverrides } = require('./access.service');
const emailService = require('./email.service');

const MEMBER_NOT_FOUND = 'User not found';
// A reporting line deeper than this is almost certainly a mistake, and it bounds the loop checks below.
const MAX_REPORTING_DEPTH = 10;

const isMultiSite = (role) => MULTI_SITE_ROLES.includes(role);

// ---------------------------------------------------------------------------------------------------------------------
// Reading members

async function siteIdsByUser(users, { transaction } = {}) {
  const managers = users.filter((user) => isMultiSite(user.role)).map((user) => user.id);
  const rows = managers.length
    ? await UserSite.findAll({ where: { userId: managers }, attributes: ['userId', 'siteId'], order: [['siteId', 'ASC']], transaction })
    : [];
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row.siteId);
  }
  return new Map(
    users.map((user) => [
      user.id,
      user.role === ROLES.ADMIN ? [] : isMultiSite(user.role) ? (byUser.get(user.id) ?? []) : user.siteId ? [user.siteId] : [],
    ])
  );
}

function toMember(user, siteIds) {
  return { ...user.toPublicJSON(), roleLabel: ROLE_LABELS[user.role] ?? user.role, siteIds: siteIds ?? [] };
}

async function toMembers(users, options) {
  const sites = await siteIdsByUser(users, options);
  return users.map((user) => toMember(user, sites.get(user.id)));
}

async function listOrganizationUsers({ tenantId }) {
  const users = await User.findAll({ where: { tenantId }, order: [['role', 'ASC'], ['createdAt', 'ASC']] });
  return toMembers(users);
}

async function findMember(tenantId, id, { transaction, lock } = {}) {
  const user = await User.findOne({ where: { id, tenantId, role: { [Op.ne]: ROLES.ADMIN } }, transaction, lock });
  if (!user) throw AppError.notFound(MEMBER_NOT_FOUND);
  return user;
}

async function describeMember(id) {
  const user = await User.findByPk(id);
  const [member] = await toMembers([user]);
  return member;
}

// ---------------------------------------------------------------------------------------------------------------------
// Validating input

function readRole(raw) {
  if (!SITE_ROLES.includes(raw)) {
    throw AppError.badRequest(`Role must be one of: ${SITE_ROLES.map((role) => ROLE_LABELS[role]).join(', ')}`);
  }
  return raw;
}

async function requireActiveSites(tenantId, ids, { transaction }) {
  const sites = await Site.findAll({ where: { tenantId, id: ids }, transaction });
  if (sites.length !== ids.length) throw AppError.badRequest('Site not found');
  const archived = sites.find((site) => site.status !== 'active');
  if (archived) throw AppError.badRequest(`${archived.name} is archived — pick an active site`);
  return ids;
}

// Every site role works at one or more sites. Accepts siteIds, or a single siteId from older callers.
async function readSiteIds(tenantId, role, payload, { transaction } = {}) {
  const raw = Array.isArray(payload.siteIds) ? payload.siteIds : payload.siteId != null && payload.siteId !== '' ? [payload.siteId] : [];
  if (raw.length === 0) throw AppError.badRequest(`Select at least one site for this ${ROLE_LABELS[role]}`);
  if (raw.length > 200) throw AppError.badRequest('Too many sites');
  const ids = [...new Set(raw.map((value) => requireNumber(value, 'Site', { min: 1 })))].sort((a, b) => a - b);
  return requireActiveSites(tenantId, ids, { transaction });
}

const isSubset = (inner, outer) => inner.every((id) => outer.some((other) => Number(other) === Number(id)));

// The Site Manager someone reports to. Their sites must lie within the manager's, and the line must not loop back.
async function readManager(tenantId, raw, { memberId = null, role, siteIds, transaction }) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!MANAGEABLE_ROLES.includes(role)) throw AppError.badRequest(`A ${ROLE_LABELS[role]} reports to the Admin, not to a Site Manager`);

  const managerId = requireNumber(raw, 'Site Manager', { min: 1 });
  if (memberId !== null && Number(managerId) === Number(memberId)) throw AppError.badRequest('Someone cannot report to themselves');

  const manager = await User.findOne({ where: { id: managerId, tenantId }, transaction });
  if (!manager || manager.role !== ROLES.SITE_MANAGER) throw AppError.badRequest('Pick a Site Manager to report to');
  if (!manager.isActive) throw AppError.badRequest(`${manager.name} is deactivated — pick an active Site Manager`);

  const managerSites = (await siteIdsByUser([manager], { transaction })).get(manager.id);
  if (!isSubset(siteIds, managerSites)) {
    throw AppError.badRequest(`${manager.name} does not cover ${siteIds.length > 1 ? 'all of these sites' : 'this site'}. Give them the site first, or pick another manager.`);
  }

  if (memberId !== null) {
    let cursor = manager;
    for (let depth = 0; cursor?.managerId && depth < MAX_REPORTING_DEPTH; depth += 1) {
      if (Number(cursor.managerId) === Number(memberId)) {
        throw AppError.badRequest(`${manager.name} already reports to this person, so they cannot report to ${manager.name}`);
      }
      cursor = await User.findOne({ where: { id: cursor.managerId, tenantId }, attributes: ['id', 'managerId'], transaction });
    }
  }

  return manager.id;
}

// A Site Manager may not drop a site that someone in their team still works at, nor stop being a Site Manager while
// people report to them.
async function assertTeamStillCovered(tenantId, member, { nextRole, nextSiteIds, transaction }) {
  const reports = await User.findAll({ where: { tenantId, managerId: member.id }, transaction });
  if (reports.length === 0) return;

  if (nextRole !== ROLES.SITE_MANAGER) {
    throw AppError.conflict(
      `${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to ${member.name}. Move them to another Site Manager first.`
    );
  }

  const reportSites = await siteIdsByUser(reports, { transaction });
  const stranded = reports.filter((report) => !isSubset(reportSites.get(report.id), nextSiteIds));
  if (stranded.length > 0) {
    throw AppError.conflict(
      `${stranded.map((report) => report.name).join(', ')} still work${stranded.length === 1 ? 's' : ''} at a site you are removing from ${member.name}. Move them first.`
    );
  }
}

async function saveSites(tenantId, user, role, siteIds, { actingUserId, transaction }) {
  {
    await UserSite.destroy({ where: { userId: user.id, siteId: { [Op.notIn]: siteIds } }, transaction });
    const existing = await UserSite.findAll({ where: { userId: user.id }, attributes: ['siteId'], transaction });
    const have = new Set(existing.map((row) => Number(row.siteId)));
    const missing = siteIds.filter((id) => !have.has(Number(id)));
    if (missing.length) {
      await UserSite.bulkCreate(
        missing.map((siteId) => ({ tenantId, userId: user.id, siteId, createdBy: actingUserId })),
        { transaction }
      );
    }
  }
  // users.site_id keeps the one site of someone who has exactly one, for anything that still reads it.
  return { siteId: siteIds.length === 1 ? siteIds[0] : null };
}

function unusablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), env.bcryptSaltRounds);
}

async function sendInvite({ tenantId, to, name, role, resetUrl }) {
  const tenant = await Tenant.findByPk(tenantId);
  await emailService.sendSupervisorInviteEmail({
    to,
    name,
    organizationName: tenant?.organizationName ?? 'your organization',
    resetUrl,
    expiresInMinutes: env.passwordResetTtlMinutes,
    roleLabel: ROLE_LABELS[role],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Creating and changing members

async function createMemberRecord({ tenantId, actingUserId, payload, defaultRole = null, transaction }) {
  const role = readRole(payload.role ?? defaultRole);
  const name = requireText(payload.name, 'Name', { max: 150 });
  const email = requireEmail(payload.email);
  const siteIds = await readSiteIds(tenantId, role, payload, { transaction });
  const managerId = await readManager(tenantId, payload.managerId, { role, siteIds, transaction });

  if (await User.findOne({ where: { email }, transaction })) {
    throw AppError.conflict(`An account with this email already exists: ${email}`);
  }

  const created = await User.create(
    {
      tenantId,
      name,
      email,
      passwordHash: await unusablePasswordHash(),
      role,
      status: 'active',
      siteId: siteIds.length === 1 ? siteIds[0] : null,
      managerId,
    },
    { transaction }
  );
  await saveSites(tenantId, created, role, siteIds, { actingUserId, transaction });

  const resetUrl = await issueResetToken(created, { transaction });

  await recordAudit(
    {
      tenantId,
      entityType: 'User',
      entityId: created.id,
      action: role === ROLES.SUPERVISOR ? 'SUPERVISOR_CREATED' : 'USER_CREATED',
      after: { name, email, role, siteIds, managerId },
      performedBy: actingUserId,
    },
    { transaction }
  );

  return { user: created, resetUrl, name, email, role };
}

async function createMember({ tenantId, actingUserId, payload, defaultRole = null }) {
  const { user, resetUrl, name, email, role } = await sequelize.transaction((transaction) =>
    createMemberRecord({ tenantId, actingUserId, payload, defaultRole, transaction })
  );

  await sendInvite({ tenantId, to: email, name, role, resetUrl });
  return describeMember(user.id);
}

async function updateMember({ tenantId, actingUserId, memberId, payload, defaultRole = null }) {
  const name = requireText(payload.name, 'Name', { max: 150 });
  const email = requireEmail(payload.email);
  const handoverPasswordHash = await unusablePasswordHash();

  const { resetUrl, role, id } = await sequelize.transaction(async (transaction) => {
    const member = await findMember(tenantId, memberId, { transaction, lock: transaction.LOCK.UPDATE });
    const role = readRole(payload.role ?? defaultRole ?? member.role);
    const siteIds = await readSiteIds(tenantId, role, payload, { transaction });
    const managerId = await readManager(tenantId, payload.managerId, { memberId: member.id, role, siteIds, transaction });

    await assertTeamStillCovered(tenantId, member, { nextRole: role, nextSiteIds: siteIds, transaction });

    const emailChanged = email !== member.email;
    if (emailChanged && (await User.findOne({ where: { email }, transaction }))) {
      throw AppError.conflict('An account with this email already exists');
    }

    const beforeSites = (await siteIdsByUser([member], { transaction })).get(member.id);
    const before = { name: member.name, email: member.email, role: member.role, siteIds: beforeSites, managerId: member.managerId };
    const roleChanged = role !== member.role;

    const { siteId } = await saveSites(tenantId, member, role, siteIds, { actingUserId, transaction });
    await member.update(
      {
        name,
        email,
        role,
        siteId,
        managerId,
        // A new email or a new role signs the person out, so their next session carries what they may now do.
        ...(emailChanged ? { passwordHash: handoverPasswordHash } : {}),
        ...(emailChanged || roleChanged ? { sessionsRevokedAt: new Date() } : {}),
      },
      { transaction }
    );
    if (roleChanged) await clearUserOverrides(member.id, { transaction });

    const url = emailChanged ? await issueResetToken(member, { transaction }) : null;

    await recordAudit(
      {
        tenantId,
        entityType: 'User',
        entityId: member.id,
        action: member.role === ROLES.SUPERVISOR && !roleChanged ? 'SUPERVISOR_UPDATED' : 'USER_UPDATED',
        before,
        after: { name, email, role, siteIds, managerId },
        performedBy: actingUserId,
      },
      { transaction }
    );

    return { resetUrl: url, role, id: member.id };
  });

  if (resetUrl) await sendInvite({ tenantId, to: email, name, role, resetUrl });
  return describeMember(id);
}

async function setMemberStatus({ tenantId, actingUserId, memberId, status }) {
  if (!User.STATUSES.includes(status)) {
    throw AppError.badRequest(`Status must be one of: ${User.STATUSES.join(', ')}`);
  }

  const member = await findMember(tenantId, memberId);
  if (member.status === status) return describeMember(member.id);

  const before = { status: member.status };
  const isSupervisor = member.role === ROLES.SUPERVISOR;

  await sequelize.transaction(async (transaction) => {
    await member.update({ status }, { transaction });

    await recordAudit(
      {
        tenantId,
        entityType: 'User',
        entityId: member.id,
        action:
          status === 'active'
            ? isSupervisor ? 'SUPERVISOR_REACTIVATED' : 'USER_REACTIVATED'
            : isSupervisor ? 'SUPERVISOR_DEACTIVATED' : 'USER_DEACTIVATED',
        before,
        after: { status },
        performedBy: actingUserId,
      },
      { transaction }
    );
  });

  return describeMember(member.id);
}

async function changeMemberPassword({ tenantId, actingUserId, memberId, password }) {
  const newPassword = requirePassword(password);
  const member = await findMember(tenantId, memberId);
  const passwordHash = await bcrypt.hash(newPassword, env.bcryptSaltRounds);

  await sequelize.transaction(async (transaction) => {
    await member.update({ passwordHash, sessionsRevokedAt: new Date() }, { transaction });

    await PasswordResetToken.update({ usedAt: new Date() }, { where: { userId: member.id, usedAt: null }, transaction });

    await recordAudit(
      {
        tenantId,
        entityType: 'User',
        entityId: member.id,
        action: member.role === ROLES.SUPERVISOR ? 'SUPERVISOR_PASSWORD_CHANGED' : 'USER_PASSWORD_CHANGED',
        performedBy: actingUserId,
      },
      { transaction }
    );
  });

  return describeMember(member.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// A Site Manager's team: everyone who reports to them, directly or through another Site Manager.

async function listTeam({ tenantId, auth }) {
  const team = [];
  const seen = new Set([auth.userId]);
  let frontier = [auth.userId];

  for (let depth = 0; frontier.length && depth < MAX_REPORTING_DEPTH; depth += 1) {
    const reports = await User.findAll({ where: { tenantId, managerId: frontier }, order: [['name', 'ASC']] });
    const fresh = reports.filter((user) => !seen.has(user.id));
    fresh.forEach((user) => seen.add(user.id));
    team.push(...fresh);
    frontier = fresh.filter((user) => user.role === ROLES.SITE_MANAGER).map((user) => user.id);
  }

  const members = await toMembers(team);
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    roleLabel: member.roleLabel,
    status: member.status,
    siteIds: member.siteIds,
    managerId: member.managerId,
    lastLoginAt: member.lastLoginAt,
  }));
}

module.exports = {
  listOrganizationUsers,
  createMemberRecord,
  createMember,
  updateMember,
  setMemberStatus,
  changeMemberPassword,
  listTeam,
};
