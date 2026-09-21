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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const ACCESS_FILE = path.join(DATA_DIR, 'access.json');
const OPTIONS_FILE = path.join(DATA_DIR, 'options.json');
const RULES_SEED_FILE = path.join(ROOT, 'assets', 'rules.json');

const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '0.0.0.0';

const MAX_BODY = 12 * 1024 * 1024;   // 요청 본문 최대 12MB
const MAX_PHOTO = 4 * 1024 * 1024;   // 사진 1장 최대 4MB

const STATUSES = ['완료', '진행중', '보류'];

/** 자유 입력값을 모아 두는 선택 목록. 담당자·입회자·장소는 현장에서 반복 입력되는 값이다. */
const TEXT_GROUPS = ['inspectors', 'attendees', 'locations'];
const MAX_OPTIONS = 300;

/** 순회점검 담당자·입회자 명단 (연구관리실 제공, 2026-09) */
const DEFAULT_STAFF = [
  { dept: '안전관리실', name: '최필재' },
  { dept: '경영지원팀', name: '최혜림' },
  { dept: '생산관리팀', name: '김진열' },
  { dept: '생산관리팀', name: '김성효' },
  { dept: '생산관리팀', name: '박동진' },
  { dept: '생산관리팀', name: '정상채' },
  { dept: '생산관리팀', name: '김주형' },
  { dept: '생산관리팀', name: '천진영' },
  { dept: '생산관리팀', name: '정재일' },
  { dept: '생산관리팀', name: '김대창' },
  { dept: '2공장 관리팀', name: '권상희' },
  { dept: '2공장 관리팀', name: '김민지' },
  { dept: '2공장 관리팀', name: '이동윤' },
  { dept: '2공장 관리팀', name: '정현수' },
  { dept: '연구개발팀', name: '김현우' },
  { dept: '연구개발팀', name: '서동한' },
  { dept: '연구개발팀', name: '최혜민' },
  { dept: '연구개발팀', name: '김기현' },
  { dept: '연구개발팀', name: '박동일' },
  { dept: '연구개발팀', name: '윤경진' }
];

/** 점검 장소 = 공장 > 동 > 세부구역 */
const DEFAULT_SITES = [
  { factory: '1공장', building: 'A동', area: '성형반' },
  { factory: '1공장', building: 'B동', area: '' },
  { factory: '2공장', building: '', area: '' },
  { factory: '3공장', building: 'A동', area: '' },
  { factory: '3공장', building: 'B동', area: '' },
  { factory: '3공장', building: 'C동', area: '' }
];

/** 처음 실행할 때 채워 넣는 기본 위험 유형.
 *  laws  : 결과 화면의 "주요 적용 법령 및 처벌 규정" 표 (국가법령정보센터 기준)
 *  actions: 단계별 개선조치 체크리스트 */
