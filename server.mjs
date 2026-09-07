/* ==========================================================================
   안전보건 순회점검 시스템 — 파일 기반 공유 서버
   - 외부 의존성 없음 (Node.js 내장 모듈만 사용)
   - 점검 기록: data/records.json
   - 현장 사진: data/photos/<id>.<ext>
   실행: node server.mjs   (환경변수 PORT, HOST 로 변경 가능)
   ========================================================================== */

import http from 'node:http';
import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');

const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '0.0.0.0';

const MAX_BODY = 12 * 1024 * 1024;   // 요청 본문 최대 12MB
const MAX_PHOTO = 4 * 1024 * 1024;   // 사진 1장 최대 4MB

const CATEGORIES = ['machine', 'fall', 'electric', 'chemical', 'fire', 'etc'];
const STATUSES = ['완료', '진행중', '보류'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* --------------------------------------------------------------- 저장소 */

/** 쓰기 작업을 직렬화해 동시 저장으로 파일이 깨지는 것을 막는다. */
let writeChain = Promise.resolve();
function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function ensureDirs() {
  await mkdir(PHOTO_DIR, { recursive: true });
}

async function readRecords() {
  try {
    const raw = await readFile(RECORDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** 임시 파일에 쓴 뒤 교체하여 중간에 중단돼도 원본이 손상되지 않게 한다. */
async function writeRecords(records) {
  const tmp = RECORDS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await rename(tmp, RECORDS_FILE);
}

/* ------------------------------------------------------------ 입력 검증 */

function text(value, maxLen) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validateNew(body) {
  const rec = {
    date: isISODate(body.date) ? body.date : '',
    inspector: text(body.inspector, 50),
    attendees: text(body.attendees, 50),
    location: text(body.location, 100),
    category: CATEGORIES.includes(body.category) ? body.category : '',
    issue: text(body.issue, 2000),
    status: STATUSES.includes(body.status) ? body.status : '진행중',
    action: text(body.action, 300)
  };
  const missing = ['date', 'inspector', 'attendees', 'location', 'category', 'issue']
    .filter((key) => !rec[key]);
  return { rec, missing };
}

/** data:image/... base64 문자열을 파일로 저장하고 공개 경로를 돌려준다. */
async function savePhoto(id, dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return '';
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return '';

  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_PHOTO) return '';

  const ext = match[1] === 'jpg' ? 'jpeg' : match[1];
  const name = id + '.' + ext;
  await writeFile(path.join(PHOTO_DIR, name), buffer);
  return '/photos/' + name;
}

async function removePhoto(publicPath) {
  if (!publicPath || !publicPath.startsWith('/photos/')) return;
  const name = path.basename(publicPath);
  try {
    await unlink(path.join(PHOTO_DIR, name));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('사진 삭제 실패:', err.message);
  }
}

/* ------------------------------------------------------------ HTTP 응답 */

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('본문이 너무 큽니다.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 형식이 올바르지 않습니다.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------------- 정적 */

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const base = rel.startsWith('photos/') ? DATA_DIR : ROOT;
  const filePath = path.resolve(base, rel);

  // 경로 이탈(../) 차단
  if (!filePath.startsWith(base + path.sep) && filePath !== path.join(base, 'index.html')) {
    return sendJSON(res, 403, { error: '허용되지 않은 경로입니다.' });
  }
  if (filePath.startsWith(DATA_DIR + path.sep) && !filePath.startsWith(PHOTO_DIR + path.sep)) {
    return sendJSON(res, 403, { error: '허용되지 않은 경로입니다.' });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': rel.startsWith('photos/') ? 'public, max-age=604800' : 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ------------------------------------------------------------------ API */

async function handleAPI(req, res, urlPath) {
  const idMatch = /^\/api\/records\/([A-Za-z0-9-]{1,64})$/.exec(urlPath);

  if (urlPath === '/api/records' && req.method === 'GET') {
    const records = await readRecords();
    return sendJSON(res, 200, { records });
  }

  if (urlPath === '/api/records' && req.method === 'POST') {
    const body = await readBody(req);
    const { rec, missing } = validateNew(body);
    if (missing.length) {
      return sendJSON(res, 400, { error: '필수 항목이 누락되었습니다: ' + missing.join(', ') });
    }

    const id = randomUUID();
    const photo = await savePhoto(id, body.photo);
    const saved = { id, ...rec, photo, createdAt: new Date().toISOString() };

    await enqueue(async () => {
      const records = await readRecords();
      records.push(saved);
      await writeRecords(records);
    });
    return sendJSON(res, 201, { record: saved });
  }

  if (idMatch && req.method === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    if (STATUSES.includes(body.status)) patch.status = body.status;
    if (typeof body.action === 'string') patch.action = text(body.action, 300);
    if (!Object.keys(patch).length) {
      return sendJSON(res, 400, { error: '변경할 항목이 없습니다.' });
    }

    let updated = null;
    await enqueue(async () => {
      const records = await readRecords();
      const target = records.find((r) => r.id === idMatch[1]);
      if (!target) return;
      Object.assign(target, patch, { updatedAt: new Date().toISOString() });
      updated = target;
      await writeRecords(records);
    });

    if (!updated) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });
    return sendJSON(res, 200, { record: updated });
  }

  if (idMatch && req.method === 'DELETE') {
    let removed = null;
    await enqueue(async () => {
      const records = await readRecords();
      const index = records.findIndex((r) => r.id === idMatch[1]);
      if (index === -1) return;
      removed = records.splice(index, 1)[0];
      await writeRecords(records);
    });

    if (!removed) return sendJSON(res, 404, { error: '기록을 찾을 수 없습니다.' });
    await removePhoto(removed.photo);
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: '지원하지 않는 요청입니다.' });
}

/* --------------------------------------------------------------- 서버 */

const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  try {
    if (urlPath.startsWith('/api/')) return await handleAPI(req, res, urlPath);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJSON(res, 405, { error: '지원하지 않는 요청입니다.' });
    }
    return await serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('요청 처리 오류:', err);
    if (!res.headersSent) sendJSON(res, err.status || 500, { error: err.message || '서버 오류' });
    else res.end();
  }
});

