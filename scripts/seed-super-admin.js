// Creates one Super Admin (platform admin) from environment variables.
//
// Reads these environment variables:
//   SEED_SUPER_ADMIN_NAME      Super Admin's full name
//   SEED_SUPER_ADMIN_EMAIL     Super Admin's login email
//   SEED_SUPER_ADMIN_PASSWORD  Super Admin's login password (min 8 characters)
//
// Safe to run repeatedly: if none are set it does nothing, and if the email
// already exists it skips (an existing password is never changed). In
// production the server runs it on startup (see src/server.js), so on Hostinger
// you set the variables, redeploy once, then remove SEED_SUPER_ADMIN_PASSWORD.
// Locally: `npm run seed:super-admin`.

const KEYS = ['SEED_SUPER_ADMIN_NAME', 'SEED_SUPER_ADMIN_EMAIL', 'SEED_SUPER_ADMIN_PASSWORD'];

// Expects the database to be connected already. Throws on unexpected errors.
async function seedSuperAdminFromEnv(log = console.log) {
  const values = Object.fromEntries(KEYS.map((key) => [key, process.env[key]?.trim() ?? '']));
  const provided = KEYS.filter((key) => values[key] !== '');

  if (provided.length === 0) {
    log('Super Admin seed: no SEED_SUPER_ADMIN_* variables set — skipping.');
    return;
  }

  if (provided.length < KEYS.length) {
    const missing = KEYS.filter((key) => values[key] === '');
    log(`Super Admin seed: skipping — missing ${missing.join(', ')}.`);
    return;
  }

  const bcrypt = require('bcryptjs');
  const env = require('../src/config/env');
  const { PlatformAdmin } = require('../src/models');
  const { requireText, requireEmail, requirePassword } = require('../src/utils/validation');

  const name = requireText(values.SEED_SUPER_ADMIN_NAME, 'SEED_SUPER_ADMIN_NAME', { max: 150 });
  const email = requireEmail(values.SEED_SUPER_ADMIN_EMAIL);
  const password = requirePassword(values.SEED_SUPER_ADMIN_PASSWORD);

  if (await PlatformAdmin.findOne({ where: { email } })) {
    log(`Super Admin seed: ${email} already exists — skipping.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, env.bcryptSaltRounds);
  await PlatformAdmin.create({ name, email, passwordHash, status: 'active' });
  log(`Super Admin seed: created ${email}.`);
}

async function main() {
  const { connectDatabase, disconnectDatabase } = require('../src/config/database');
  try {
    await connectDatabase();
    await seedSuperAdminFromEnv();
  } catch (error) {
    console.error(`Super Admin seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { seedSuperAdminFromEnv };
