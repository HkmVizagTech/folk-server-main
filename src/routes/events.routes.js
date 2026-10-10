'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const events = require('../controllers/event.controller');
const attendance = require('../controllers/attendance.controller');
const accommodation = require('../controllers/accommodation.controller');

const router = Router();

router.post('/createEvent', handleOnCall(events.createEvent));
router.post('/getEvents', handleOnCall(events.getEvents));
router.post('/verifyAttendance', handleOnCall(attendance.verifyAttendance));
router.post('/updateAccommodationStatus', handleOnCall(accommodation.updateAccommodationStatus));

module.exports = router;
