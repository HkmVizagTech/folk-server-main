'use strict';

const { Router } = require('express');
const system = require('../controllers/system.controller');

const router = Router();

router.all('/ping', system.ping);
router.get('/health', system.health);
router.get('/', system.root);
// Admin-triggered single WhatsApp template message.
router.post('/notify', system.notify);

module.exports = router;
