// Some databases carry a CHECK constraint `chk_users_site_matches_role` on users that was added by hand (no migration
// created it). It only allows an Admin with no site or a Supervisor with a site, so it rejects every Site Manager and
// Inventory Supervisor (0077) and any site user with several sites, whose users.site_id is empty (0078).
// Which sites a user covers is decided by the app and kept in user_sites, so the constraint is dropped where present.

const NAME = 'chk_users_site_matches_role';

async function up({ context: queryInterface }) {
  const { sequelize } = queryInterface;
  const [rows] = await sequelize.query(
    `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
        AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = :name`,
    { replacements: { name: NAME } }
  );
  if (rows.length) await sequelize.query(`ALTER TABLE users DROP CHECK ${NAME}`);
}

// Nothing to restore: the constraint never came from a migration, and putting it back would reject valid users.
async function down() {}

module.exports = { up, down };
