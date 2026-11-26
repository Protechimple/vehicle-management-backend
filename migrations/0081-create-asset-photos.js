const { DataTypes } = require('sequelize');

async function up({ context: queryInterface }) {
  await queryInterface.createTable('asset_photos', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      references: { model: 'tenants', key: 'tenant_id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    asset_type: { type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull: false },
    asset_id: { type: DataTypes.STRING(64), allowNull: false },
    original_filename: { type: DataTypes.STRING(255), allowNull: false },
    stored_filename: { type: DataTypes.STRING(500), allowNull: false },
    thumb_filename: { type: DataTypes.STRING(500), allowNull: false },
    mime_type: { type: DataTypes.STRING(100), allowNull: false },
    file_size: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    is_cover: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sort_order: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    uploaded_by: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addIndex('asset_photos', ['tenant_id', 'asset_type', 'asset_id'], {
    name: 'ix_asset_photos_tenant_asset',
  });
}

async function down({ context: queryInterface }) {
  await queryInterface.dropTable('asset_photos');
}

module.exports = { up, down };
