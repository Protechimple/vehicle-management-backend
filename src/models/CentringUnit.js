const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const CentringCategory = require('./CentringCategory');

// A unit of measure the organization adds for its centring items, e.g. Nos, Sqm, Rmt. An item keeps the unit's name.
class CentringUnit extends Model {
  toPublicJSON() {
    return { id: this.id, unitName: this.unitName, status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt };
  }
}

CentringUnit.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    unitName: { type: DataTypes.STRING(20), allowNull: false },
    ...CentringCategory.auditColumns(),
  },
  { sequelize, modelName: 'CentringUnit', tableName: 'centring_units' }
);

CentringUnit.STATUSES = CentringCategory.STATUSES;

module.exports = CentringUnit;
