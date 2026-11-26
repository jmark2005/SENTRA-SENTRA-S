'use strict';

// Incident reference numbers stay unique and gap-free under concurrent calls (design.md §2.5, T-20).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Worker } = require('worker_threads');
const { ROOT, makeUser, startServer } = require('./helpers');

const repo = require(path.join(ROOT, 'src', 'repositories', 'incident.repository'));

test('generateRefNumber from 4 threads with separate DB connections: no duplicates, no gaps', async () => {
  const year = 2090; // a year no other test uses
  const THREADS = 4;
  const PER_THREAD = 40;
  // Each worker opens its own connection to the same temporary DB file (DB_PATH is inherited).
  const code = `
    const { workerData, parentPort } = require('worker_threads');
    const repo = require(workerData.repoPath);
    const refs = [];
    for (let i = 0; i < workerData.n; i++) refs.push(repo.generateRefNumber(workerData.year));
    parentPort.postMessage(refs);
  `;
  const runs = Array.from({ length: THREADS }, () => new Promise((resolve, reject) => {
    const w = new Worker(code, {
      eval: true,
      workerData: { repoPath: path.join(ROOT, 'src', 'repositories', 'incident.repository'), n: PER_THREAD, year },
    });
    w.once('message', resolve);
    w.once('error', reject);
  }));
  const refs = (await Promise.all(runs)).flat();

  assert.equal(refs.length, THREADS * PER_THREAD);
  assert.equal(new Set(refs).size, refs.length, 'duplicate reference numbers');
  const numbers = refs.map(r => Number(r.slice(-4))).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: refs.length }, (_, i) => i + 1), 'numbers are not 1..N');
  assert.match(refs[0], /^INC-2090-\d{4}$/);
});

test('counter restarts per year and pads to 4 digits', () => {
  assert.equal(repo.generateRefNumber(2091), 'INC-2091-0001');
  assert.equal(repo.generateRefNumber(2091), 'INC-2091-0002');
  assert.equal(repo.generateRefNumber(2092), 'INC-2092-0001');
});

test('20 simultaneous POST /api/incidents get 20 different reference numbers', async () => {
  const srv = await startServer();
  try {
    const teacher = await srv.login(makeUser('teacher', 'Test Teacher'));
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => srv.createIncident(teacher, `concurrent ${i}`)));
    const r = await Promise.all(ids.map(id => srv.call(teacher, 'GET', `/api/incidents/${id}`)));
    const refs = r.map(x => x.body.reference_number);
    assert.equal(new Set(refs).size, 20, refs.join(', '));
    refs.forEach(ref => assert.match(ref, /^INC-\d{4}-\d{4}$/));
  } finally {
    await srv.close();
  }
});
