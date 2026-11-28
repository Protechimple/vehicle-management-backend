const assetPhotoService = require('../services/assetPhoto.service');
const storage = require('../services/storage.service');

function target(req) {
  return {
    tenantId: req.auth.tenantId,
    auth: req.auth,
    assetType: req.params.assetType?.toUpperCase(),
    assetId: req.params.assetId,
  };
}

async function list(req, res) {
  const { data, maxPhotos } = await assetPhotoService.listPhotos(target(req));
  res.status(200).json({ data, maxPhotos, message: 'Photos retrieved' });
}

async function upload(req, res) {
  const data = await assetPhotoService.uploadPhoto({
    ...target(req),
    actingUserId: req.auth.userId,
    photo: req.files?.photo?.[0],
    thumb: req.files?.thumb?.[0],
  });
  res.status(201).json({ data, message: 'Photo uploaded' });
}

async function setCover(req, res) {
  const data = await assetPhotoService.setCoverPhoto({
    ...target(req),
    photoId: req.params.photoId,
    actingUserId: req.auth.userId,
  });
  res.status(200).json({ data, message: 'Cover photo updated' });
}

async function remove(req, res) {
  await assetPhotoService.deletePhoto({ ...target(req), photoId: req.params.photoId, actingUserId: req.auth.userId });
  res.status(200).json({ data: null, message: 'Photo deleted' });
}

async function file(req, res) {
  const { key, mimeType } = await assetPhotoService.getPhotoFile({
    ...target(req),
    photoId: req.params.photoId,
    size: req.query.size === 'thumb' ? 'thumb' : 'full',
  });

  res.setHeader('Content-Type', mimeType);
  // A photo's stored file never changes (a new upload gets a new id), so the browser may keep it.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const stream = storage.readFileStream(key);
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: 'Photo file not found' });
    else res.destroy();
  });
  stream.pipe(res);
}

module.exports = { list, upload, setCover, remove, file };
