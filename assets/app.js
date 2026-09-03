/* ==========================================================================
   안전보건 순회점검 시스템
   - 점검 기록 등록 / 조회 / 조치상태 관리
   - 저장 방식: 공유 서버(API)가 있으면 서버, 없으면 브라우저 localStorage
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'safety-inspection.records.v1';
  // 문서 위치 기준 상대 경로 — 서브 경로에 배포해도 동작한다.
  var API_BASE = new URL('api/records', document.baseURI).href;
  var PHOTO_MAX_EDGE = 1000;   // 저장 전 이미지 최대 변 길이(px)
  var PHOTO_QUALITY = 0.7;     // JPEG 압축 품질

  /* ---------------------------------------------------------------- 법령 DB */
  var RISK_DB = {
    machine: {
      label: '기계·기구',
      law: '산업안전보건법 제38조 / 안전보건규칙 제87조',
      lawShort: '산안규칙 제87조',
      summary: '위험 기계 가동 중 방호장치를 임의 해제하였거나 정상 작동하지 않는 상태입니다.',
      guide: ['해당 기계 가동 즉시 중지', '방호장치 점검 및 교체', '관리감독자 확인 후 작업 재개']
    },
    fall: {
      label: '추락·전도',
      law: '산업안전보건기준에 관한 규칙 제42조',
      lawShort: '산안규칙 제42조',
      summary: '고소 작업 구간에 안전난간이 설치되지 않았거나 안전대를 체결하지 않은 상태입니다.',
      guide: ['해당 구간 작업 즉시 중단', '표준 안전난간 설치', '전신형 안전대 체결 상태 확인']
    },
    electric: {
      label: '전기설비',
      law: '산업안전보건기준에 관한 규칙 제301조',
      lawShort: '산안규칙 제301조',
      summary: '배·분전반 충전부가 노출되어 감전 위험이 있는 상태입니다.',
      guide: ['분전반 주변 정리 및 접근 통제', '절연 덮개 설치', '감전주의 경고표지 부착']
    },
    chemical: {
      label: '화학물질',
      law: '산업안전보건법 제110조 / 제114조',
      lawShort: '산안법 제110조',
      summary: 'MSDS 경고표시가 누락되었거나 적합한 보호구를 착용하지 않은 상태입니다.',
      guide: ['해당 작업 일시 중지', 'MSDS 경고표지 부착 및 게시', '방독마스크 등 보호구 지급·착용']
    },
    fire: {
      label: '화재·폭발',
      law: '산업안전보건기준에 관한 규칙 제241조',
      lawShort: '산안규칙 제241조',
      summary: '인화성 물질 취급 장소에서 화기 작업 중 소화설비가 배치되지 않았습니다.',
      guide: ['화기 작업 중단', '소화기 배치 및 화재감시인 지정', '화기작업 허가서 재확인']
    },
    etc: {
      label: '기타',
      law: '산업안전보건법 제5조 (사업주의 일반적 의무)',
      lawShort: '산안법 제5조',
      summary: '사업주는 근로자의 안전과 건강을 유지·증진시킬 의무가 있습니다.',
      guide: ['위험요인 확인 및 작업 중지 검토', '개선 조치 계획 수립', '조치 완료 후 관리감독자 확인']
    }
  };

  var STATUSES = ['완료', '진행중', '보류'];

  /* ------------------------------------------------------------- DOM 참조 */
  var $ = function (id) { return document.getElementById(id); };

  var form = $('inspectionForm');
  var els = {
    date: $('inspectDate'),
    inspector: $('inspector'),
    attendees: $('attendees'),
    location: $('location'),
    category: $('category'),
    issue: $('issue'),
    photoInput: $('photoInput'),
    previewBox: $('previewBox'),
    imgPreview: $('imgPreview'),
    removePhoto: $('removePhoto'),
    completeCheck: $('completeCheck'),
    formError: $('formError'),
    submitBtn: $('submitBtn'),
    sampleBtn: $('sampleBtn'),
    resultArea: $('resultArea'),
    currentBody: $('currentBody'),
    pastBody: $('pastBody'),
    monthFilter: $('monthFilter'),
    tabCurrent: $('tabCurrent'),
    tabPast: $('tabPast'),
    panelCurrent: $('panelCurrent'),
    panelPast: $('panelPast'),
    printResult: $('printResult'),
    printHistory: $('printHistory'),
    refreshBtn: $('refreshBtn'),
    conn: $('connState'),
    connText: $('connText'),
    statTotal: $('statTotal'),
    statDone: $('statDone'),
    statDoing: $('statDoing'),
    statHold: $('statHold')
  };

  /* ------------------------------------------------------------- 유틸리티 */
  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function currentMonth() { return todayISO().slice(0, 7); }

  function formatDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    return p[0] + '.' + p[1] + '.' + p[2];
  }

  function formatMonth(ym) {
    var p = ym.split('-');
    return p[0] + '년 ' + Number(p[1]) + '월';
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function makeId() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ================================================================ 저장소
     mode = 'server' : 공유 서버의 파일에 저장 (여러 기기에서 함께 열람)
     mode = 'local'  : 서버가 없을 때 이 기기의 브라우저에만 저장
     ================================================================ */
  var store = {
    mode: 'local',
    records: []
  };

  function api(pathSuffix, options) {
    return fetch(API_BASE + (pathSuffix || ''), options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || '서버 오류 (' + res.status + ')');
        return data;
      });
    });
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedRecords();
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('점검 기록을 불러오지 못했습니다.', err);
      return [];
    }
  }

  function writeLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.records));
      return true;
    } catch (err) {
      console.error('저장 실패', err);
      window.alert(
        '저장 공간이 부족하여 기록을 저장하지 못했습니다.\n' +
        '오래된 점검 이력을 삭제한 뒤 다시 시도해 주세요.'
      );
      return false;
    }
  }

  /** 로컬 모드 최초 실행 시 과거 이력 탭이 비어 보이지 않도록 예시 1건을 넣는다. */
  function seedRecords() {
    var d = new Date();
    d.setMonth(d.getMonth() - 1, 12);
    var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-12';
    return [{
      id: makeId(),
      date: iso,
      inspector: '최필재 부장',
      attendees: '공정팀장',
      location: '제2공장 자재 적재구역',
      category: 'fall',
      issue: '2단 적재 구간 안전난간 미설치 상태로 작업 진행',
      status: '완료',
      action: '표준 안전난간 설치 완료',
      photo: '',
      createdAt: iso
    }];
  }

  /** 서버 연결을 시도하고 실패하면 로컬 모드로 내려간다. */
  store.init = function () {
    return api('', { headers: { 'Accept': 'application/json' } })
      .then(function (data) {
        store.mode = 'server';
        store.records = Array.isArray(data.records) ? data.records : [];
      })
      .catch(function (err) {
        console.info('공유 서버에 연결할 수 없어 이 기기에만 저장합니다.', err.message);
        store.mode = 'local';
        store.records = readLocal();
        writeLocal();
      })
      .then(renderConnState);
  };

  store.reload = function () {
    if (store.mode !== 'server') return Promise.resolve();
    return api('').then(function (data) {
      store.records = Array.isArray(data.records) ? data.records : [];
    });
  };

  store.add = function (rec) {
    if (store.mode === 'server') {
      return api('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec)
      }).then(function (data) {
        store.records.push(data.record);
        return data.record;
      });
    }
    var local = Object.assign({ id: makeId(), createdAt: new Date().toISOString() }, rec);
    store.records.push(local);
    if (!writeLocal()) {
      store.records.pop();
      return Promise.reject(new Error('저장 공간이 부족합니다.'));
    }
    return Promise.resolve(local);
  };

  store.update = function (id, patch) {
    var target = store.find(id);
    if (!target) return Promise.reject(new Error('기록을 찾을 수 없습니다.'));
    var before = { status: target.status, action: target.action };
    Object.assign(target, patch);

    if (store.mode === 'server') {
      return api('/' + id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }).catch(function (err) {
        Object.assign(target, before); // 실패 시 화면 값 되돌리기
        throw err;
      });
    }
    writeLocal();
    return Promise.resolve();
  };

  store.remove = function (id) {
    if (store.mode === 'server') {
      return api('/' + id, { method: 'DELETE' }).then(function () {
        store.records = store.records.filter(function (r) { return r.id !== id; });
      });
    }
    store.records = store.records.filter(function (r) { return r.id !== id; });
    writeLocal();
    return Promise.resolve();
  };

  store.find = function (id) {
    for (var i = 0; i < store.records.length; i++) {
      if (store.records[i].id === id) return store.records[i];
    }
    return null;
  };

  function renderConnState() {
    var isServer = store.mode === 'server';
    els.conn.dataset.mode = isServer ? 'server' : 'local';
    els.connText.textContent = isServer
      ? '공유 서버 연결됨 — 등록한 기록을 다른 기기에서도 볼 수 있습니다.'
      : '이 기기에만 저장 중 — 브라우저를 바꾸면 기록이 보이지 않습니다.';
    els.conn.hidden = false;
    els.refreshBtn.hidden = !isServer;
  }

  function reportError(err) {
    console.error(err);
    window.alert('처리에 실패했습니다.\n' + (err && err.message ? err.message : '잠시 후 다시 시도해 주세요.'));
  }

  /* ------------------------------------------------------------ 이미지 처리 */
  var pendingPhoto = '';

  function compressImage(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        try {
          cb(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
        } catch (err) {
          cb(e.target.result); // 캔버스 사용 불가 시 원본 사용
        }
      };
      img.onerror = function () { cb(''); };
      img.src = e.target.result;
    };
    reader.onerror = function () { cb(''); };
    reader.readAsDataURL(file);
  }

  function setPreview(dataUrl) {
    pendingPhoto = dataUrl || '';
    if (pendingPhoto) {
      els.imgPreview.src = pendingPhoto;
      els.previewBox.hidden = false;
    } else {
      els.imgPreview.removeAttribute('src');
      els.previewBox.hidden = true;
      els.photoInput.value = '';
    }
  }

  /* ------------------------------------------------------------- 결과 렌더 */
  function renderResult(rec) {
    var db = RISK_DB[rec.category] || RISK_DB.etc;
    var photoHTML = rec.photo
      ? '<div class="result-card result-card--photo result-card--wide">' +
          '<h3>현장 사진</h3>' +
          '<img src="' + escapeHTML(rec.photo) + '" alt="' + escapeHTML(rec.location) + ' 현장 사진">' +
        '</div>'
      : '';

    var guideHTML = db.guide.map(function (g) {
      return '<li>' + escapeHTML(g) + '</li>';
    }).join('');

    els.resultArea.innerHTML =
      '<div class="result-meta">' +
        '<span>점검일 <b>' + formatDate(rec.date) + '</b></span>' +
        '<span>장소 <b>' + escapeHTML(rec.location) + '</b></span>' +
        '<span>담당 <b>' + escapeHTML(rec.inspector) + '</b></span>' +
        '<span>입회 <b>' + escapeHTML(rec.attendees) + '</b></span>' +
      '</div>' +
      '<div class="result-grid">' +
        '<div class="result-card">' +
          '<h3>지적사항 (' + escapeHTML(db.label) + ')</h3>' +
          '<p>' + escapeHTML(rec.issue) + '</p>' +
        '</div>' +
        '<div class="result-card result-card--law">' +
          '<h3>관련 법조항</h3>' +
          '<p><strong>' + escapeHTML(db.law) + '</strong></p>' +
          '<p style="margin-top:6px">' + escapeHTML(db.summary) + '</p>' +
        '</div>' +
        photoHTML +
        '<div class="result-card result-card--action result-card--wide">' +
          '<h3>개선 조치 가이드</h3>' +
          '<ol>' + guideHTML + '</ol>' +
        '</div>' +
      '</div>';
  }

  /* -------------------------------------------------------------- 표 렌더 */
  function rowHTML(rec) {
    var db = RISK_DB[rec.category] || RISK_DB.etc;
    var options = STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === rec.status ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    var thumb = rec.photo
      ? '<img class="thumb" src="' + escapeHTML(rec.photo) + '" alt="' + escapeHTML(rec.location) + ' 현장 사진" loading="lazy">'
      : '';

    return '' +
      '<tr data-id="' + escapeHTML(rec.id) + '">' +
        '<td data-label="점검일"><span class="cell-body">' +
            '<span class="cell-main">' + formatDate(rec.date) + '</span>' +
            '<span class="cell-sub">' + escapeHTML(rec.location) + '</span>' + thumb + '</span></td>' +
        '<td data-label="담당"><span class="cell-body">' +
            '<span class="cell-main">' + escapeHTML(rec.inspector) + '</span>' +
            '<span class="cell-sub">' + escapeHTML(rec.attendees) + '</span></span></td>' +
        '<td data-label="위험유형"><span class="cell-body">' + escapeHTML(db.label) + '</span></td>' +
        '<td data-label="법조항"><span class="cell-body">' + escapeHTML(db.lawShort) + '</span></td>' +
        '<td data-label="조치상태"><span class="cell-body">' +
            '<label class="sr-only" for="st-' + escapeHTML(rec.id) + '">조치상태</label>' +
            '<select class="status-select" id="st-' + escapeHTML(rec.id) + '" data-status="' + rec.status + '" data-action="status">' +
              options +
            '</select></span></td>' +
        '<td data-label="조치내용"><span class="cell-body">' +
            '<label class="sr-only" for="ac-' + escapeHTML(rec.id) + '">조치내용</label>' +
            '<input class="action-input" id="ac-' + escapeHTML(rec.id) + '" data-action="note" type="text" ' +
              'value="' + escapeHTML(rec.action) + '" placeholder="조치내용 입력">' +
            '<div class="cell-note">' + escapeHTML(rec.status) + ' · ' + formatDate(rec.date) + '</div></span></td>' +
        '<td class="col-manage">' +
          '<button type="button" class="btn-del" data-action="delete" ' +
            'aria-label="' + formatDate(rec.date) + ' ' + escapeHTML(rec.location) + ' 점검 이력 삭제">삭제</button>' +
        '</td>' +
      '</tr>';
  }

  function emptyRow(msg) {
    return '<tr class="row-empty"><td colspan="7">' + msg + '</td></tr>';
  }

  function sortByDateDesc(a, b) {
    if (a.date === b.date) return (b.createdAt || '').localeCompare(a.createdAt || '');
    return b.date < a.date ? -1 : 1;
  }

  function renderTables() {
    var cm = currentMonth();
    var current = store.records.filter(function (r) { return r.date.slice(0, 7) === cm; }).sort(sortByDateDesc);
    var past = store.records.filter(function (r) { return r.date.slice(0, 7) !== cm; }).sort(sortByDateDesc);

    els.currentBody.innerHTML = current.length
      ? current.map(rowHTML).join('')
      : emptyRow('당월 등록된 점검 이력이 없습니다.');

    renderMonthFilter(past);

    var selected = els.monthFilter.value;
    var filtered = selected === 'all'
      ? past
      : past.filter(function (r) { return r.date.slice(0, 7) === selected; });

    els.pastBody.innerHTML = filtered.length
      ? filtered.map(rowHTML).join('')
      : emptyRow('해당 기간의 점검 이력이 없습니다.');

    renderStats();
  }

  function renderMonthFilter(past) {
    var months = [];
    past.forEach(function (r) {
      var ym = r.date.slice(0, 7);
      if (months.indexOf(ym) === -1) months.push(ym);
    });
    months.sort().reverse();

    var prev = els.monthFilter.value;
    var html = '<option value="all">전체 기간</option>' + months.map(function (m) {
      return '<option value="' + m + '">' + formatMonth(m) + '</option>';
    }).join('');

    if (html !== els.monthFilter.innerHTML) {
      els.monthFilter.innerHTML = html;
      els.monthFilter.value = months.indexOf(prev) !== -1 ? prev : 'all';
    }
  }

  function renderStats() {
    var done = 0, doing = 0, hold = 0;
    store.records.forEach(function (r) {
      if (r.status === '완료') done++;
      else if (r.status === '진행중') doing++;
      else hold++;
    });
    els.statTotal.textContent = store.records.length;
    els.statDone.textContent = done;
    els.statDoing.textContent = doing;
    els.statHold.textContent = hold;
  }

  /* ------------------------------------------------------------- 폼 검증 */
  function showError(msg, target) {
    els.formError.textContent = msg;
    els.formError.hidden = false;
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      target.focus();
    }
  }

  function clearError() {
    els.formError.hidden = true;
    els.formError.textContent = '';
    [els.date, els.inspector, els.attendees, els.location, els.category, els.issue]
      .forEach(function (el) { el.removeAttribute('aria-invalid'); });
  }

  function validate() {
    var checks = [
      [els.date, '점검일자를 입력해 주세요.'],
      [els.inspector, '점검 담당자를 입력해 주세요.'],
      [els.attendees, '입회자를 입력해 주세요.'],
      [els.location, '점검 장소를 입력해 주세요.'],
      [els.category, '위험 유형을 선택해 주세요.'],
      [els.issue, '현장 지적사항을 입력해 주세요.']
    ];
    for (var i = 0; i < checks.length; i++) {
      if (!checks[i][0].value.trim()) {
        showError(checks[i][1], checks[i][0]);
        return false;
      }
    }
    if (!els.completeCheck.checked) {
      showError('확인 및 등록 동의 항목을 체크해 주세요.', els.completeCheck);
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------ 이벤트 처리 */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();
    if (!validate()) return;

    var payload = {
      date: els.date.value,
      inspector: els.inspector.value.trim(),
      attendees: els.attendees.value.trim(),
      location: els.location.value.trim(),
      category: els.category.value,
      issue: els.issue.value.trim(),
      status: '진행중',
      action: '',
      photo: pendingPhoto
    };

    els.submitBtn.disabled = true;
    els.submitBtn.textContent = '등록 중…';

    store.add(payload)
      .then(function (saved) {
        renderResult(saved);
        switchTab(saved.date.slice(0, 7) === currentMonth() ? 'current' : 'past');
        renderTables();

        els.issue.value = '';
        els.completeCheck.checked = false;
        setPreview('');
        els.resultArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(reportError)
      .then(function () {
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = '점검 결과 등록';
      });
  });

  els.photoInput.addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return setPreview('');
    compressImage(file, setPreview);
  });

  els.removePhoto.addEventListener('click', function () { setPreview(''); });

  els.sampleBtn.addEventListener('click', function () {
    clearError();
    els.date.value = todayISO();
    els.inspector.value = '최필재 부장';
    els.attendees.value = '생산팀장';
    els.location.value = '제1공장 프레스 2호기';
    els.category.value = 'machine';
    els.issue.value = '프레스 광전자식 방호장치가 고장 난 상태로 작업이 진행되고 있음';
    els.completeCheck.checked = true;
  });

  /* 표 내부 이벤트 위임 */
  function bindTableEvents(tbody) {
    tbody.addEventListener('change', function (e) {
      var el = e.target;
      var row = el.closest && el.closest('tr');
      if (!row) return;
      var id = row.getAttribute('data-id');
      var rec = store.find(id);
      if (!rec) return;

      if (el.dataset.action === 'status') {
        var note = row.querySelector('.cell-note');
        store.update(id, { status: el.value })
          .then(function () {
            el.setAttribute('data-status', rec.status);
            if (note) note.textContent = rec.status + ' · ' + formatDate(rec.date);
            renderStats();
          })
          .catch(function (err) {
            el.value = rec.status; // 서버 반영 실패 시 원래 값 복구
            reportError(err);
          });
      } else if (el.dataset.action === 'note') {
        store.update(id, { action: el.value }).catch(function (err) {
          el.value = rec.action;
          reportError(err);
        });
      }
    });

    tbody.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-action="delete"]');
      if (!btn) return;
      var row = btn.closest('tr');
      var rec = store.find(row.getAttribute('data-id'));
      if (!rec) return;
      if (!window.confirm(formatDate(rec.date) + ' ' + rec.location + ' 점검 이력을 삭제하시겠습니까?')) return;

      btn.disabled = true;
      store.remove(rec.id)
        .then(renderTables)
        .catch(function (err) {
          btn.disabled = false;
          reportError(err);
        });
    });
  }

  bindTableEvents(els.currentBody);
  bindTableEvents(els.pastBody);

  els.monthFilter.addEventListener('change', renderTables);

  /* 다른 기기에서 등록한 내용 불러오기 */
  function refresh() {
    if (store.mode !== 'server') return;
    els.refreshBtn.disabled = true;
    store.reload()
      .then(renderTables)
      .catch(reportError)
      .then(function () { els.refreshBtn.disabled = false; });
  }

  els.refreshBtn.addEventListener('click', refresh);

  var lastRefresh = Date.now();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || Date.now() - lastRefresh < 10000) return;
    lastRefresh = Date.now();
    refresh();
  });

  /* 탭 */
  function switchTab(name) {
    var isCurrent = name === 'current';
    els.tabCurrent.classList.toggle('is-active', isCurrent);
    els.tabPast.classList.toggle('is-active', !isCurrent);
    els.tabCurrent.setAttribute('aria-selected', String(isCurrent));
    els.tabPast.setAttribute('aria-selected', String(!isCurrent));
    els.panelCurrent.hidden = !isCurrent;
    els.panelPast.hidden = isCurrent;
  }

  els.tabCurrent.addEventListener('click', function () { switchTab('current'); });
  els.tabPast.addEventListener('click', function () { switchTab('past'); });

  /* 인쇄 — 대상 패널만 출력 */
  function printPanel(panel, bodyClass) {
    panel.classList.add('is-print-target');
    document.body.classList.add(bodyClass);
    var cleanup = function () {
      panel.classList.remove('is-print-target');
      document.body.classList.remove(bodyClass);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    window.setTimeout(cleanup, 1000); // afterprint 미지원 브라우저 대비
  }

  els.printResult.addEventListener('click', function () {
    printPanel(els.resultArea.closest('.panel'), 'print-target-result');
  });
  els.printHistory.addEventListener('click', function () {
    printPanel(els.tabCurrent.closest('.panel'), 'print-target-history');
  });

  /* --------------------------------------------------------------- 초기화 */
  els.date.value = todayISO();
  store.init().then(renderTables);
})();
