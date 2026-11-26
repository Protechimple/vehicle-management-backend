const path = require('node:path');

const { sequelize, AssetPhoto, User } = require('../models');
const AppError = require('../utils/AppError');
const { resolveAsset } = require('./asset.service');
const { recordAudit, recordCreate, recordUpdate } = require('./audit.service');
const storage = require('./storage.service');

const MAX_FILENAME_LENGTH = 255;
const MIME_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

function shortenedFilename(filename) {
  const characters = [...(filename || 'photo')];
  if (characters.length <= MAX_FILENAME_LENGTH) return characters.join('');
  const extension = [...path.extname(filename)];
  return [...characters.slice(0, MAX_FILENAME_LENGTH - extension.length), ...extension].join('');
}

// The browser may send the resized image as "blob", so the stored name takes its extension from the type.
function storageName(label, file) {
  return `${label}${MIME_EXTENSIONS[file.mimetype] ?? path.extname(file.originalname ?? '')}`;
}

const ORDER = [
  ['isCover', 'DESC'],
  ['sortOrder', 'ASC'],
  ['id', 'ASC'],
];

function toPublic(photo) {
  return photo.toPublicJSON();
}

async function listPhotos({ tenantId, auth, assetType, assetId }) {
  await resolveAsset(tenantId, assetType, assetId, { auth });
  const photos = await AssetPhoto.findAll({
    where: { tenantId, assetType, assetId },
    include: [{ model: User, as: 'uploader', attributes: ['id', 'name'] }],
    order: ORDER,
  });
  return { data: photos.map(toPublic), maxPhotos: AssetPhoto.MAX_PER_ASSET };
}

async function uploadPhoto({ tenantId, auth, assetType, assetId, actingUserId, photo, thumb }) {
  if (!photo) throw AppError.badRequest('A photo is required');
  // A thumbnail is optional: without one the full image is served for both sizes.
  const thumbnail = thumb ?? photo;

  await resolveAsset(tenantId, assetType, assetId, { auth });

  const photoKey = storage.buildKey(tenantId, assetType, assetId, 'PHOTO', storageName('photo', photo));
  const thumbKey = thumb
    ? storage.buildKey(tenantId, assetType, assetId, 'PHOTO-THUMB', storageName('thumb', thumbnail))
    : photoKey;
  const savedKeys = [];

  try {
    await storage.saveFile(photoKey, photo.buffer);
    savedKeys.push(photoKey);
    if (thumbKey !== photoKey) {
      await storage.saveFile(thumbKey, thumbnail.buffer);
      savedKeys.push(thumbKey);
    }

    const saved = await sequelize.transaction(async (transaction) => {
      // Locking the asset makes simultaneous uploads take turns, so the limit and the single cover hold.
      await resolveAsset(tenantId, assetType, assetId, { auth, transaction, lock: transaction.LOCK.UPDATE });

      const existing = await AssetPhoto.findAll({
        where: { tenantId, assetType, assetId },
        attributes: ['id', 'isCover', 'sortOrder'],
        transaction,
      });
      if (existing.length >= AssetPhoto.MAX_PER_ASSET) {
        throw AppError.conflict(`An asset can have at most ${AssetPhoto.MAX_PER_ASSET} photos. Delete one to add another.`);
      }

      const created = await AssetPhoto.create(
        {
          tenantId,
          assetType,
          assetId,
          originalFilename: shortenedFilename(photo.originalname),
          storedFilename: photoKey,
          thumbFilename: thumbKey,
          mimeType: photo.mimetype,
          fileSize: photo.size,
          isCover: !existing.some((p) => p.isCover),
          sortOrder: Math.max(0, ...existing.map((p) => p.sortOrder)) + 1,
          uploadedBy: actingUserId,
        },
        { transaction }
      );

      await recordCreate(
        { tenantId, entityType: 'AssetPhoto', entityId: created.id, performedBy: actingUserId, after: created },
        { transaction }
      );
      return created;
    });

    const withUploader = await AssetPhoto.findByPk(saved.id, {
      include: [{ model: User, as: 'uploader', attributes: ['id', 'name'] }],
    });
    return toPublic(withUploader);
  } catch (error) {
    await Promise.all(savedKeys.map((key) => storage.deleteFile(key).catch(() => {})));
    throw error;
  }
}

async function findPhoto({ tenantId, assetType, assetId, photoId, transaction, lock }) {
  const photo = await AssetPhoto.findOne({ where: { id: photoId, tenantId, assetType, assetId }, transaction, lock });
  if (!photo) throw AppError.notFound('Photo not found');
  return photo;
}

async function setCoverPhoto({ tenantId, auth, assetType, assetId, photoId, actingUserId }) {
  const saved = await sequelize.transaction(async (transaction) => {
    await resolveAsset(tenantId, assetType, assetId, { auth, transaction, lock: transaction.LOCK.UPDATE });
    const photo = await findPhoto({ tenantId, assetType, assetId, photoId, transaction });
    if (photo.isCover) return photo;

    await AssetPhoto.update(
      { isCover: false },
      { where: { tenantId, assetType, assetId, isCover: true }, transaction }
    );
    const before = photo.toJSON();
    await photo.update({ isCover: true }, { transaction });
    await recordUpdate(
      { tenantId, entityType: 'AssetPhoto', entityId: photo.id, performedBy: actingUserId, before, after: photo },
      { transaction }
    );
    return photo;
  });
  return toPublic(saved);
}

async function deletePhoto({ tenantId, auth, assetType, assetId, photoId, actingUserId }) {
  await sequelize.transaction(async (transaction) => {
    await resolveAsset(tenantId, assetType, assetId, { auth, transaction, lock: transaction.LOCK.UPDATE });
    const photo = await findPhoto({ tenantId, assetType, assetId, photoId, transaction });
    const before = photo.toJSON();
    const keys = [...new Set([photo.storedFilename, photo.thumbFilename])];

    await photo.destroy({ transaction });

    // The asset keeps a cover while it has photos: the next one in order takes over.
    if (photo.isCover) {
      const next = await AssetPhoto.findOne({ where: { tenantId, assetType, assetId }, order: ORDER, transaction });
      if (next) await next.update({ isCover: true }, { transaction });
    }

    await recordAudit(
      { tenantId, entityType: 'AssetPhoto', entityId: photo.id, action: 'DELETED', before, performedBy: actingUserId },
      { transaction }
    );

    transaction.afterCommit(() => {
      for (const key of keys) storage.deleteFile(key).catch(() => {});
    });
  });
}

async function getPhotoFile({ tenantId, auth, assetType, assetId, photoId, size }) {
  await resolveAsset(tenantId, assetType, assetId, { auth });
  const photo = await findPhoto({ tenantId, assetType, assetId, photoId });
  const useThumb = size === 'thumb';
  return {
    key: useThumb ? photo.thumbFilename : photo.storedFilename,
    // The thumbnail is always written as an image the browser made; its type follows its extension.
    mimeType: useThumb && photo.thumbFilename !== photo.storedFilename ? mimeOfKey(photo.thumbFilename) : photo.mimeType,
  };
}

function mimeOfKey(key) {
  const extension = path.extname(key).toLowerCase();
  return Object.entries(MIME_EXTENSIONS).find(([, ext]) => ext === extension)?.[0] ?? 'image/jpeg';
}

module.exports = { listPhotos, uploadPhoto, setCoverPhoto, deletePhoto, getPhotoFile };
