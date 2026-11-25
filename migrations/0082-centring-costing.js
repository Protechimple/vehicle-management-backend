const { DataTypes } = require('sequelize');

// Costing for Centring Inventory.
// - Every item line now carries the rate it was valued at and its amount. Each item has one company-wide weighted
//   average rate: stock added at a rate (opening stock, purchases) moves it; everything else is valued at it.
// - A new entry type, "expense", records a cost at a site (transport, hire rent bills, repairs, labour, other).
// - amount: an expense's amount, or a transfer's transport cost (charged to the receiving site).
// - scrap_sale_amount: money received when material is scrapped; it is taken off that site's losses.

const TYPES = ['add', 'reduce', 'transfer'];
const enumSql = (values) => `ENUM(${values.map((v) => `'${v}'`).join(', ')})`;

async function up({ context: queryInterface }) {
  await queryInterface.addColumn('centring_entry_lines', 'rate', { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0 });
  await queryInterface.addColumn('centring_entry_lines', 'amount', { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });

  await queryInterface.sequelize.query(`ALTER TABLE centring_entries MODIFY entry_type ${enumSql([...TYPES, 'expense'])} NOT NULL`);
  await queryInterface.addColumn('centring_entries', 'expense_type', { type: DataTypes.STRING(60), allowNull: true, after: 'reason' });
  await queryInterface.addColumn('centring_entries', 'amount', { type: DataTypes.DECIMAL(14, 2), allowNull: true, after: 'expense_type' });
  await queryInterface.addColumn('centring_entries', 'scrap_sale_amount', { type: DataTypes.DECIMAL(14, 2), allowNull: true, after: 'amount' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'status', 'entry_type', 'entry_date'], { name: 'ix_centring_entries_tenant_status_type_date' });
}

// Expense entries have no place without this migration, so they are removed with it.
async function down({ context: queryInterface }) {
  await queryInterface.removeIndex('centring_entries', 'ix_centring_entries_tenant_status_type_date');
  await queryInterface.sequelize.query("DELETE FROM centring_entries WHERE entry_type = 'expense'");
  await queryInterface.sequelize.query(`ALTER TABLE centring_entries MODIFY entry_type ${enumSql(TYPES)} NOT NULL`);
  await queryInterface.removeColumn('centring_entries', 'scrap_sale_amount');
  await queryInterface.removeColumn('centring_entries', 'amount');
  await queryInterface.removeColumn('centring_entries', 'expense_type');
  await queryInterface.removeColumn('centring_entry_lines', 'amount');
  await queryInterface.removeColumn('centring_entry_lines', 'rate');
}

module.exports = { up, down };