/** 휴대폰에서 접속할 때 쓸 사내망 주소를 찾아 알려준다. */
function lanAddresses() {
  const list = [];
  const groups = Object.values(os.networkInterfaces());
  for (const group of groups) {
    for (const net of group || []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address);
    }
  }
  return list;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  [실행 실패] ' + PORT + '번 포트를 이미 다른 프로그램이 쓰고 있습니다.');
    console.error('  서버가 이미 켜져 있을 수 있습니다. 열려 있는 검은 창을 모두 닫고 다시 실행해 주세요.');
    console.error('');
  } else {
    console.error('  [실행 실패] ' + err.message);
  }
  process.exit(1);
});

await ensureDirs();
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('========================================================');
  console.log('  안전보건 순회점검 서버가 실행되었습니다.');
  console.log('========================================================');
  console.log('');
  console.log('  이 컴퓨터에서   : http://localhost:' + PORT + '/');
  for (const ip of lanAddresses()) {
    console.log('  휴대폰/태블릿   : http://' + ip + ':' + PORT + '/');
  }
  console.log('');
  console.log('  * 휴대폰은 이 컴퓨터와 같은 와이파이에 연결되어 있어야 합니다.');
  console.log('  * 점검 기록 저장 위치 : ' + RECORDS_FILE);
  console.log('  * 현장 사진 저장 위치 : ' + PHOTO_DIR);
  console.log('');
  console.log('  종료하려면 이 검은 창을 닫으세요. (창을 닫으면 접속도 끊깁니다)');
  console.log('');
});
