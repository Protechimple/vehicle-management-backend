// Creates one organization (tenant) and its admin user.
//
// Reads these environment variables:
//   SEED_ORG_NAME        Organization name
//   SEED_ADMIN_NAME      Admin's full name
//   SEED_ADMIN_EMAIL     Admin's login email
//   SEED_ADMIN_PASSWORD  Admin's login password
//
// Safe to run repeatedly: if none are set it does nothing, and if the admin
// email already exists it skips. Runs automatically from `npm start`, so on
// Hostinger you set the variables, redeploy once, then remove
// SEED_ADMIN_PASSWORD.

const KEYS = ['SEED_ORG_NAME', 'SEED_ADMIN_NAME', 'SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'];

async function main() {
  const values = Object.fromEntries(KEYS.map((key) => [key, process.env[key]?.trim() ?? '']));
  const provided = KEYS.filter((key) => values[key] !== '');

  if (provided.length === 0) {
    console.log('Seed: no SEED_* variables set — skipping.');
    return;
  }

  if (provided.length < KEYS.length) {
    const missing = KEYS.filter((key) => values[key] === '');
    console.log(`Seed: skipping — missing ${missing.join(', ')}.`);
    return;
  }

  const { connectDatabase, disconnectDatabase } = require('../src/config/database');
  const authService = require('../src/services/auth.service');

  try {
    await connectDatabase();
    const { user, organization } = await authService.signUp({
      organizationName: values.SEED_ORG_NAME,
      name: values.SEED_ADMIN_NAME,
      email: values.SEED_ADMIN_EMAIL,
      password: values.SEED_ADMIN_PASSWORD,
    });
    console.log(
      `Seed: created organization "${organization.organizationName}" with admin ${user.email}.`
    );
  } catch (error) {
    if (error.statusCode === 409) {
      console.log(`Seed: admin ${values.SEED_ADMIN_EMAIL} already exists — skipping.`);
    } else {
      console.error(`Seed failed: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase().catch(() => {});
  }
}

main();
