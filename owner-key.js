/* 사장님 열쇠 — 사장님 전용 앱(관리자·정산견적·현장견적)에 다는 공용 파일. 같은 내용을 두 저장소(songil, autoblog)에 복사해서 쓴다.

   하는 일
   1) 기기 등록: 주소에 #key=열쇠 가 붙어 열리면 그 기기에 열쇠를 저장하고 주소창에서 지운다(한 번만).
   2) fetch 를 감싸서, 사장님 전용 웹훅으로 가는 요청에만 x-owner-key 헤더를 붙인다.
      → n8n 이 헤더 인증으로 열쇠를 확인한다. 호출하는 코드는 하나도 안 고친다.
   3) 서버가 401/403 으로 거절하면 "이 기기는 등록되지 않았습니다" 안내를 띄운다.

   주의
   - 열쇠는 이 파일에 없다. 사장님이 만든 값이 기기 localStorage('ownerKey') 와 n8n 자격증명에만 있다.
   - 팀원용 앱(worker)·고객용 화면에는 이 파일을 달지 않는다. 그래야 그쪽에서는 전용 웹훅을 부를 수 없다.
   - 저장소는 주소(origin)별이라 jayunsu22.github.io 와 songil.netlify.app 에서 각각 한 번씩 등록한다.
   - 사장님 전용 경로 목록(OWNER_PATHS)을 바꾸면 두 저장소 복사본을 같이 고친다.
   설계: 로컬 문서 webhook-security-design.md */
(function () {
  var BASE = 'https://primary-production-a6fa.up.railway.app/webhook/';
  var KEY_NAME = 'ownerKey';
  var HEADER = 'x-owner-key';

  var OWNER_PATHS = {};
  [
    // 현장견적·정산견적·저장함 (별도 워크플로우)
    'pro-master', 'pro-publish', 'pro-photo', 'pro-box-sync', 'pro-box-restore', 'pro-box-photo', 'pro-box-photos',
    'settle-master', 'settle-publish', 'settle-settings', 'owner-check',
    // 관리자 앱 (품질관리 워크플로우 안의 사장님 전용)
    'film-admin-get-v2', 'film-blog-publish', 'film-checkpoint-template-create',
    'film-journal-create', 'film-journal-list', 'film-journal-photo-upload', 'film-journal-photo-delete',
    'film-notice-create', 'film-sample-photo-upload', 'film-sample-photo-delete', 'raw-photo-update', 'raw-photo-upload'
  ].forEach(function (p) { OWNER_PATHS[p] = true; });

  function readKey() { try { return localStorage.getItem(KEY_NAME) || ''; } catch (e) { return ''; } }

  // ---- 안내 띄우기 (화면 아래 띠) ----
  function banner(text, ok) {
    function show() {
      var old = document.getElementById('ownerKeyBanner');
      if (old) old.remove();
      var b = document.createElement('div');
      b.id = 'ownerKeyBanner';
      b.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483000;padding:12px 14px;border-radius:12px;' +
        'font:700 14px/1.4 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#fff;' +
        'background:' + (ok ? '#047857' : '#b91c1c') + ';box-shadow:0 4px 16px rgba(0,0,0,.3)';
      b.textContent = text + '  (눌러서 닫기)';
      b.onclick = function () { b.remove(); };
      document.body.appendChild(b);
      if (ok) setTimeout(function () { if (b.parentNode) b.remove(); }, 4000);
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }

  // ---- 1) 기기 등록 ----
  var m = /[#&]key=([^&]+)/.exec(location.hash || '');
  if (m) {
    var key = '';
    try { key = decodeURIComponent(m[1]); } catch (e) { key = m[1]; }
    var saved = false;
    try { localStorage.setItem(KEY_NAME, key); saved = true; } catch (e) { /* 저장소를 못 쓰면 알린다 */ }
    // 열쇠가 주소 기록에 남지 않게 바로 지운다
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 무시 */ }
    banner(saved ? '이 기기를 등록했습니다. 이제 사장님 전용 기능을 쓸 수 있습니다.' : '이 기기에는 열쇠를 저장하지 못했습니다(브라우저 저장소가 막혀 있음).', saved);
  }

  // ---- 2)·3) fetch 감싸기 ----
  if (typeof window.fetch !== 'function') return;
  var origFetch = window.fetch;
  var warned = false;

  function ownerPathOf(input) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf(BASE) !== 0) return '';
    var path = url.slice(BASE.length).split('?')[0].split('#')[0];
    return OWNER_PATHS[path] ? path : '';
  }

  window.fetch = function (input, init) {
    var path = ownerPathOf(input);
    if (!path) return origFetch.apply(this, arguments);
    var k = readKey();
    var args = arguments;
    if (k) {
      var next = Object.assign({}, init || {});
      var h = new Headers(next.headers || (typeof input !== 'string' && input && input.headers) || undefined);
      h.set(HEADER, k);
      next.headers = h;
      args = [input, next];
    }
    return origFetch.apply(this, args).then(function (res) {
      if ((res.status === 401 || res.status === 403) && !warned) {
        warned = true;
        banner(k ? '사장님 열쇠가 맞지 않습니다. 등록 링크로 이 기기를 다시 등록하세요.' : '이 기기는 아직 등록되지 않았습니다. 등록 링크로 한 번 열어주세요.', false);
      }
      return res;
    });
  };
})();
