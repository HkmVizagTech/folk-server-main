'use strict';
const { t } = require('./dsl');

/** status = sessionsAttended >= course.sessions ? completed : enrolled (client-maintained). */
module.exports = {
  collection: 'enrollments',
  table: 'enrollments',
  idFormat: '<courseId>_<userId>',
  columns: [
    t.text('courseId'), t.text('courseTitle'), t.text('userId'), t.text('userName'), t.text('userPhone'),
    t.text('status', { enum: ['enrolled', 'completed'] }),
    t.int('sessionsAttended', { min: 0 }), t.ts('createdAt'), t.ts('updatedAt'),
  ],
  unique: [{ columns: ['course_id', 'user_id'] }],
  indexes: [{ columns: ['user_id'] }],
};
