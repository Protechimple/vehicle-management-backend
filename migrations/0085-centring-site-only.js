const { DataTypes } = require('sequelize');

// Centring Inventory without a Main Store (the organization's choice): everything is held at sites.
//   purchase   — bought into a site (to_site_id)
//   issue      — taken out of a site's stock (to_site_id) for a purpose; its lines are "out"
//   transfer   — from one site (from_site_id) to another (to_site_id)
//   adjustment — at a site (to_site_id)
// So every entry now has a site in to_site_id. Entries that used the Main Store are removed (the organization had one
// test purchase there and asked for it to be deleted), as are old-style issues, which left the Main Store.

const TYPES_SQL = "ENUM('purchase', 'issue', 'transfer', 'adjustment')";

async function up({ context: queryInterface }) {
  const sql = (text) => queryInterface.sequelize.query(text);
  await sql(
    "DELETE l FROM centring_entry_lines l JOIN centring_entries e ON e.id = l.entry_id WHERE e.to_site_id IS NULL OR e.entry_type IN ('issue', 'site_issue')"
  );
  await sql("DELETE FROM centring_entries WHERE to_site_id IS NULL OR entry_type IN ('issue', 'site_issue')");

  // An abandoned attempt (migration "0085-centring-site-issue", whose file no longer exists) added a "site_issue" type
  // and a used_for column to some databases, and nothing uses them. They are removed, along with its record, so every
  // database ends up the same.
  const columns = await queryInterface.describeTable('centring_entries');
  if (columns.used_for) await queryInterface.removeColumn('centring_entries', 'used_for');
  await sql(`ALTER TABLE centring_entries MODIFY entry_type ${TYPES_SQL} NOT NULL`);
  await sql("DELETE FROM schema_migrations WHERE name = '0085-centring-site-issue.js'");

  await queryInterface.addColumn('centring_entries', 'purpose', { type: DataTypes.STRING(255), allowNull: true, after: 'reason' });

  // to_site_id becomes required. Its foreign key has to come off while the column changes.
  const [fks] = await sql(
    "SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'centring_entries' AND COLUMN_NAME = 'to_site_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
  );
  for (const { name } of fks) await queryInterface.removeConstraint('centring_entries', name);
  await queryInterface.changeColumn('centring_entries', 'to_site_id', { type: DataTypes.INTEGER.UNSIGNED, allowNull: false });
  await queryInterface.addConstraint('centring_entries', {
    type: 'foreign key',
    fields: ['to_site_id'],
    name: 'fk_centring_entries_to_site',
    references: { table: 'sites', field: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  });
}

// The removed Main Store entries cannot come back; the columns go back to how they were.
async function down({ context: queryInterface }) {
  await queryInterface.removeConstraint('centring_entries', 'fk_centring_entries_to_site');
  await queryInterface.changeColumn('centring_entries', 'to_site_id', { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
  await queryInterface.addConstraint('centring_entries', {
    type: 'foreign key',
    fields: ['to_site_id'],
    name: 'fk_centring_entries_to_site',
    references: { table: 'sites', field: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  });
  await queryInterface.removeColumn('centring_entries', 'purpose');
}

module.exports = { up, down };
