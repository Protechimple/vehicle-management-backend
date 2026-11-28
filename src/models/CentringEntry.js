const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const STATUSES = ['active', 'archived'];
const TYPES = ['purchase', 'issue', 'transfer', 'adjustment'];

// Each kind of entry gets its own numbering, as in the Inventory module.
const PREFIXES = { purchase: 'CPUR-', issue: 'CISS-', transfer: 'CTRF-', adjustment: 'CADJ-' };

// Why an adjustment was made. A stock count sets the stock to what was counted; the others take material away.
const ADJUSTMENT_REASONS = ['Lost', 'Damaged', 'Scrapped', 'Stock count'];

class CentringEntry extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      entryNumber: this.entryNumber,
      entryType: this.entryType,
      entryDate: this.entryDate,
      fromSiteId: this.fromSiteId,
      toSiteId: this.toSiteId,
      supplierId: this.supplierId,
      billNumber: this.billNumber,
      reason: this.reason,
      purpose: this.purpose,
      issuedTo: this.issuedTo,
      remarks: this.remarks,
      totalAmount: Number(this.totalAmount),
      status: this.status,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
    };
  }
}

CentringEntry.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    entryNumber: { type: DataTypes.STRING(32), allowNull: false },
    entryType: { type: DataTypes.ENUM(...TYPES), allowNull: false },
    entryDate: { type: DataTypes.DATEONLY, allowNull: false },
    fromSiteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'sites', key: 'id' } },
    toSiteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    supplierId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'centring_suppliers', key: 'id' } },
    billNumber: { type: DataTypes.STRING(60), allowNull: true },
    reason: { type: DataTypes.STRING(40), allowNull: true },
    purpose: { type: DataTypes.STRING(255), allowNull: true },
    issuedTo: { type: DataTypes.STRING(150), allowNull: true },
    remarks: { type: DataTypes.STRING(1000), allowNull: true },
    totalAmount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'active' },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    archivedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'users', key: 'id' } },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'CentringEntry', tableName: 'centring_entries' }
);

CentringEntry.STATUSES = STATUSES;
CentringEntry.TYPES = TYPES;
CentringEntry.PREFIXES = PREFIXES;
CentringEntry.ADJUSTMENT_REASONS = ADJUSTMENT_REASONS;

module.exports = CentringEntry;
