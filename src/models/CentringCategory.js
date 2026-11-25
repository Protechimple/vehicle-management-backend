const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const STATUSES = ['active', 'archived'];

const auditColumns = () => ({
  status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'active' },
  archivedAt: { type: DataTypes.DATE, allowNull: true },
  archivedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'users', key: 'id' } },
  createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
});

class CentringCategory extends Model {
  toPublicJSON() {
    return { id: this.id, categoryName: this.categoryName, status: this.status, createdAt: this.createdAt, updatedAt: this.updatedAt };
  }
}

CentringCategory.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    categoryName: { type: DataTypes.STRING(100), allowNull: false },
    ...auditColumns(),
  },
  { sequelize, modelName: 'CentringCategory', tableName: 'centring_categories' }
);

CentringCategory.STATUSES = STATUSES;
CentringCategory.auditColumns = auditColumns;

module.exports = CentringCategory;
