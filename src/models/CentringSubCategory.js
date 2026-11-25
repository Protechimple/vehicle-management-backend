const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const CentringCategory = require('./CentringCategory');

class CentringSubCategory extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      categoryId: this.categoryId,
      categoryName: this.category?.categoryName ?? null,
      subCategoryName: this.subCategoryName,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

CentringSubCategory.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'centring_categories', key: 'id' } },
    subCategoryName: { type: DataTypes.STRING(100), allowNull: false },
    ...CentringCategory.auditColumns(),
  },
  { sequelize, modelName: 'CentringSubCategory', tableName: 'centring_sub_categories' }
);

CentringSubCategory.STATUSES = CentringCategory.STATUSES;

module.exports = CentringSubCategory;
