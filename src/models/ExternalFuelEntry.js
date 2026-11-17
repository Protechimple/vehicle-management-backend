const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const STORABLE_FUEL_TYPES = ['Diesel', 'Petrol'];
const CATEGORIES = ['CLIENT', 'GUEST', 'CONTRACTOR', 'OTHER'];
const STATUSES = ['active', 'archived'];

const toNumber = (value) => (value == null ? null : Number(value));

class ExternalFuelEntry extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      entryNumber: this.entryNumber,
      siteId: this.siteId,
      fuelType: this.fuelType,
      entryDate: this.entryDate,
      entryTime: this.entryTime ? String(this.entryTime).slice(0, 5) : null,
      vehicleNumber: this.vehicleNumber,
      vehicleName: this.vehicleName,
      category: this.category,
      partyName: this.partyName,
      driverName: this.driverName,
      driverMobile: this.driverMobile,
      quantity: Number(this.quantity),
      pricePerLitre: Number(this.pricePerLitre),
      amount: Number(this.amount),
      meterReading: toNumber(this.meterReading),
      authorisedBy: this.authorisedBy,
      referenceNumber: this.referenceNumber,
      notes: this.notes,
      ledgerEntryId: this.ledgerEntryId,
      reversalLedgerEntryId: this.reversalLedgerEntryId,
      status: this.status,
      archivedAt: this.archivedAt,
      createdBy: this.createdBy,
      updatedBy: this.updatedBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

ExternalFuelEntry.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      references: { model: 'tenants', key: 'tenant_id' },
    },
    entryNumber: { type: DataTypes.STRING(64), allowNull: false },
    siteId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'sites', key: 'id' },
    },
    fuelType: { type: DataTypes.ENUM(...STORABLE_FUEL_TYPES), allowNull: false },
    entryDate: { type: DataTypes.DATEONLY, allowNull: false },
    entryTime: { type: DataTypes.TIME, allowNull: true },
    vehicleNumber: { type: DataTypes.STRING(32), allowNull: false },
    vehicleName: { type: DataTypes.STRING(100), allowNull: true },
    category: { type: DataTypes.ENUM(...CATEGORIES), allowNull: false },
    partyName: { type: DataTypes.STRING(150), allowNull: false },
    driverName: { type: DataTypes.STRING(150), allowNull: true },
    driverMobile: { type: DataTypes.STRING(32), allowNull: true },
    quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
    pricePerLitre: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    meterReading: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    authorisedBy: { type: DataTypes.STRING(150), allowNull: true },
    referenceNumber: { type: DataTypes.STRING(64), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    ledgerEntryId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'fuel_stock_ledger', key: 'id' },
    },
    reversalLedgerEntryId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'fuel_stock_ledger', key: 'id' },
    },
    status: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'active' },
    archivedAt: { type: DataTypes.DATE, allowNull: true },
    archivedBy: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
    createdBy: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    updatedBy: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
  },
  {
    sequelize,
    modelName: 'ExternalFuelEntry',
    tableName: 'external_fuel_entries',
  }
);

ExternalFuelEntry.FUEL_TYPES = STORABLE_FUEL_TYPES;
ExternalFuelEntry.CATEGORIES = CATEGORIES;
ExternalFuelEntry.STATUSES = STATUSES;

module.exports = ExternalFuelEntry;
