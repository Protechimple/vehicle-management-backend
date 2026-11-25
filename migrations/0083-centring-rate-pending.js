const { DataTypes } = require('sequelize');

// A purchase (or a count of new material) saved without its rate is valued at the item's average rate and marked
// rate_pending, so the Admin or a Site Manager can enter the real rate later.

async function up({ context: queryInterface }) {
  await queryInterface.addColumn('centring_entries', 'rate_pending', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, after: 'scrap_sale_amount' });
}

async function down({ context: queryInterface }) {
  await queryInterface.removeColumn('centring_entries', 'rate_pending');
}

module.exports = { up, down };