const DEFAULT_CATEGORIES = [
  {
    key: 'machine', label: '기계·기구',
    law: '산업안전보건법 제38조 / 안전보건규칙 제87조', lawShort: '산안규칙 제87조',
    summary: '위험 기계 가동 중 방호장치를 임의 해제하였거나 정상 작동하지 않는 상태입니다.',
    penalty: '5년 이하 징역 또는 5천만원 이하 벌금',
    laws: [
      { law: '산업안전보건법', article: '제38조', duty: '위험 기계·기구에 대한 안전조치', penalty: '5년 이하 징역 또는 5천만원 이하 벌금' },
      { law: '안전보건규칙', article: '제87조', duty: '원동기·회전축 등의 방호조치', penalty: '1천만원 이하 과태료' }
    ],
    guide: ['해당 기계 가동 즉시 중지', '방호장치 점검 및 교체', '관리감독자 확인 후 작업 재개'],
    actions: {
      immediate: ['해당 기계 가동 즉시 중지', '전원 차단 및 작업중지 표지 부착'],
      short: ['방호장치 점검·교체', '관리감독자 확인 후 작업 재개'],
      long: ['동일 기종 방호장치 일제 점검', '작업자 안전교육 실시']
    }
  },
  {
    key: 'fall', label: '추락·전도',
    law: '산업안전보건기준에 관한 규칙 제42조', lawShort: '산안규칙 제42조',
    summary: '고소 작업 구간에 안전난간이 설치되지 않았거나 안전대를 체결하지 않은 상태입니다.',
    penalty: '5년 이하 징역 또는 5천만원 이하 벌금',
    laws: [
      { law: '산업안전보건법', article: '제38조', duty: '추락 위험 장소의 안전조치', penalty: '5년 이하 징역 또는 5천만원 이하 벌금' },
      { law: '안전보건규칙', article: '제42조', duty: '추락 방지 조치 (안전난간·안전대)', penalty: '1천만원 이하 과태료' }
    ],
    guide: ['해당 구간 작업 즉시 중단', '표준 안전난간 설치', '전신형 안전대 체결 상태 확인'],
    actions: {
      immediate: ['해당 구간 작업 즉시 중단', '출입 통제선 설치'],
      short: ['표준 안전난간 설치', '전신형 안전대 지급·체결 확인'],
      long: ['고소작업 구간 전수 점검', '추락 방지 설비 정기점검 계획 수립']
    }
  },
  {
    key: 'electric', label: '전기설비',
    law: '산업안전보건기준에 관한 규칙 제301조', lawShort: '산안규칙 제301조',
    summary: '배·분전반 충전부가 노출되어 감전 위험이 있는 상태입니다.',
    penalty: '5년 이하 징역 또는 5천만원 이하 벌금',
    laws: [
      { law: '산업안전보건법', article: '제38조', duty: '전기 재해 예방 조치', penalty: '5년 이하 징역 또는 5천만원 이하 벌금' },
      { law: '안전보건규칙', article: '제301조', duty: '전기 기계·기구의 충전부 방호', penalty: '1천만원 이하 과태료' }
    ],
    guide: ['분전반 주변 정리 및 접근 통제', '절연 덮개 설치', '감전주의 경고표지 부착'],
    actions: {
      immediate: ['분전반 주변 정리 및 접근 통제', '감전주의 경고표지 부착'],
      short: ['충전부 절연 덮개 설치', '누전차단기 작동 시험'],
      long: ['전기설비 정기검사 수검', '접지저항 측정 주기 관리']
    }
  },
  {
    key: 'chemical', label: '화학물질',
    law: '산업안전보건법 제110조 / 제114조', lawShort: '산안법 제110조',
    summary: 'MSDS 경고표시가 누락되었거나 적합한 보호구를 착용하지 않은 상태입니다.',
    penalty: '500만원 이하 과태료',
    laws: [
      { law: '산업안전보건법', article: '제114조', duty: '물질안전보건자료(MSDS)의 비치 및 경고표시', penalty: '500만원 이하 과태료' },
      { law: '화학물질관리법', article: '제28조', duty: '유해화학물질 영업허가 (제조·사용·보관 등)', penalty: '5년 이하 징역 또는 1억원 이하 벌금 / 영업정지' },
      { law: '화학물질관리법', article: '제24조', duty: '유해화학물질 취급시설 배치·설치 및 관리기준 준수', penalty: '3년 이하 징역 또는 5천만원 이하 벌금 / 개선명령' }
    ],
    guide: ['해당 작업 일시 중지', 'MSDS 경고표지 부착 및 게시', '방독마스크 등 보호구 지급·착용'],
    actions: {
      immediate: ['MSDS 현장 비치 및 경고표지 부착', '취급 구역 관계자 외 출입통제'],
      short: ['유해화학물질 취급자 법정 교육 이수', '국소배기장치 등 환기설비 가동 점검'],
      long: ['취급시설 정기검사 수검 (안전보건공단/환경공단)', '영업허가 대상 여부 검토']
    }
  },
  {
    key: 'fire', label: '화재·폭발',
    law: '산업안전보건기준에 관한 규칙 제241조', lawShort: '산안규칙 제241조',
    summary: '인화성 물질 취급 장소에서 화기 작업 중 소화설비가 배치되지 않았습니다.',
    penalty: '5년 이하 징역 또는 5천만원 이하 벌금',
    laws: [
      { law: '산업안전보건법', article: '제38조', duty: '화재·폭발 위험 작업의 안전조치', penalty: '5년 이하 징역 또는 5천만원 이하 벌금' },
      { law: '안전보건규칙', article: '제241조', duty: '화재위험작업 시 화기 관리 및 감시인 배치', penalty: '1천만원 이하 과태료' }
    ],
    guide: ['화기 작업 중단', '소화기 배치 및 화재감시인 지정', '화기작업 허가서 재확인'],
    actions: {
      immediate: ['화기 작업 중단', '주변 인화성 물질 제거'],
      short: ['소화기 배치 및 화재감시인 지정', '화기작업 허가서 재발급·확인'],
      long: ['화기작업 허가 절차 정비', '소방설비 정기점검']
    }
  },
  {
    key: 'etc', label: '기타',
    law: '산업안전보건법 제5조 (사업주의 일반적 의무)', lawShort: '산안법 제5조',
    summary: '사업주는 근로자의 안전과 건강을 유지·증진시킬 의무가 있습니다.',
    penalty: '위반 내용에 따라 별도 판단',
    laws: [
      { law: '산업안전보건법', article: '제5조', duty: '사업주의 안전보건 확보 의무', penalty: '위반 내용에 따라 별도 판단' }
    ],
    guide: ['위험요인 확인 및 작업 중지 검토', '개선 조치 계획 수립', '조치 완료 후 관리감독자 확인'],
    actions: {
      immediate: ['위험요인 확인 및 작업 중지 검토'],
      short: ['개선 조치 계획 수립'],
      long: ['조치 완료 후 관리감독자 확인']
    }
  }
];

