'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const sadhana = require('../controllers/sadhana.controller');

const router = Router();

router.post('/submitSadhana', handleOnCall(sadhana.submitSadhana));
router.post('/getSadhanaMe', handleOnCall(sadhana.getSadhanaMe));
router.post('/getSadhanaAdmin', handleOnCall(sadhana.getSadhanaAdmin));

module.exports = router;
