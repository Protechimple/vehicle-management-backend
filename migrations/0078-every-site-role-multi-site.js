// Supervisors and Inventory Supervisors may now work at several sites, like Site Managers. Every site role's sites
// are kept in user_sites, so the one site each existing user had is copied there.
async function up({ context: queryInterface }) {
  await queryInterface.sequelize.query(`
    INSERT INTO user_sites (tenant_id, user_id, site_id, created_by, created_at, updated_at)
    SELECT u.tenant_id, u.id, u.site_id,
           (SELECT a.id FROM users a WHERE a.tenant_id = u.tenant_id AND a.role = 'admin' LIMIT 1),
           NOW(), NOW()
      FROM users u
     WHERE u.role IN ('supervisor', 'inventory_supervisor') AND u.site_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = u.site_id)
  `);
}

// Only someone left with a single site can go back to the one-site model.
async function down({ context: queryInterface }) {
  const [[{ count }]] = await queryInterface.sequelize.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT us.user_id FROM user_sites us JOIN users u ON u.id = us.user_id
       WHERE u.role IN ('supervisor', 'inventory_supervisor') GROUP BY us.user_id HAVING COUNT(*) > 1) multi`);
  if (Number(count) > 0) {
    throw new Error(`${count} Supervisor(s) or Inventory Supervisor(s) have several sites. Reduce them to one before undoing this migration.`);
  }
  await queryInterface.sequelize.query(`
    DELETE us FROM user_sites us JOIN users u ON u.id = us.user_id WHERE u.role IN ('supervisor', 'inventory_supervisor')`);
}

module.exports = { up, down };