let options = null; // { inspectors, attendees, locations, staff, sites, categories, rules }

/** assets/rules.json 을 읽어 기본 규칙으로 쓴다. 파일이 없으면 규칙 기능만 비활성화된다. */
let defaultRules = [];

async function loadDefaultRules() {
  try {
    const parsed = JSON.parse(await readFile(RULES_SEED_FILE, 'utf8'));
    defaultRules = Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch (err) {
    console.warn('규칙 파일을 읽지 못했습니다. 지적사항 자동 매칭이 비활성화됩니다:', err.message);
    defaultRules = [];
  }
}

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

/* -------------------------------------------------------------- 선택 목록 */

async function readOptions() {
  try {
    const parsed = JSON.parse(await readFile(OPTIONS_FILE, 'utf8'));
    return normalizeOptions(parsed);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('선택 목록을 읽지 못해 기본값을 씁니다:', err.message);
    const initial = normalizeOptions({});
    await writeOptions(initial);
    return initial;
  }
}

function normalizeOptions(raw) {
  const result = { categories: [] };
  for (const group of TEXT_GROUPS) {
    const list = Array.isArray(raw[group]) ? raw[group] : [];
    result[group] = [...new Set(list.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))]
      .slice(0, MAX_OPTIONS);
  }

  const staff = Array.isArray(raw.staff) && raw.staff.length ? raw.staff : DEFAULT_STAFF;
  result.staff = staff
    .filter((m) => m && typeof m.name === 'string' && m.name.trim())
    .map((m) => ({ dept: String(m.dept || '기타').trim().slice(0, 40), name: String(m.name).trim().slice(0, 40) }))
    .slice(0, MAX_OPTIONS);

  const sites = Array.isArray(raw.sites) && raw.sites.length ? raw.sites : DEFAULT_SITES;
  result.sites = sites
    .filter((v) => v && typeof v.factory === 'string' && v.factory.trim())
    .map((v) => ({
      factory: String(v.factory).trim().slice(0, 40),
      building: String(v.building || '').trim().slice(0, 40),
      area: String(v.area || '').trim().slice(0, 60)
    }))
    .slice(0, MAX_OPTIONS);

  const rules = Array.isArray(raw.rules) && raw.rules.length ? raw.rules : defaultRules;
  result.rules = rules
    .filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string')
    .map(normalizeRule)
    .slice(0, MAX_OPTIONS);

  const cats = Array.isArray(raw.categories) && raw.categories.length ? raw.categories : DEFAULT_CATEGORIES;
  result.categories = cats
    .filter((c) => c && typeof c.key === 'string' && typeof c.label === 'string')
    .map((c) => ({
      key: c.key,
      label: String(c.label).slice(0, 40),
      law: String(c.law || '').slice(0, 160),
      lawShort: String(c.lawShort || c.law || '').slice(0, 60),
      summary: String(c.summary || '').slice(0, 400),
      penalty: String(c.penalty || '').slice(0, 160),
      laws: (Array.isArray(c.laws) ? c.laws : []).slice(0, 8).map((l) => ({
        law: String(l.law || '').slice(0, 60),
        article: String(l.article || '').slice(0, 40),
        duty: String(l.duty || '').slice(0, 200),
        penalty: String(l.penalty || '').slice(0, 160)
      })),
      guide: (Array.isArray(c.guide) ? c.guide : []).slice(0, 6).map((g) => String(g).slice(0, 160)),
      actions: normalizeActions(c.actions)
    }))
    .slice(0, MAX_OPTIONS);
  return result;
}

