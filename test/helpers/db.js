'use strict';

/**
 * Throwaway Postgres for the tests.
 *   TEST_DATABASE_URL=postgres://user@host:port   use that server (a fresh database is created per test file and dropped afterwards)
 *   otherwise                                     start a private cluster in a temp dir (initdb from PG_BIN, /Library/PostgreSQL/*\/bin or PATH), stop and delete it when the file is done
 * Nothing but databases named folk_test_* is ever created or dropped.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

let cluster = null;

const findBin = () => {
  const cands = [process.env.PG_BIN, ...['18', '17', '16', '15', '14'].map((v) => `/Library/PostgreSQL/${v}/bin`), '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin', '/usr/bin'].filter(Boolean);
  for (const d of cands) if (fs.existsSync(path.join(d, 'initdb'))) return d;
  const which = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  if (which.status === 0) return path.dirname(which.stdout.trim());
  throw new Error('No Postgres binaries found: set TEST_DATABASE_URL or PG_BIN');
};

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

const startCluster = async () => {
  const bin = findBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folk-pg-'));
  const port = await freePort();
  let r = spawnSync(path.join(bin, 'initdb'), ['-D', path.join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`initdb failed: ${r.stderr}`);
  r = spawnSync(path.join(bin, 'pg_ctl'), ['-D', path.join(dir, 'data'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off`, '-l', path.join(dir, 'log'), '-w', 'start'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pg_ctl start failed: ${r.stderr}\n${r.stdout}`);
  cluster = { dir, bin, url: `postgres://postgres@127.0.0.1:${port}` };
  return cluster.url;
};

const serverUrl = async () => process.env.TEST_DATABASE_URL || (cluster ? cluster.url : startCluster());

/** A fresh empty database. Returns { url, drop() }. */
const createDatabase = async () => {
  const base = await serverUrl();
  const name = `folk_test_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const drop = async () => {
    const c = new Client({ connectionString: `${base}/postgres` });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.end();
    if (cluster) {
      spawnSync(path.join(cluster.bin, 'pg_ctl'), ['-D', path.join(cluster.dir, 'data'), '-m', 'immediate', '-w', 'stop']);
      fs.rmSync(cluster.dir, { recursive: true, force: true });
      cluster = null;
    }
  };
  return { url: `${base}/${name}`, drop };
};

module.exports = { createDatabase };
