const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const CentringCategory = require('./CentringCategory');

class CentringItem extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      categoryId: this.categoryId,
      categoryName: this.category?.categoryName ?? null,
      subCategoryId: this.subCategoryId,
      subCategoryName: this.subCategory?.subCategoryName ?? null,
      itemName: this.itemName,
      unit: this.unit,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

CentringItem.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'centring_categories', key: 'id' } },
    subCategoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'centring_sub_categories', key: 'id' } },
    itemName: { type: DataTypes.STRING(150), allowNull: false },
    unit: { type: DataTypes.STRING(20), allowNull: false },
    ...CentringCategory.auditColumns(),
  },
  { sequelize, modelName: 'CentringItem', tableName: 'centring_items' }
);

CentringItem.STATUSES = CentringCategory.STATUSES;

module.exports = CentringItem;