/** 지적사항 매칭 규칙 하나를 안전한 형태로 정리한다. */
function normalizeRule(raw) {
  return {
    id: String(raw.id).slice(0, 60),
    category: String(raw.category || 'etc').slice(0, 40),
    title: String(raw.title).slice(0, 80),
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : []).slice(0, 30)
      .map((k) => String(k).trim().slice(0, 40)).filter(Boolean),
    law: String(raw.law || '').slice(0, 200),
    lawShort: String(raw.lawShort || '').slice(0, 60),
    summary: String(raw.summary || '').slice(0, 400),
    penalty: String(raw.penalty || '').slice(0, 160),
    laws: (Array.isArray(raw.laws) ? raw.laws : []).slice(0, 8).map((l) => ({
      law: String(l.law || '').slice(0, 60),
      article: String(l.article || '').slice(0, 40),
      duty: String(l.duty || '').slice(0, 200),
      penalty: String(l.penalty || '').slice(0, 160)
    })),
    actions: normalizeActions(raw.actions)
  };
}

/** 단계별 개선조치를 즉시/단기/중장기 세 갈래로 정리한다. */
function normalizeActions(raw) {
  const pick = (list) => (Array.isArray(list) ? list : []).slice(0, 8)
    .map((v) => String(v).slice(0, 160)).filter(Boolean);
  const value = raw || {};
  return { immediate: pick(value.immediate), short: pick(value.short), long: pick(value.long) };
}

async function writeOptions(next) {
  const tmp = OPTIONS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, OPTIONS_FILE);
}

/** 이력 표에 들어갈 짧은 법조항 표기를 만든다. "…규칙 제619조" -> "제619조" */
function shortenLaw(law) {
  const article = /제\s*\d+조(\s*의\s*\d+)?/.exec(law || '');
  if (article) return article[0].replace(/\s+/g, '');
  return String(law || '').slice(0, 20);
}

/** staff / sites 항목을 문자열 하나로 식별한다. */
function itemKey(group, item) {
  return group === 'staff'
    ? item.dept + '|' + item.name
    : item.factory + '|' + item.building + '|' + item.area;
}

function findCategory(key) {
  return options.categories.find((c) => c.key === key) || null;
}

/** 자주 쓰는 값을 다음 점검에서 바로 고를 수 있도록 목록에 넣어 둔다. */
async function rememberValues(values) {
  let changed = false;
  for (const [group, value] of Object.entries(values)) {
    const text = String(value || '').trim();
    if (!text || !TEXT_GROUPS.includes(group)) continue;
    if (options[group].includes(text)) continue;
    if (options[group].length >= MAX_OPTIONS) continue;
    options[group].push(text);
    options[group].sort((a, b) => a.localeCompare(b, 'ko'));
    changed = true;
  }
  if (changed) await enqueue(() => writeOptions(options));
}

