'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const seva = require('../controllers/seva.controller');

const router = Router();

router.post('/createSeva', handleOnCall(seva.createSeva));
router.post('/joinSeva', handleOnCall(seva.joinSeva));
router.post('/cancelSeva', handleOnCall(seva.cancelSeva));
router.post('/getSevas', handleOnCall(seva.getSevas));
router.post('/getMySevas', handleOnCall(seva.getMySevas));
router.post('/getSevaParticipants', handleOnCall(seva.getSevaParticipants));
router.post('/markSevaAttendance', handleOnCall(seva.markAttendance));

module.exports = router;
