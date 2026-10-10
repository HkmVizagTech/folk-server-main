'use strict';

const { Router } = require('express');

const router = Router();

router.use(require('./system.routes'));
router.use(require('./data.routes'));
router.use(require('./events.routes'));
router.use(require('./sadhana.routes'));
router.use(require('./seva.routes'));
router.use(require('./payments.routes'));
router.use(require('./uploads.routes'));
router.use(require('./admin.routes'));
router.use(require('./otp.routes'));
router.use(require('./broadcast.routes'));

module.exports = router;