async function handleOptions(req, res, urlPath) {
  if (urlPath === '/api/options' && req.method === 'GET') {
    return sendJSON(res, 200, { options, features: { analyze: analyzeEnabled() } });
  }

  if (urlPath === '/api/options' && req.method === 'POST') {
    const body = await readBody(req);
    const group = String(body.group || '');

    if (TEXT_GROUPS.includes(group)) {
      const value = text(body.value, 100);
      if (!value) return sendJSON(res, 400, { error: '추가할 값을 입력해 주세요.' });
      if (options[group].includes(value)) return sendJSON(res, 409, { error: '이미 있는 항목입니다.' });
      if (options[group].length >= MAX_OPTIONS) {
        return sendJSON(res, 400, { error: '항목이 너무 많습니다. 쓰지 않는 항목을 지운 뒤 추가해 주세요.' });
      }
      options[group].push(value);
      options[group].sort((a, b) => a.localeCompare(b, 'ko'));
      await enqueue(() => writeOptions(options));
      return sendJSON(res, 201, { options });
    }

    if (group === 'staff') {
      const name = text(body.name, 40);
      const dept = text(body.dept, 40) || '기타';
      if (!name) return sendJSON(res, 400, { error: '이름을 입력해 주세요.' });
      if (options.staff.some((m) => m.name === name && m.dept === dept)) {
        return sendJSON(res, 409, { error: '이미 있는 담당자입니다.' });
      }
      options.staff.push({ dept, name });
      await enqueue(() => writeOptions(options));
      return sendJSON(res, 201, { options });
    }

    if (group === 'sites') {
      const factory = text(body.factory, 40);
      const building = text(body.building, 40);
      const area = text(body.area, 60);
      if (!factory) return sendJSON(res, 400, { error: '공장을 입력해 주세요.' });
      if (options.sites.some((v) => v.factory === factory && v.building === building && v.area === area)) {
        return sendJSON(res, 409, { error: '이미 있는 장소입니다.' });
      }
      options.sites.push({ factory, building, area });
      await enqueue(() => writeOptions(options));
      return sendJSON(res, 201, { options });
    }

    if (group === 'rules') {
      const title = text(body.title, 80);
      const keywords = (Array.isArray(body.keywords) ? body.keywords : [])
        .map((k) => text(k, 40)).filter(Boolean);
      if (!title) return sendJSON(res, 400, { error: '규칙 이름을 입력해 주세요.' });
      if (!keywords.length) return sendJSON(res, 400, { error: '찾을 단어를 한 개 이상 입력해 주세요.' });

      const rule = normalizeRule({
        id: 'r-' + randomUUID().slice(0, 8),
        category: findCategory(body.category) ? body.category : 'etc',
        title,
        keywords,
        law: body.law,
        lawShort: body.lawShort || shortenLaw(body.law),
        summary: body.summary,
        penalty: body.penalty,
        laws: body.laws,
        actions: body.actions
      });
      options.rules.push(rule);
      await enqueue(() => writeOptions(options));
      return sendJSON(res, 201, { options, rule });
    }

    if (group === 'categories') {
      const label = text(body.label, 40);
      const law = text(body.law, 160);
      if (!label) return sendJSON(res, 400, { error: '위험 유형 이름을 입력해 주세요.' });
      if (options.categories.some((c) => c.label === label)) {
        return sendJSON(res, 409, { error: '이미 있는 위험 유형입니다.' });
      }
      const category = {
        key: 'c-' + randomUUID().slice(0, 8),
        label,
        law: law || '산업안전보건법 제5조 (사업주의 일반적 의무)',
        lawShort: text(body.lawShort, 60) || (law ? shortenLaw(law) : '산안법 제5조'),
        summary: text(body.summary, 400),
        guide: (Array.isArray(body.guide) ? body.guide : [])
          .map((g) => text(g, 160)).filter(Boolean).slice(0, 6)
      };
      options.categories.push(category);
      await enqueue(() => writeOptions(options));
      return sendJSON(res, 201, { options, category });
    }

    return sendJSON(res, 400, { error: '알 수 없는 항목 종류입니다.' });
  }

  const delMatch = /^\/api\/options\/([a-z]+)\/(.+)$/.exec(urlPath);
  if (delMatch && req.method === 'DELETE') {
    const group = delMatch[1];
    const value = decodeURIComponent(delMatch[2]);

    if (TEXT_GROUPS.includes(group)) {
      const before = options[group].length;
      options[group] = options[group].filter((v) => v !== value);
      if (options[group].length === before) return sendJSON(res, 404, { error: '항목을 찾을 수 없습니다.' });
    } else if (group === 'rules') {
      const before = options.rules.length;
      options.rules = options.rules.filter((r) => r.id !== value);
      if (options.rules.length === before) return sendJSON(res, 404, { error: '항목을 찾을 수 없습니다.' });
    } else if (group === 'staff' || group === 'sites') {
      const before = options[group].length;
      // value 는 "부서|이름" 또는 "공장|동|구역" 형태의 합성 키
      options[group] = options[group].filter((item) => itemKey(group, item) !== value);
      if (options[group].length === before) return sendJSON(res, 404, { error: '항목을 찾을 수 없습니다.' });
      if (!options[group].length) return sendJSON(res, 400, { error: '최소 한 개는 남아 있어야 합니다.' });
    } else if (group === 'categories') {
      if (options.categories.length <= 1) {
        return sendJSON(res, 400, { error: '위험 유형은 최소 한 개는 남아 있어야 합니다.' });
      }
      const before = options.categories.length;
      options.categories = options.categories.filter((c) => c.key !== value);
      if (options.categories.length === before) return sendJSON(res, 404, { error: '항목을 찾을 수 없습니다.' });
    } else {
      return sendJSON(res, 400, { error: '알 수 없는 항목 종류입니다.' });
    }

    await enqueue(() => writeOptions(options));
    return sendJSON(res, 200, { options });
  }

  return sendJSON(res, 405, { error: '지원하지 않는 요청입니다.' });
}

