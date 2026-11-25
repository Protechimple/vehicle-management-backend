const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

class CentringEntryLine extends Model {}

CentringEntryLine.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    entryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'centring_entries', key: 'id' } },
    itemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'centring_items', key: 'id' } },
    direction: { type: DataTypes.ENUM('in', 'out'), allowNull: false, defaultValue: 'in' },
    quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    unitPrice: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
    taxPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  },
  { sequelize, modelName: 'CentringEntryLine', tableName: 'centring_entry_lines', timestamps: false }
);

module.exports = CentringEntryLine;
