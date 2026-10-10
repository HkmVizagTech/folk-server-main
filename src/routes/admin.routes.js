'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const { limits } = require('../middlewares/rateLimit');
const admin = require('../controllers/admin.controller');

const router = Router();

// Create or reset the shared `admin` login.
router.post('/createAdmin', limits.createAdmin, handleOnCall(admin.createAdmin));

module.exports = router;