/* ================================================================== 인증
   외부(인터넷)에 노출해도 아무나 기록을 보지 못하도록 공유 비밀번호를 요구한다.
   비밀번호는 data/access.json 에 평문으로 두어 담당자가 직접 열어 바꿀 수 있게 했다.
   ================================================================== */
let access = null;      // { password, salt }
let sessionToken = '';  // 비밀번호에서 파생된 값. 서버를 다시 켜도 로그인이 유지된다.

const COOKIE_NAME = 'si_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const loginFails = new Map(); // ip -> { count, lockUntil }

async function loadAccess() {
  if (process.env.ACCESS_PASSWORD) {
    return { password: String(process.env.ACCESS_PASSWORD), salt: 'env', fromEnv: true };
  }
  try {
    const parsed = JSON.parse(await readFile(ACCESS_FILE, 'utf8'));
    if (parsed && typeof parsed.password === 'string' && parsed.password.trim() && typeof parsed.salt === 'string') {
      return { password: String(parsed.password).trim(), salt: parsed.salt };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('비밀번호 파일을 읽지 못해 새로 만듭니다:', err.message);
  }
  const created = {
    password: String(Math.floor(100000 + Math.random() * 900000)),
    salt: randomBytes(16).toString('hex')
  };
  await writeFile(ACCESS_FILE, JSON.stringify(created, null, 2), 'utf8');
  created.isNew = true;
  return created;
}

function deriveToken(cfg) {
  return createHash('sha256').update(cfg.salt + ':' + cfg.password).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

function isAuthed(req) {
  return safeEqual(readCookie(req, COOKIE_NAME), sessionToken);
}

function clientIP(req) {
  return req.socket.remoteAddress || 'unknown';
}

/** 인증이 필요한 경로인지 판단한다. 로그인 자체와 UI 화면은 열어 둔다. */
function needsAuth(urlPath) {
  if (urlPath === '/api/login' || urlPath === '/api/session' || urlPath === '/api/logout') return false;
  return urlPath.startsWith('/api/') || urlPath.startsWith('/photos/');
}

async function handleAuth(req, res, urlPath) {
  if (urlPath === '/api/session' && req.method === 'GET') {
    return sendJSON(res, 200, { authenticated: isAuthed(req) });
  }

  if (urlPath === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return sendJSON(res, 200, { ok: true });
  }

  if (urlPath === '/api/login' && req.method === 'POST') {
    const ip = clientIP(req);
    const record = loginFails.get(ip);
    if (record && record.lockUntil > Date.now()) {
      const wait = Math.ceil((record.lockUntil - Date.now()) / 1000);
      return sendJSON(res, 429, { error: '입력을 여러 번 틀렸습니다. ' + wait + '초 뒤에 다시 시도해 주세요.' });
    }

    const body = await readBody(req);
    if (!safeEqual(String(body.password || ''), access.password)) {
      const next = { count: (record ? record.count : 0) + 1, lockUntil: 0 };
      if (next.count >= MAX_FAILS) {
        next.lockUntil = Date.now() + LOCK_MS;
        next.count = 0;
      }
      loginFails.set(ip, next);
      return sendJSON(res, 401, { error: '비밀번호가 맞지 않습니다.' });
    }

    loginFails.delete(ip);
    res.setHeader('Set-Cookie',
      COOKIE_NAME + '=' + sessionToken +
      '; Path=/; Max-Age=' + (SESSION_DAYS * 24 * 60 * 60) + '; HttpOnly; SameSite=Lax');
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 405, { error: '지원하지 않는 요청입니다.' });
}

/* ------------------------------------------------------------ 입력 검증 */

function text(value, maxLen) {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function findRule(id) {
  return options.rules.find((r) => r.id === id) || null;
}

function validateNew(body) {
  const category = findCategory(body.category);
  const rule = body.ruleId ? findRule(body.ruleId) : null;
  const rec = {
    date: isISODate(body.date) ? body.date : '',
    inspector: text(body.inspector, 50),
    attendees: text(body.attendees, 50),
    location: text(body.location, 100),
    category: category ? category.key : '',
    // 위험 유형은 나중에 지워질 수 있으므로 등록 시점의 내용을 기록에 함께 남긴다.
    categoryLabel: category ? category.label : '',
    // 매칭된 규칙이 있으면 그 내용을, 없으면 위험 유형 기본값을 기록에 남긴다.
    ruleId: rule ? rule.id : '',
    ruleTitle: rule ? rule.title : '',
    law: rule ? rule.law : (category ? category.law : ''),
    lawShort: rule ? rule.lawShort : (category ? category.lawShort : ''),
    penalty: rule ? rule.penalty : (category ? category.penalty : ''),
    summary: rule ? rule.summary : (category ? category.summary : ''),
    laws: rule ? rule.laws : (category ? category.laws : []),
    actions: rule ? rule.actions : (category ? category.actions : { immediate: [], short: [], long: [] }),
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

/* ============================================================ 사진 분석
   ANTHROPIC_API_KEY 가 있을 때만 켜지는 선택 기능.
   사진을 Claude에 보내 위험 유형과 지적사항 '초안'을 받아온다. 판단은 사람이 한다.
   ============================================================ */
let anthropic = null;

const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', description: '가장 알맞은 위험 유형의 key 값' },
    issue: { type: 'string', description: '점검대장에 적을 지적사항 초안. 한두 문장의 개조식 한국어.' },
    findings: {
      type: 'array',
      items: { type: 'string' },
      description: '사진에서 실제로 확인되는 위험요인. 추측이면 포함하지 않는다.'
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  },
  required: ['category', 'issue', 'findings', 'confidence'],
  additionalProperties: false
};

async function initAnalyze() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  } catch (err) {
    console.warn('사진 분석 기능을 켜지 못했습니다. `npm install` 후 다시 실행하세요:', err.message);
  }
}

function analyzeEnabled() {
  return Boolean(anthropic);
}

async function handleAnalyze(req, res) {
  if (req.method !== 'POST') return sendJSON(res, 405, { error: '지원하지 않는 요청입니다.' });
  if (!analyzeEnabled()) {
    return sendJSON(res, 503, { error: '사진 분석 기능이 꺼져 있습니다. 관리자에게 문의해 주세요.' });
  }

  const body = await readBody(req);
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.photo || ''));
  if (!match) return sendJSON(res, 400, { error: '분석할 사진을 먼저 첨부해 주세요.' });

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_PHOTO) return sendJSON(res, 400, { error: '사진 용량이 너무 큽니다.' });

  const catalog = options.categories
    .map((c) => '- ' + c.key + ': ' + c.label + (c.summary ? ' — ' + c.summary : ''))
    .join('\n');
  const hint = text(body.hint, 500);

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      system:
        '당신은 대한민국 산업안전보건법에 따른 사업장 순회점검을 보조합니다. ' +
        '현장 사진에서 실제로 보이는 위험요인만 지적하고, 보이지 않는 것은 추측하지 않습니다. ' +
        '결과는 점검 담당자가 검토·수정할 초안입니다.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/' + (match[1] === 'jpg' ? 'jpeg' : match[1]), data: match[2] } },
          {
            type: 'text',
            text:
              '이 현장 사진을 보고 안전보건 지적사항 초안을 작성해 주세요.\n\n' +
              '선택 가능한 위험 유형:\n' + catalog + '\n\n' +
              (hint ? '점검자 메모: ' + hint + '\n\n' : '') +
              'category 에는 위 목록의 key 값을 그대로 넣으세요. ' +
              '사진만으로 판단이 어려우면 confidence 를 low 로 하고 findings 를 비워 두세요.'
          }
        ]
      }],
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: ANALYZE_SCHEMA }
      }
    });

    if (response.stop_reason === 'refusal') {
      return sendJSON(res, 422, { error: '이 사진은 분석할 수 없습니다. 직접 입력해 주세요.' });
    }

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) return sendJSON(res, 502, { error: '분석 결과를 읽지 못했습니다.' });

    const result = JSON.parse(textBlock.text);
    if (!findCategory(result.category)) result.category = '';
    return sendJSON(res, 200, { result });
  } catch (err) {
    console.error('사진 분석 실패:', err);
    return sendJSON(res, 502, { error: '분석에 실패했습니다. 잠시 후 다시 시도하거나 직접 입력해 주세요.' });
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
      'Cache-Control': rel.startsWith('photos/') ? 'private, max-age=604800' : 'no-cache'
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
    const saved = { id, ...rec, photo, checks: {}, createdAt: new Date().toISOString() };

    await enqueue(async () => {
      const records = await readRecords();
      records.push(saved);
      await writeRecords(records);
    });
    await rememberValues({
      inspectors: saved.inspector,
      attendees: saved.attendees,
      locations: saved.location
    });
    return sendJSON(res, 201, { record: saved });
  }

  if (idMatch && req.method === 'PATCH') {
    const body = await readBody(req);
    const patch = {};
    if (STATUSES.includes(body.status)) patch.status = body.status;
    if (typeof body.action === 'string') patch.action = text(body.action, 300);
    if (body.checks && typeof body.checks === 'object' && !Array.isArray(body.checks)) {
      // { "immediate-0": true, ... } — 단계별 개선조치 완료 표시
      const checks = {};
      for (const [key, value] of Object.entries(body.checks).slice(0, 40)) {
        if (/^(immediate|short|long)-\d{1,2}$/.test(key)) checks[key] = Boolean(value);
      }
      patch.checks = checks;
    }
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
    if (urlPath === '/api/login' || urlPath === '/api/session' || urlPath === '/api/logout') {
      return await handleAuth(req, res, urlPath);
    }
    if (needsAuth(urlPath) && !isAuthed(req)) {
      return sendJSON(res, 401, { error: '로그인이 필요합니다.' });
    }
    if (urlPath.startsWith('/api/options')) return await handleOptions(req, res, urlPath);
    if (urlPath === '/api/analyze') return await handleAnalyze(req, res);
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
access = await loadAccess();
sessionToken = deriveToken(access);
await loadDefaultRules();
options = await readOptions();
await initAnalyze();

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
  console.log('  ----------------------------------------------------');
  console.log('   접속 비밀번호 : ' + access.password);
  console.log('  ----------------------------------------------------');
  if (access.isNew) {
    console.log('   * 비밀번호를 새로 만들었습니다. 이전에 쓰던 번호가 있었다면');
    console.log('     data\\access.json 파일이 지워진 것이니 담당자에게 알려 주세요.');
  }
  console.log('');
  console.log('  * 휴대폰은 이 컴퓨터와 같은 와이파이에 연결되어 있어야 합니다.');
  console.log('  * 점검 기록 저장 위치 : ' + RECORDS_FILE);
  console.log('  * 현장 사진 저장 위치 : ' + PHOTO_DIR);
  console.log('');
  console.log('  종료하려면 이 검은 창을 닫으세요. (창을 닫으면 접속도 끊깁니다)');
  console.log('');

  // 실행기(서버 시작.bat)로 켰을 때만, 서버가 준비된 뒤 브라우저를 연다.
  if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', 'http://localhost:' + PORT + '/'], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  }
});
