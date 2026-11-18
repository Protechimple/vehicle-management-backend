// Creates one organization (tenant) and its admin user.
//
// Reads these environment variables:
//   SEED_ORG_NAME        Organization name
//   SEED_ADMIN_NAME      Admin's full name
//   SEED_ADMIN_EMAIL     Admin's login email
//   SEED_ADMIN_PASSWORD  Admin's login password
//
// Safe to run repeatedly: if none are set it does nothing, and if the admin
// email already exists it skips. In production the server runs it on startup
// (see src/server.js), so on Hostinger you set the variables, redeploy once,
// then remove SEED_ADMIN_PASSWORD. Locally: `npm run seed`.

const KEYS = ['SEED_ORG_NAME', 'SEED_ADMIN_NAME', 'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'];

// Expects the database to be connected already. Throws on unexpected errors.
async function seedOrganizationFromEnv(log = console.log) {
  const values = Object.fromEntries(KEYS.map((key) => [key, process.env[key]?.trim() ?? '']));
  const provided = KEYS.filter((key) => values[key] !== '');

  if (provided.length === 0) {
    log('Seed: no SEED_* variables set — skipping.');
    return;
  }

  if (provided.length < KEYS.length) {
    const missing = KEYS.filter((key) => values[key] === '');
    log(`Seed: skipping — missing ${missing.join(', ')}.`);
    return;
  }

  const authService = require('../src/services/auth.service');

  try {
    const { user, organization } = await authService.signUp({
      organizationName: values.SEED_ORG_NAME,
      name: values.SEED_ADMIN_NAME,
      email: values.SEED_ADMIN_EMAIL,
      password: values.SEED_ADMIN_PASSWORD,
    });
    log(`Seed: created organization "${organization.organizationName}" with admin ${user.email}.`);
  } catch (error) {
    if (error.statusCode === 409) {
      log(`Seed: admin ${values.SEED_ADMIN_EMAIL} already exists — skipping.`);
      return;
    }
    throw error;
  }
}

async function main() {
  const { connectDatabase, disconnectDatabase } = require('../src/config/database');
  try {
    await connectDatabase();
    await seedOrganizationFromEnv();
  } catch (error) {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { seedOrganizationFromEnv };
