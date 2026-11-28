const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const CentringCategory = require('./CentringCategory');

class CentringSupplier extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      supplierName: this.supplierName,
      contactPerson: this.contactPerson,
      phone: this.phone,
      gstNumber: this.gstNumber,
      address: this.address,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

CentringSupplier.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    supplierName: { type: DataTypes.STRING(150), allowNull: false },
    contactPerson: { type: DataTypes.STRING(100), allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    gstNumber: { type: DataTypes.STRING(20), allowNull: true },
    address: { type: DataTypes.STRING(500), allowNull: true },
    ...CentringCategory.auditColumns(),
  },
  { sequelize, modelName: 'CentringSupplier', tableName: 'centring_suppliers' }
);

CentringSupplier.STATUSES = CentringCategory.STATUSES;

module.exports = CentringSupplier;
