'use strict';

const { Router } = require('express');
const { handleOnCall } = require('../middlewares/onCall');
const { limits } = require('../middlewares/rateLimit');
const data = require('../controllers/data.controller');

const router = Router();

// What the website used to read/write in Firestore directly.
router.post('/dbGet', limits.dbRead, handleOnCall(data.dbGet));
router.post('/dbQuery', limits.dbRead, handleOnCall(data.dbQuery));
router.post('/dbCommit', limits.dbWrite, handleOnCall(data.dbCommit));
router.post('/dbChanges', limits.dbChanges, handleOnCall(data.dbChanges));

// Admin: row counts per table, and re-copy from Firestore.
router.post('/dbStatus', handleOnCall(data.dbStatus));
router.post('/dbCopyFromFirestore', limits.dbCopy, handleOnCall(data.dbCopyFromFirestore));

module.exports = router;
