const { DataTypes } = require('sequelize');

// Tyres belong to one site. A tyre transfer moves stored tyres (New or Spare Tyre Store) to another site,
// one row per transfer plus a "transferred" event in each tyre's history.

const EVENT_TYPES = ['purchased', 'added_spare', 'fitted', 'removed', 'puncture', 'remould_sent', 'remould_back', 'scrapped'];

const ref = (model, allowNull = false) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull,
  references: { model, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});

const enumSql = (values) => `ENUM(${values.map((v) => `'${v}'`).join(', ')})`;

async function up({ context: queryInterface }) {
  if (await queryInterface.tableExists('tyre_transfers')) {
    throw new Error('Table "tyre_transfers" already exists. Rename or drop it before running this migration.');
  }
  await queryInterface.createTable('tyre_transfers', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      references: { model: 'tenants', key: 'tenant_id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    transfer_number: { type: DataTypes.STRING(32), allowNull: false },
    from_site_id: ref('sites'),
    to_site_id: ref('sites'),
    transfer_date: { type: DataTypes.DATEONLY, allowNull: false },
    tyre_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    created_by: ref('users'),
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addConstraint('tyre_transfers', { type: 'unique', fields: ['tenant_id', 'transfer_number'], name: 'uq_tyre_transfers_tenant_number' });
  await queryInterface.addIndex('tyre_transfers', ['tenant_id', 'transfer_date'], { name: 'ix_tyre_transfers_date' });

  await queryInterface.sequelize.query(`ALTER TABLE tyre_events MODIFY event_type ${enumSql([...EVENT_TYPES, 'transferred'])} NOT NULL`);
  await queryInterface.addColumn('tyre_events', 'transfer_id', { ...ref('tyre_transfers', true), after: 'notes' });
}

// Tyres keep the site they were moved to; only the transfer records and their history rows are removed.
async function down({ context: queryInterface }) {
  await queryInterface.sequelize.query("DELETE FROM tyre_events WHERE event_type = 'transferred'");
  const [fks] = await queryInterface.sequelize.query(
    "SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tyre_events' AND COLUMN_NAME = 'transfer_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
  );
  for (const { name } of fks) await queryInterface.removeConstraint('tyre_events', name);
  await queryInterface.removeColumn('tyre_events', 'transfer_id');
  await queryInterface.sequelize.query(`ALTER TABLE tyre_events MODIFY event_type ${enumSql(EVENT_TYPES)} NOT NULL`);
  await queryInterface.dropTable('tyre_transfers');
}

module.exports = { up, down };
