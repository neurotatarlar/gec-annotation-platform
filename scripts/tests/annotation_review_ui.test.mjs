import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from '../../frontend/node_modules/jsdom/lib/api.js';

const html = fs.readFileSync(new URL('../annotation_review.html', import.meta.url), 'utf8');
const fixture = {
  text_id: 1, ordinal: 1, total: 1, source: 'aa bb cc',
  corrections: [0, 3, 6].map((start, index) => ({
    id: `edit-${index}`, title: `Correction ${index + 1}`, start, end: start + 2,
    original: ['aa', 'bb', 'cc'][index], replacement: ['AA', 'BB', 'CC'][index],
    error_type_id: 1,
  })),
  error_types: [{ id: 1, en_name: 'Spelling', tt_name: 'СүздәХата' }],
};

async function setup(t, data = fixture, saved = null) {
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/text/1.html', runScripts: 'dangerously',
    beforeParse(window) {
      window.structuredClone = structuredClone;
      window.fetch = async () => ({ ok: true, json: async () => ({ case: data, case_hash: 'hash', saved }) });
      window.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  t.after(() => dom.window.close());
  await new Promise(resolve => setTimeout(resolve, 0));
  const document = dom.window.document;
  return {
    document,
    accept: index => document.querySelector(`[data-decision="accepted"][data-index="${index}"]`).click(),
    reject: index => document.querySelector(`[data-decision="rejected"][data-index="${index}"]`).click(),
    select: index => document.querySelector(`[data-select="${index}"]`).click(),
    expanded: () => [...document.querySelectorAll('[aria-expanded="true"]')].map(node => Number(node.dataset.select)),
  };
}

test('Accept closes the current correction and opens the next pending correction', async t => {
  const ui = await setup(t);
  ui.accept(0);
  assert.deepEqual(ui.expanded(), [1]);
  assert.equal(ui.document.querySelector('[data-select="0"]').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.document.querySelector('#count').textContent, '1 / 3 reviewed');
});

test('Accept skips reviewed corrections and wraps to earlier pending corrections', async t => {
  const ui = await setup(t);
  ui.reject(1);
  ui.select(0);
  ui.accept(0);
  assert.deepEqual(ui.expanded(), [2]);
  ui.document.querySelector('#undo').click();
  ui.select(2);
  ui.accept(2);
  assert.deepEqual(ui.expanded(), [0]);
});

test('The final acceptance collapses all cards and offers explicit text confirmation', async t => {
  const ui = await setup(t);
  ui.accept(0); ui.accept(1); ui.accept(2);
  assert.deepEqual(ui.expanded(), []);
  assert.equal(ui.document.querySelector('#confirm').disabled, false);
  assert.equal(ui.document.activeElement.id, 'confirm');
  assert.match(ui.document.querySelector('#state').textContent, /Unsaved/);
});

test('Undo reopens the accepted correction and restores its pending state', async t => {
  const ui = await setup(t);
  ui.accept(0);
  ui.document.querySelector('#undo').click();
  assert.deepEqual(ui.expanded(), [0]);
  assert.equal(ui.document.querySelector('#count').textContent, '0 / 3 reviewed');
});

test('A moved span stays linked to its insertion when accepting and rejecting', async t => {
  const moved = structuredClone(fixture);
  moved.source = 'aa bb cc';
  moved.corrections = [{
    id: 'move', title: 'Move cc to the beginning', start: 0, end: 0,
    original: '', replacement: 'cc ', error_type_id: 1,
    linked_removals: [{ start: 5, end: 8, original: ' cc' }],
  }];
  const ui = await setup(t, moved);
  const visibleText = () => {
    const clone = ui.document.querySelector('#target').cloneNode(true);
    clone.querySelectorAll('.pin,.insertion').forEach(n => n.remove());
    return clone.textContent;
  };
  assert.equal(visibleText(), 'cc aa bb');
  assert.equal(ui.document.querySelectorAll('#source [data-index="0"]').length, 2);
  ui.reject(0);
  assert.equal(visibleText(), 'aa bb cc');
  ui.accept(0);
  assert.equal(visibleText(), 'cc aa bb');
});

test('Identical moved text is explained with before and after placement in context', async t => {
  const moved = structuredClone(fixture);
  moved.corrections = [{
    id: 'move', operation: 'move', title: 'Move cc', start: 0, end: 0,
    original: '', replacement: 'cc ', error_type_id: 1,
    linked_removals: [{ start: 5, end: 8, original: ' cc' }],
  }];
  const ui = await setup(t, moved);
  const card = ui.document.querySelector('[data-card="0"]');
  assert.equal(card.querySelector('.move-before').textContent, 'aa bb cc');
  assert.equal(card.querySelector('.move-after').textContent, 'cc aa bb');
  assert.match(card.querySelector('.move-explanation').textContent, /position/);
  assert.match(card.querySelector('label[for="replacement-0"]').textContent, /MOVED TEXT/);
  assert.equal(card.querySelector('#replacement-0').value, 'cc ');
  assert.match(ui.document.querySelector('#source').textContent, /1 · from/);
  assert.match(ui.document.querySelector('#target').textContent, /1 · to/);

  const input = card.querySelector('#replacement-0');
  input.value = 'CC ';
  input.dispatchEvent(new ui.document.defaultView.Event('input', { bubbles: true }));
  assert.equal(ui.document.querySelector('.move-after').textContent, 'CC aa bb');
  assert.equal(ui.document.querySelector('#count').textContent, '0 / 1 reviewed');
});

test('Reload matches saved decisions by ID when case order changes', async t => {
  const saved = {
    case_hash: 'hash', state: 'confirmed', revision: 2, note: '',
    corrections: [
      { id: 'edit-2', status: 'rejected', replacement: 'LAST', error_type_id: 1 },
      { id: 'edit-0', status: 'accepted', replacement: 'FIRST', error_type_id: 1 },
      { id: 'edit-1', status: 'accepted', replacement: 'MIDDLE', error_type_id: 1 },
    ],
  };
  const ui = await setup(t, fixture, saved);
  const clone = ui.document.querySelector('#target').cloneNode(true);
  clone.querySelectorAll('.pin,.insertion').forEach(n => n.remove());
  assert.equal(clone.textContent, 'FIRST MIDDLE cc');
  assert.equal(ui.document.querySelector('#replacement-0').value, 'FIRST');
  assert.equal(ui.document.querySelector('#replacement-1').value, 'MIDDLE');
  assert.match(ui.document.querySelector('[data-card="2"] .status-label').textContent, /Rejected/);
});
