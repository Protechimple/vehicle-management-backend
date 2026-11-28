const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const ASSET_TYPES = ['VEHICLE', 'MACHINERY'];
const MAX_PER_ASSET = 10;

class AssetPhoto extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      assetType: this.assetType,
      assetId: this.assetId,
      originalFilename: this.originalFilename,
      mimeType: this.mimeType,
      fileSize: this.fileSize,
      isCover: Boolean(this.isCover),
      sortOrder: this.sortOrder,
      uploadedBy: this.uploadedBy,
      uploadedByName: this.uploader ? this.uploader.name : undefined,
      createdAt: this.createdAt,
    };
  }
}

AssetPhoto.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: {
      type: DataTypes.STRING(64),
      allowNull: false,
      references: { model: 'tenants', key: 'tenant_id' },
    },
    assetType: { type: DataTypes.ENUM(...ASSET_TYPES), allowNull: false },
    assetId: { type: DataTypes.STRING(64), allowNull: false },
    originalFilename: { type: DataTypes.STRING(255), allowNull: false },
    storedFilename: { type: DataTypes.STRING(500), allowNull: false },
    thumbFilename: { type: DataTypes.STRING(500), allowNull: false },
    mimeType: { type: DataTypes.STRING(100), allowNull: false },
    fileSize: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    isCover: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    sortOrder: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    uploadedBy: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
  },
  {
    sequelize,
    modelName: 'AssetPhoto',
    tableName: 'asset_photos',
  }
);

AssetPhoto.ASSET_TYPES = ASSET_TYPES;
AssetPhoto.MAX_PER_ASSET = MAX_PER_ASSET;

module.exports = AssetPhoto;
