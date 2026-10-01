/* 공용 "내 앱" 전환 패널 - 여러 저장소(autoblog/songil/sitenote)에 동일한 내용으로 복사해서 씀.
   사용법: <script src="app-switcher.js?v=YYYYMMDD" data-app-id="settle"></script>
   data-app-id가 기본 목록 항목의 id와 같으면 그 줄이 "지금 보는 중"으로 표시됨.
   목록 수정(순서/이름/추가/삭제)은 localStorage에 저장되며, 같은 도메인 안의 앱끼리만 공유됨
   (예: songil.netlify.app 쪽 7개 앱은 서로 공유, autoblog/sitenote는 각자 따로). */
(function () {
  var STORAGE_KEY = 'myAppSwitcherList_v1';

  var DEFAULT_APPS = [
    { id: 'admin', name: '필름현장관리자', icon: '🏢', url: 'https://jayunsu22.github.io/autoblog/admin.html' },
    { id: 'settle', name: '현장 정산견적', icon: '🧮', url: 'https://songil.netlify.app/settle.html' },
    { id: 'worker', name: '현장 품질관리', icon: '📸', url: 'https://songil.netlify.app/worker/' },
    { id: 'quote1min', name: '1분견적', icon: '⚡', url: 'https://songil.netlify.app/' },
    { id: 'filmfind', name: '1분견적 필름찾기', icon: '🎨', url: 'https://songil.netlify.app/film/' },
    { id: 'apply', name: '1분견적 무료가입', icon: '✍️', url: 'https://songil.netlify.app/apply.html' },
    { id: 'partners', name: '1분견적 파트너스', icon: '🤝', url: 'https://songil.netlify.app/dashboard_index.html' },
    { id: 'quotepro', name: '현장방문견적', icon: '🏠', url: 'https://songil.netlify.app/quote_pro.html' },
    { id: 'schedule', name: '현장 일정관리', icon: '📅', url: 'https://jayunsu22.github.io/sitenote/schedule.html' },
    { id: 'goals', name: '삶의 목표', icon: '🎯', url: 'https://claude.ai/artifact/Uf2gMJz2KhDvLq1WxdER7c' }
  ];

  var currentScript = document.currentScript;
  var currentAppId = currentScript ? currentScript.getAttribute('data-app-id') : '';

  function loadList() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_APPS.slice();
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_APPS.slice();
      return parsed;
    } catch (e) {
      return DEFAULT_APPS.slice();
    }
  }
  function saveList(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* 시크릿 모드 등 */ }
  }

  var editing = false;

  function injectStyle() {
    var css = ''
      + '.aswBtn{position:fixed;top:50%;right:6px;transform:translateY(-50%);z-index:99998;'
      + 'width:40px;height:40px;border-radius:50%;background:rgba(37,99,235,.85);color:#fff;border:none;'
      + 'display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.25);cursor:pointer;padding:0;}'
      + '.aswOverlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:99999;display:none;}'
      + '.aswOverlay.on{display:block;}'
      + '.aswPanel{position:absolute;top:0;left:0;right:0;max-height:88vh;overflow:auto;background:#fff;'
      + 'border-radius:0 0 16px 16px;padding-top:env(safe-area-inset-top);box-shadow:0 8px 24px rgba(0,0,0,.2);}'
      + '.aswHead{display:flex;align-items:center;justify-content:space-between;padding:14px 14px 10px;'
      + 'border-bottom:1px solid #eee;}'
      + '.aswHead h2{font-size:16px;font-weight:800;margin:0;color:#111;}'
      + '.aswHeadBtns{display:flex;gap:8px;}'
      + '.aswHeadBtns button{border:1.5px solid #ddd;background:#fff;border-radius:8px;padding:6px 10px;'
      + 'font-size:12.5px;font-weight:700;cursor:pointer;color:#333;}'
      + '.aswHeadBtns button.active{background:#2563eb;border-color:#2563eb;color:#fff;}'
      + '.aswRow{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid #f0f0f0;'
      + 'text-decoration:none;color:inherit;}'
      + '.aswRow.current{background:#eff6ff;}'
      + '.aswIcon{font-size:20px;width:26px;text-align:center;flex-shrink:0;}'
      + '.aswName{flex:1;font-size:14.5px;font-weight:600;color:#222;min-width:0;overflow:hidden;'
      + 'text-overflow:ellipsis;white-space:nowrap;}'
      + '.aswName input{width:100%;font-size:14px;font-weight:600;padding:6px 8px;border:1.5px solid #ccc;'
      + 'border-radius:6px;box-sizing:border-box;}'
      + '.aswDot{width:6px;height:6px;border-radius:50%;background:#2563eb;flex-shrink:0;}'
      + '.aswTag{font-size:11px;color:#2563eb;font-weight:700;flex-shrink:0;}'
      + '.aswEditBtns{display:flex;gap:4px;flex-shrink:0;}'
      + '.aswEditBtns button{width:26px;height:26px;border:1px solid #ddd;background:#fafafa;border-radius:6px;'
      + 'font-size:12px;cursor:pointer;padding:0;color:#444;}'
      + '.aswEditBtns button.del{color:#c0392b;border-color:#f0c0c0;background:#fff5f5;}'
      + '.aswAddRow{padding:12px 14px;border-bottom:1px solid #f0f0f0;}'
      + '.aswAddRow input{width:100%;font-size:13px;padding:7px 9px;border:1.5px solid #ddd;border-radius:7px;'
      + 'box-sizing:border-box;margin-bottom:6px;}'
      + '.aswAddRow button{width:100%;padding:8px;font-size:13px;font-weight:700;background:#2563eb;color:#fff;'
      + 'border:none;border-radius:7px;cursor:pointer;}'
      + '.aswReset{display:block;text-align:center;padding:10px;font-size:12px;color:#999;'
      + 'text-decoration:underline;cursor:pointer;background:none;border:none;width:100%;}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function svgGrid() {
    return '<svg width="16" height="16" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">'
      + '<rect x="1" y="1" width="6" height="6" rx="1.5"></rect>'
      + '<rect x="11" y="1" width="6" height="6" rx="1.5"></rect>'
      + '<rect x="1" y="11" width="6" height="6" rx="1.5"></rect>'
      + '<rect x="11" y="11" width="6" height="6" rx="1.5"></rect>'
      + '</svg>';
  }

  function render() {
    var list = loadList();
    var panel = document.getElementById('aswPanel');
    var html = ''
      + '<div class="aswHead"><h2>내 앱</h2><div class="aswHeadBtns">'
      + '<button id="aswEditToggle" class="' + (editing ? 'active' : '') + '">' + (editing ? '완료' : '편집') + '</button>'
      + '<button id="aswCloseBtn">✕</button>'
      + '</div></div>'
      + '<div id="aswList">';

    list.forEach(function (app, idx) {
      var isCurrent = currentAppId && app.id === currentAppId;
      if (editing) {
        html += '<div class="aswRow' + (isCurrent ? ' current' : '') + '">'
          + '<span class="aswIcon">' + app.icon + '</span>'
          + '<span class="aswName"><input type="text" data-idx="' + idx + '" value="' + escAttr(app.name) + '"></span>'
          + '<div class="aswEditBtns">'
          + '<button data-act="up" data-idx="' + idx + '"' + (idx === 0 ? ' disabled' : '') + '>▲</button>'
          + '<button data-act="down" data-idx="' + idx + '"' + (idx === list.length - 1 ? ' disabled' : '') + '>▼</button>'
          + '<button data-act="del" data-idx="' + idx + '" class="del">✕</button>'
          + '</div></div>';
      } else {
        html += '<a class="aswRow' + (isCurrent ? ' current' : '') + '" href="' + escAttr(app.url) + '">'
          + '<span class="aswIcon">' + app.icon + '</span>'
          + '<span class="aswName">' + escHtml(app.name) + '</span>'
          + (isCurrent ? '<span class="aswTag">지금 보는 중</span><span class="aswDot"></span>' : '')
          + '</a>';
      }
    });

    html += '</div>';

    if (editing) {
      html += '<div class="aswAddRow">'
        + '<input type="text" id="aswNewName" placeholder="앱 이름 (예: 새 견적 앱)">'
        + '<input type="text" id="aswNewUrl" placeholder="주소 (https://...)">'
        + '<button id="aswAddBtn">+ 추가</button>'
        + '</div>'
        + '<button class="aswReset" id="aswResetBtn">기본 목록으로 초기화</button>';
    }

    panel.innerHTML = html;
    bindPanelEvents();
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function bindPanelEvents() {
    var editToggle = document.getElementById('aswEditToggle');
    if (editToggle) editToggle.addEventListener('click', function () {
      if (editing) commitNameEdits();
      editing = !editing;
      render();
    });
    var closeBtn = document.getElementById('aswCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    document.querySelectorAll('.aswEditBtns button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var act = btn.getAttribute('data-act');
        var list = loadList();
        if (act === 'up' && idx > 0) {
          var tmp = list[idx - 1]; list[idx - 1] = list[idx]; list[idx] = tmp;
        } else if (act === 'down' && idx < list.length - 1) {
          var tmp2 = list[idx + 1]; list[idx + 1] = list[idx]; list[idx] = tmp2;
        } else if (act === 'del') {
          if (!confirm('"' + list[idx].name + '"을(를) 목록에서 지울까요?')) return;
          list.splice(idx, 1);
        }
        saveList(list);
        render();
      });
    });

    var addBtn = document.getElementById('aswAddBtn');
    if (addBtn) addBtn.addEventListener('click', function () {
      var nameInput = document.getElementById('aswNewName');
      var urlInput = document.getElementById('aswNewUrl');
      var name = nameInput.value.trim();
      var url = urlInput.value.trim();
      if (!name || !url) { alert('이름과 주소를 모두 입력해 주세요.'); return; }
      if (!/^https?:\/\//.test(url)) { alert('주소는 http:// 또는 https://로 시작해야 합니다.'); return; }
      var list = loadList();
      list.push({ id: 'custom' + Date.now(), name: name, icon: '🔗', url: url });
      saveList(list);
      render();
    });

    var resetBtn = document.getElementById('aswResetBtn');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      if (!confirm('지금까지 고친 목록을 지우고 기본 11개 앱으로 되돌릴까요?')) return;
      saveList(DEFAULT_APPS.slice());
      render();
    });
  }

  function commitNameEdits() {
    var inputs = document.querySelectorAll('#aswList .aswName input');
    if (inputs.length === 0) return;
    var list = loadList();
    inputs.forEach(function (inp) {
      var idx = parseInt(inp.getAttribute('data-idx'), 10);
      var v = inp.value.trim();
      if (v && list[idx]) list[idx].name = v;
    });
    saveList(list);
  }

  function openPanel() {
    var overlay = document.getElementById('aswOverlay');
    editing = false;
    render();
    overlay.classList.add('on');
  }
  function closePanel() {
    if (editing) commitNameEdits();
    editing = false;
    document.getElementById('aswOverlay').classList.remove('on');
  }

  function init() {
    injectStyle();

    var btn = document.createElement('button');
    btn.className = 'aswBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '내 앱 전환');
    btn.innerHTML = svgGrid();
    btn.addEventListener('click', openPanel);
    document.body.appendChild(btn);

    var overlay = document.createElement('div');
    overlay.className = 'aswOverlay';
    overlay.id = 'aswOverlay';
    overlay.innerHTML = '<div class="aswPanel" id="aswPanel"></div>';
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closePanel();
    });
    document.body.appendChild(overlay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
