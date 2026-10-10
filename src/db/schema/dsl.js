'use strict';

/**
 * Tiny declarative vocabulary for the collection schemas.
 *
 * A column maps ONE camelCase document field (`key`) to ONE SQL column
 * (`name`). Types and what they accept (a value that does not fit is not
 * rejected: the codec keeps it in the table's `extra` jsonb instead, so every
 * document still round-trips exactly):
 *
 *   text       any string (optionally limited to `enum`)
 *   int        JSON integer in the int4 range (optionally `min` / `max`)
 *   bigint     JSON integer up to 2^53 (paise, counters)
 *   numeric    rupee amounts, numeric(12,2): at most 2 decimals; read back as a JS number
 *   bool       boolean
 *   ts         timestamptz, ONLY for strings shaped exactly YYYY-MM-DDTHH:mm:ss.SSSZ
 *   date       date, ONLY for strings shaped YYYY-MM-DD that are real calendar days
 *   textArray  text[] (array of strings)
 *   jsonb      any JSON value (nested arrays / objects)
 */
const RESERVED = new Set(['id', 'extra', 'version', 'created_at', 'updated_at']);

const snake = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .toLowerCase();

const column = (type) => (key, opts = {}) => {
  let name = opts.name || snake(key);
  // The document's own createdAt / updatedAt are NOT the row's created_at /
  // updated_at (those are bookkeeping of the row itself).
  if (!opts.name && RESERVED.has(name)) name = `doc_${name}`;
  return { key, name, type, ...opts };
};

const t = {
  text: column('text'),
  int: column('int'),
  bigint: column('bigint'),
  numeric: column('numeric'),
  bool: column('bool'),
  ts: column('ts'),
  date: column('date'),
  textArray: column('textArray'),
  jsonb: column('jsonb'),
};

const SQL_TYPES = {
  text: 'text',
  int: 'integer',
  bigint: 'bigint',
  numeric: 'numeric(12,2)',
  bool: 'boolean',
  ts: 'timestamptz',
  date: 'date',
  textArray: 'text[]',
  jsonb: 'jsonb',
};

module.exports = { t, snake, SQL_TYPES, RESERVED };
