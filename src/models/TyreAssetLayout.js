const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

// Tyres per axle that can be chosen: 1 (centre), 2 (single wheels), 4 (dual wheels).
const TYRES_PER_AXLE = [1, 2, 4];
const MAX_AXLES = 8;

const SIDES = {
  1: ['Centre'],
  2: ['Left', 'Right'],
  4: ['Left Outer', 'Left Inner', 'Right Inner', 'Right Outer'],
};

function parseAxles(text) {
  return String(text ?? '')
    .split(',')
    .map((n) => Number(n))
    .filter((n) => TYRES_PER_AXLE.includes(n));
}

// [{ axle: 1, positions: ['Axle 1 Left', 'Axle 1 Right'] }, ...]
function positionsFor(axles) {
  return axles.map((count, index) => ({ axle: index + 1, positions: SIDES[count].map((side) => `Axle ${index + 1} ${side}`) }));
}

class TyreAssetLayout extends Model {
  get axleList() {
    return parseAxles(this.axles);
  }

  toPublicJSON() {
    const axles = this.axleList;
    return {
      assetType: this.assetType,
      assetId: this.assetId,
      axles,
      tyreCount: axles.reduce((t, n) => t + n, 0),
      layout: positionsFor(axles),
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      updatedBy: this.updatedBy,
      updatedAt: this.updatedAt,
    };
  }
}

TyreAssetLayout.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    assetType: { type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull: false },
    assetId: { type: DataTypes.STRING(64), allowNull: false },
    axles: { type: DataTypes.STRING(64), allowNull: false },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
    updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'TyreAssetLayout', tableName: 'tyre_asset_layouts' }
);

TyreAssetLayout.TYRES_PER_AXLE = TYRES_PER_AXLE;
TyreAssetLayout.MAX_AXLES = MAX_AXLES;
TyreAssetLayout.positionsFor = positionsFor;
TyreAssetLayout.parseAxles = parseAxles;

module.exports = TyreAssetLayout;
