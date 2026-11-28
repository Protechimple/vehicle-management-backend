const express = require('express');
const assetPhotoController = require('../controllers/assetPhoto.controller');
const { authenticated, requirePermission } = require('../middleware/authorize');
const { validateIdParam } = require('../middleware/idParam');
const { uploadAssetPhoto } = require('../middleware/upload');

const router = express.Router();

router.use(authenticated);
router.param('photoId', validateIdParam('Photo not found'));

// Photos follow the asset-document permissions: whoever may see or add an asset's documents may do the same with its photos.
router.get('/:assetType/:assetId', requirePermission('DOCUMENT', 'READ'), assetPhotoController.list);

router.post('/:assetType/:assetId', requirePermission('DOCUMENT', 'CREATE'), uploadAssetPhoto, assetPhotoController.upload);

router.get('/:assetType/:assetId/:photoId/file', requirePermission('DOCUMENT', 'READ'), assetPhotoController.file);

router.put('/:assetType/:assetId/:photoId/cover', requirePermission('DOCUMENT', 'CREATE'), assetPhotoController.setCover);

router.delete('/:assetType/:assetId/:photoId', requirePermission('DOCUMENT', 'CREATE'), assetPhotoController.remove);

module.exports = router;
