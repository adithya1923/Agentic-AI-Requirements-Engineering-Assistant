import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';

let server;
let baseUrl;
let projectId;
const createdInputIds = [];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStored(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function minimalDocx(text) {
  return zipStored({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  });
}

function minimalPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(source);
}

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Phase 3 test ${crypto.randomUUID()}` }),
  });
  assert.equal(response.status, 201);
  projectId = (await response.json()).data.id;
});

after(async () => {
  if (projectId) {
    const { rows } = await pool.query('SELECT storage_key FROM project_inputs WHERE project_id = $1 AND storage_key IS NOT NULL', [projectId]);
    for (const row of rows) await fs.rm(path.join(config.uploadDirectory, row.storage_key), { force: true });
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  }
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('text input validates fields and remains linked and retrievable through its project', async () => {
  const missing = await fetch(`${baseUrl}/projects/${projectId}/inputs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Missing content' }),
  });
  assert.equal(missing.status, 400);

  const response = await fetch(`${baseUrl}/projects/${projectId}/inputs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Stakeholder interview', source: 'Operations interview', inputType: 'INTERVIEW_TRANSCRIPT', content: 'Letters of credit are checked by two reviewers.' }),
  });
  assert.equal(response.status, 201);
  const input = (await response.json()).data;
  createdInputIds.push(input.id);
  assert.equal(input.projectId, projectId);
  assert.equal(input.processingStatus, 'READY');

  const list = await fetch(`${baseUrl}/projects/${projectId}/inputs`);
  assert.ok((await list.json()).data.some((item) => item.id === input.id));
  const detail = await fetch(`${baseUrl}/inputs/${input.id}`);
  assert.equal((await detail.json()).data.id, input.id);
  const content = await fetch(`${baseUrl}/inputs/${input.id}/content`);
  assert.equal((await content.json()).data.content, 'Letters of credit are checked by two reviewers.');
});

test('TXT document extracts text; unsupported and invalid documents fail safely', async () => {
  const txt = new FormData();
  txt.set('title', 'Plain text source');
  txt.set('source', 'Temporary test fixture');
  txt.set('file', new Blob(['Trade finance text source.'], { type: 'text/plain' }), 'source.txt');
  const txtResponse = await fetch(`${baseUrl}/projects/${projectId}/inputs/documents`, { method: 'POST', body: txt });
  assert.equal(txtResponse.status, 201);
  const txtInput = (await txtResponse.json()).data;
  createdInputIds.push(txtInput.id);
  assert.equal(txtInput.processingStatus, 'READY');
  assert.equal((await (await fetch(`${baseUrl}/inputs/${txtInput.id}/content`)).json()).data.content, 'Trade finance text source.');

  const unsupported = new FormData();
  unsupported.set('title', 'Unsupported file');
  unsupported.set('source', 'Temporary test fixture');
  unsupported.set('file', new Blob(['image bytes'], { type: 'image/png' }), 'image.png');
  assert.equal((await fetch(`${baseUrl}/projects/${projectId}/inputs/documents`, { method: 'POST', body: unsupported })).status, 415);

  const invalidPdf = new FormData();
  invalidPdf.set('title', 'Invalid PDF');
  invalidPdf.set('source', 'Temporary test fixture');
  invalidPdf.set('file', new Blob(['%PDF-not-a-valid-pdf'], { type: 'application/pdf' }), 'broken.pdf');
  const failedResponse = await fetch(`${baseUrl}/projects/${projectId}/inputs/documents`, { method: 'POST', body: invalidPdf });
  assert.equal(failedResponse.status, 422);
  const failedInput = (await failedResponse.json()).data;
  createdInputIds.push(failedInput.id);
  assert.equal(failedInput.processingStatus, 'FAILED');
  assert.ok(failedInput.processingError);
});

test('DOCX and PDF document uploads extract embedded text', async () => {
  const fixtures = [
    { name: 'meeting.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: minimalDocx('DOCX extraction fixture.'), expected: 'DOCX extraction fixture.' },
    { name: 'meeting.pdf', mime: 'application/pdf', bytes: minimalPdf('PDF extraction fixture.'), expected: 'PDF extraction fixture.' },
  ];
  for (const fixture of fixtures) {
    const form = new FormData();
    form.set('title', `Fixture ${fixture.name}`);
    form.set('source', 'Temporary extraction fixture');
    form.set('file', new Blob([fixture.bytes], { type: fixture.mime }), fixture.name);
    const response = await fetch(`${baseUrl}/projects/${projectId}/inputs/documents`, { method: 'POST', body: form });
    assert.equal(response.status, 201, `${fixture.name}: ${await response.clone().text()}`);
    const input = (await response.json()).data;
    createdInputIds.push(input.id);
    assert.equal(input.processingStatus, 'READY');
    const content = await fetch(`${baseUrl}/inputs/${input.id}/content`);
    assert.match((await content.json()).data.content, new RegExp(fixture.expected));
  }
});
