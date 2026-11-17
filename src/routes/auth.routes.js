const express = require('express');
const authController = require('../controllers/auth.controller');
const passwordResetController = require('../controllers/passwordReset.controller');
const { authenticated } = require('../middleware/authorize');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/login', authLimiter, authController.logIn);

router.post('/forgot-password', authLimiter, passwordResetController.requestReset);

router.get('/reset-password', authLimiter, passwordResetController.checkToken);

router.post('/reset-password', authLimiter, passwordResetController.resetPassword);

router.post('/logout', authenticated, authController.logOut);

router.get('/me', authenticated, authController.me);

module.exports = router;
