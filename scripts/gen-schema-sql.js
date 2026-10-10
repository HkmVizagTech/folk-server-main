'use strict';

// Prints the DDL for the typed schemas (src/db/schema). Migration 001 was
// generated from this; use it as the starting point when a later migration has
// to add a table:   node scripts/gen-schema-sql.js [collection ...]
const { listSchemas } = require('../src/db/schema');
const { tableSql, indexSql, fkSql, commentSql } = require('../src/db/schema/ddl');

const only = new Set(process.argv.slice(2));
for (const s of listSchemas()) {
  if (only.size && !only.has(s.collection)) continue;
  console.log(`-- ${s.collection}`);
  console.log(tableSql(s));
  indexSql(s).forEach((l) => console.log(l));
  commentSql(s).forEach((l) => console.log(l));
  fkSql(s).forEach((l) => console.log(l));
  console.log('');
}
