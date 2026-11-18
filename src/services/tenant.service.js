const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const env = require('../config/env');
const { ROLES } = require('../config/permissions');
const { sequelize, Tenant, User } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, requireEmail, requirePassword, optionalText, optionalPhone } = require('../utils/validation');
const { recordAudit } = require('./audit.service');

function generateTenantId() {
  return `tenant_${crypto.randomBytes(12).toString('hex')}`;
}

function readOrganizationInput(input) {
  return {
    organizationName: requireText(input?.organizationName, 'Organization name', { max: 150 }),
    email: requireEmail(input?.email),
    phone: optionalPhone(input?.phone),
    address: optionalText(input?.address, 'Address', { max: 500 }),
  };
}

// Who made a platform-level change. `performed_by` points at `users`, so a Super Admin is recorded here instead.
function platformActor(platformAdmin) {
  return { performedByPlatformAdmin: { id: platformAdmin.id, email: platformAdmin.email } };
}

async function assertEmailFree(email, { transaction } = {}) {
  if (await User.findOne({ where: { email }, transaction })) {
    throw AppError.conflict(`An account with this email already exists: ${email}`);
  }
}

/**
 * Creates an organization and its one admin. The admin signs in with the temporary password
 * and must replace it before using the app.
 */
async function createTenantWithAdmin({ organization, admin, platformAdmin }) {
  const adminName = requireText(admin?.name, 'Admin name', { max: 150 });
  const adminEmail = requireEmail(admin?.email);
  // The organization's contact email starts as its admin's email; it can be changed later.
  const cleanOrganization = readOrganizationInput({ ...organization, email: organization?.email || adminEmail });
  const temporaryPassword = requirePassword(admin?.password);

  await assertEmailFree(adminEmail);

  const passwordHash = await bcrypt.hash(temporaryPassword, env.bcryptSaltRounds);
  const tenantId = generateTenantId();

  await sequelize.transaction(async (transaction) => {
    await Tenant.create({ tenantId, ...cleanOrganization, status: 'active' }, { transaction });

    const createdAdmin = await User.create(
      {
        tenantId,
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: ROLES.ADMIN,
        status: 'active',
        mustChangePassword: true,
      },
      { transaction }
    );

    await recordAudit(
      {
        tenantId,
        entityType: 'Tenant',
        entityId: tenantId,
        action: 'ORGANIZATION_CREATED',
        after: {
          ...cleanOrganization,
          adminId: createdAdmin.id,
          adminEmail,
          ...platformActor(platformAdmin),
        },
      },
      { transaction }
    );
  });

  return tenantId;
}

module.exports = { generateTenantId, readOrganizationInput, platformActor, assertEmailFree, createTenantWithAdmin };
