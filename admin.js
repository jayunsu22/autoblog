window.onerror = function(message, source, lineno, colno, error) {
    alert("브라우저 자바스크립트 오류 발생!\n내용: " + message + "\n위치: " + source + " (줄번호: " + lineno + ")");
    return false;
};

document.addEventListener('DOMContentLoaded', async () => {

    // 지금 실제로 불러와진 admin.js 버전을 헤더에 표시 (캐시 때문에 옛날 버전이 떠 있는 건지
    // 바로 눈으로 확인하려고 - 값은 이 파일을 불러온 <script> 태그의 ?v= 그대로 읽어옴)
    try {
        const scriptEl = document.querySelector('script[src*="admin.js"]');
        const match = scriptEl && scriptEl.src.match(/[?&]v=([^&]+)/);
        const versionEl = document.getElementById('appVersionBadge');
        if (versionEl && match) versionEl.textContent = `v${match[1]}`;
    } catch (e) { /* 버전 표시 실패해도 앱 동작에는 영향 없음 */ }

    // 현장소장용 개별 링크 (admin.html?code=현장ID) - 다른 팀장에게 이 링크만 전달하면
    // 암호 없이 바로 그 현장 상세화면으로 들어가고, 다른 현장 목록/전역 설정은 안 보이게 잠가둠
    const urlParams = new URLSearchParams(window.location.search);
    const scopedProjectCode = urlParams.get('code');
    const isScopedManagerView = !!scopedProjectCode;

    // 0. 관리자 암호 잠금 (간단한 접근 차단용 - 강력한 보안은 아니고, 평문 대신 해시로만 비교)
    const ADMIN_PIN_HASH = '96cae35ce8a9b0244178bf28e4966c2ce1b8385723a96a6b838858cdd6ca0a1e';
    const ADMIN_UNLOCK_KEY = 'adminUnlocked';
    // 열려 있다는 표시는 암호 해시에서 따온 값이라, 암호를 바꾸면 이미 열려 있던 모든 기기가 한 번 잠긴다(예전 값 '1' 도 무효)
    const ADMIN_UNLOCK_VALUE = ADMIN_PIN_HASH.slice(0, 16);

    async function sha256Hex(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    window.submitAdminPin = function(event) {
        event.preventDefault();
        const input = document.getElementById('pinLockInput');
        const errorEl = document.getElementById('pinLockError');
        const value = (input.value || '').trim();
        sha256Hex(value).then(hash => {
            if (hash === ADMIN_PIN_HASH) {
                localStorage.setItem(ADMIN_UNLOCK_KEY, ADMIN_UNLOCK_VALUE);
                document.getElementById('pinLockOverlay').style.display = 'none';
                errorEl.style.display = 'none';
                runAdminInit();
            } else {
                errorEl.style.display = 'block';
                input.value = '';
                input.focus();
            }
        });
        return false;
    };

    // 공지설정 영역 접기/펼치기 - 한번 설정하면 자주 안 바뀌는 내용이라 기본은 접어둠
    window.toggleNoticeSection = function() {
        const body = document.getElementById('noticeSectionBody');
        const arrow = document.getElementById('noticeSectionToggleArrow');
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'flex';
        arrow.textContent = isOpen ? '▶ 펼치기' : '▼ 접기';
    };

    // 중점체크사항 영역 접기/펼치기 (공지설정과 동일한 패턴)
    window.toggleCheckpointSection = function() {
        const body = document.getElementById('checkpointSectionBody');
        const arrow = document.getElementById('checkpointSectionToggleArrow');
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'flex';
        arrow.textContent = isOpen ? '▶ 펼치기' : '▼ 접기';
    };

    window.lockAdminApp = function() {
        localStorage.removeItem(ADMIN_UNLOCK_KEY);
        location.reload();
    };

    // 모바일 브라우저가 예전 버전 페이지를 계속 들고 있는 경우가 있어서,
    // 매번 새로운 쿼리스트링을 붙여 강제로 새 페이지처럼 다시 불러오게 함 (bfcache/디스크캐시 우회)
    // 현장목록 캐시도 같이 지워서, 다시 열렸을 때 무조건 서버에서 진짜 최신 데이터를 새로 받아오게 함
    window.forceRefreshApp = function() {
        sessionStorage.removeItem('cachedAdminListData');
        clearDetailCaches(); // 현장 상세 캐시도 같이 비워서, 🔄를 누르면 목록/상세 모두 서버에서 새로 받아오게 함
        // 기존 쿼리스트링(예: 현장소장 링크의 ?code=...)은 그대로 유지한 채 캐시버스팅용 _r만 갱신 -
        // 예전처럼 pathname만으로 새로 만들면 ?code=가 날아가서 현장소장 링크의 범위 제한이 풀려버림
        const params = new URLSearchParams(window.location.search);
        params.set('_r', Date.now());
        window.location.href = window.location.pathname + '?' + params.toString();
    };

    // 1. 설정 및 글로벌 변수
    const n8nBase = "https://primary-production-a6fa.up.railway.app";
    // film-admin-get-v2: 기존 6개 순차조회(약 2.7~3.7초) 대신 6개 테이블을 동시조회(병렬)해서
    // 약 1.5~2초로 줄인 버전. 기존 film-admin-get 웹훅/노드는 그대로 살려뒀고(즉시 롤백용),
    // V1/V2 응답이 완전히 동일한지 꼼꼼히 검증(구조 비교, 신규 현장 생성/작업추가/완료 시나리오,
    // 동시요청 스트레스 테스트, 실제 화면 렌더링)한 뒤에 이 한 줄만 바꿔서 전환함.
    const API_ADMIN_GET_URL = `${n8nBase}/webhook/film-admin-get-v2`;
    // film-quality-get-v2: Airtable 조회를 동시에 보내도록 바꾼 버전 (2.2~2.4초 -> 약 1.3초).
    // 응답 모양은 기존과 완전히 동일하고, 현장명이 겹치는 현장끼리 서로의 작업을 끌어오던 문제도 같이 해결됨
    const API_DETAIL_URL = `${n8nBase}/webhook/film-quality-get-v2`;
    const API_SAVE_URL = `${n8nBase}/webhook/film-quality-save`;
    const API_PUBLISH_URL = `${n8nBase}/webhook/film-blog-publish`;
    const API_JOURNAL_CREATE_URL = `${n8nBase}/webhook/film-journal-create`;
    const API_JOURNAL_LIST_URL = `${n8nBase}/webhook/film-journal-list`;
    const API_JOURNAL_PHOTO_URL = `${n8nBase}/webhook/film-journal-photo-upload`;
    const API_JOURNAL_PHOTO_DELETE_URL = `${n8nBase}/webhook/film-journal-photo-delete`;
    const API_SAMPLE_PHOTO_URL = `${n8nBase}/webhook/film-sample-photo-upload`;
    const API_SAMPLE_PHOTO_DELETE_URL = `${n8nBase}/webhook/film-sample-photo-delete`;
    const API_RAW_PHOTO_UPLOAD_URL = `${n8nBase}/webhook/raw-photo-upload`; // 원본사진(기사 배정 없이 구역만 골라 바로 업로드) 전용
    const API_RAW_PHOTO_UPDATE_URL = `${n8nBase}/webhook/raw-photo-update`; // 이미 올라간 원본사진에 마킹을 다시 편집해서 덮어쓸 때 전용
    // 기사님용 워커 앱 주소. /w/<레코드ID> 형태.
    // 예전엔 github.io 정적 페이지(index.html?code=...)였는데, 정적 호스팅은 서버에서 og 태그를
    // 못 바꿔서 카톡 미리보기 카드가 어느 현장이든 늘 "현장 품질 관리 시스템"으로만 떴다.
    // 기사님이 링크만 보고는 어느 현장인지 알 수 없어서, 갤러리(/g/)·견적서(/q/)와 같은
    // Netlify 사이트로 옮겨 Edge Function 이 카드 제목에 현장명을 넣게 했다.
    const WORKER_APP_BASE_URL = "https://songil.netlify.app/w";
    // 외부 공유용 사진 갤러리(읽기 전용) 주소. /g/<레코드ID> 형태.
    // 예전엔 github.io 정적 페이지였는데, 정적 호스팅은 서버에서 og 태그를 못 바꿔서
    // 카톡 미리보기 카드가 늘 "사진 갤러리"로만 떴다. 견적서 링크(/q/)와 같은
    // Netlify 사이트로 옮겨 Edge Function 이 카드 제목에 현장명을 넣게 했다.
    const GALLERY_APP_BASE_URL = "https://songil.netlify.app/g";
    // 정산견적(품수 기반 사후 견적) 작성 화면. ?site=<현장 recordId> 로 그 현장의 작업목록을 불러와
    // 품수×품단가 + 자재소모량×자재단가 + 부가항목으로 견적을 내고 /s/<코드> 링크로 발행한다.
    // 관리자 PIN 이 같아서 여기서 열면 바로 들어간다. 보관함 현장에도 버튼이 있다 - 정산은 보관 뒤에 하는 일이 많다.
    const SETTLE_APP_BASE_URL = "https://songil.netlify.app/settle.html";

    // 한 "층" 안에서의 방 이름 순서 (탭/버튼을 이 순서로 정렬할 때 기준으로만 쓰임 - 목록을 제한하지 않음)
    const ROOM_ORDER = ['거실', '주방', '현관', '방1', '방2', '방3', '방4', '방5', '기타']; // 거실/주방/현관이 제일 많이 쓰여서 맨 앞으로

    // "2층 거실" 같은 구역 문자열을 {floor, room}으로 분해. 층 표기가 없으면 1층으로 취급해서
    // 기존 데이터(층 구분 없던 시절)와 100% 호환되게 함
    function parseZoneFloor(zoneStr) {
        const str = String(zoneStr || '').trim();
        const m = str.match(/^(\d+)층\s+(.*)$/);
        if (m) return { floor: parseInt(m[1], 10), room: m[2] };
        return { floor: 1, room: str || '기타' };
    }

    // 층+방이름을 하나의 구역 문자열로 합침. 1층은 접두어를 안 붙여서 기존 데이터 형태 그대로 유지
    function composeZone(floor, room) {
        const f = parseInt(floor, 10) || 1;
        return f <= 1 ? room : `${f}층 ${room}`;
    }

    // 구역 문자열 목록을 층(오름차순) → 방 순서 기준으로 정렬. 등록 안 된 층/방 이름이 나와도
    // (예: 3층, 다락방 등) 에러 없이 맨 뒤쪽에 자연스럽게 배치됨 - 코드 수정 없이 새 구역에 대응하기 위함
    function sortZones(zones) {
        return [...zones].sort((a, b) => {
            const pa = parseZoneFloor(a);
            const pb = parseZoneFloor(b);
            if (pa.floor !== pb.floor) return pa.floor - pb.floor;
            const ia = ROOM_ORDER.indexOf(pa.room);
            const ib = ROOM_ORDER.indexOf(pb.room);
            const oa = ia === -1 ? ROOM_ORDER.length : ia;
            const ob = ib === -1 ? ROOM_ORDER.length : ib;
            if (oa !== ob) return oa - ob;
            return pa.room.localeCompare(pb.room);
        });
    }


    // ---------- 뒷정리 ('한번에' 품목) ----------
    // 현장정리·본드붓 세척·짐정리처럼 밑작업/시공으로 안 나뉘는 일. 담당 1명(시공기사 칸)·완료 1번(시공완료 칸)을 쓴다.
    // '매일' 반복이면 시공완료는 켜지 않고, 작업목록.완료일자에 'YYYY-MM-DD 기사' 줄이 쌓인다 → 오늘 줄이 있으면 오늘은 완료.
    // 블로그 후보(밑작업완료+시공완료)에는 밑작업완료가 켜질 일이 없어 저절로 빠지고, 고객 갤러리·정산견적에서도 뺀다.
    const CLEANUP_TAB = '__CLEANUP__'; // 업무배정표에서 🧹 뒷정리 탭을 고른 상태

    function 오늘날짜() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // 품목 설정값 (작업방식·반복·사진필수) - 현장 상세(items/masterItems)에 없으면 품목설정(globalMasterItems)에서
    function 품목설정값(itemName) {
        const d = currentDetailData || {};
        const fromMaster = (d.masterItems || []).find(m => m.품목명 === itemName)
            || (globalMasterItems || []).find(m => m.품목명 === itemName);
        return Object.assign({}, fromMaster || {}, (d.items || {})[itemName] || {});
    }
    function is뒷정리(itemName) { return 품목설정값(itemName).작업방식 === '한번에'; }
    function is매일(itemName) { return 품목설정값(itemName).반복 === '매일'; }

    // 완료일자 칸 → [{ 날짜, 이름 }] 최신순
    function 완료기록(fields) {
        return String((fields && fields.완료일자) || '').split('\n').map(s => s.trim()).filter(Boolean)
            .map(line => {
                const i = line.indexOf(' ');
                return i < 0 ? { 날짜: line, 이름: '' } : { 날짜: line.slice(0, i), 이름: line.slice(i + 1).trim() };
            })
            .sort((a, b) => b.날짜.localeCompare(a.날짜));
    }

    // 뒷정리 완료 여부 - 매일이면 '오늘' 줄이 있는지, 한 번이면 시공완료
    function 뒷정리완료(fields, itemName) {
        if (is매일(itemName)) return 완료기록(fields).some(r => r.날짜 === 오늘날짜());
        return !!(fields && fields.시공완료);
    }

    let activeProjectCode = "";
    let currentDetailData = null; // 상세 현장 데이터 캐시
    let draggedData = null; // HTML5 드래그 중 임시 저장 공간
    let activeZoneTab = null; // 품목 배정 매트릭스에서 현재 선택된 구역 탭
    let zonePendingChanges = new Map(); // 매트릭스에서 저장 버튼을 누르기 전까지 쌓아두는 변경사항: 품목명 -> { active?, 밑작업?, 시공? }
    let activeWorkerName = null; // 배정 보드에서 현재 선택된(활성화된) 기사님 이름, 새로고침에도 유지됨
    let globalProjectList = []; // 현장 목록 전체 캐시 (보관함 보기 토글 시 재요청 없이 필터링)
    const projectProgressCache = new Map(); // recordId -> {done, total} | 'loading' | 'error' (카드별 진행률, 중복 조회 방지용 캐시)
    let showArchivedProjects = false; // false: 활성 현장만 표시, true: 보관된 현장만 표시
    let galleryAllPhotos = []; // 사진 갤러리 모달에 로드된 전체 사진 [{url, 구역, 품목명, type: '시공'|'밑작업'}]
    let galleryActiveZone = '전체'; // 사진 갤러리에서 현재 선택된 구역 탭
    let galleryTypeFilter = { 시공: true, 밑작업: false, 원본: false, 뒷정리: false }; // 시공사진/밑작업 사진/원본사진 체크박스 상태 (기본은 시공사진만)
    let galleryFilteredPhotos = []; // 현재 탭 필터링된 사진 목록 (라이트박스 이전/다음 탐색 기준)
    let galleryLightboxIndex = -1; // 라이트박스에서 현재 보고 있는 사진의 인덱스
    let galleryTouchStartX = null; // 스와이프 제스처 시작 X좌표
    let galleryWasSwipe = false; // 방금 제스처가 스와이프였는지 (탭-닫기와 구분용)
    let galleryActiveRecordId = null; // 현재 갤러리 모달에 열려 있는 현장의 레코드ID (공유 링크 생성용)
    let galleryActiveProjectName = ''; // 같은 현장의 현장명 (공유 링크 미리보기 카드 제목용)
    let rawPhotoTargetProject = null; // 원본사진 캡처 팝업에서 현재 대상 현장 { id, name }
    let rawPhotoSelectedZone = null; // 원본사진 캡처 팝업에서 방금 고른 구역

    // 현장일지 탭 상태
    let dayDrafts = []; // { dayNumber, journalId, published, title, feature, episode, sceneFiles[], cleanupFiles[] }
    let activeDayIndex = 0;
    let taskAssignment = {}; // taskId -> dayNumber
    let taskOrder = {}; // taskId -> 그 일차 안에서의 순서(1부터 시작, 글에 들어가는 순서)
    let eligibleTasksCache = [];

    // UI Elements
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const toast = document.getElementById('toast');
    const projectGrid = document.getElementById('projectGrid');
    
    // Section UI
    const projectListSection = document.getElementById('projectListSection');
    const projectDetailSection = document.getElementById('projectDetailSection');

    // Modals
    const newProjectModal = document.getElementById('newProjectModal');
    const publishModal = document.getElementById('publishModal');
    const journalTabs = document.getElementById('journalTabs');

    // Detail UI Elements
    const detailProjectTitle = document.getElementById('detailProjectTitle');
    const detailProjectDate = document.getElementById('detailProjectDate');
    const zoneAssignTabs = document.getElementById('zoneAssignTabs');
    const zoneAssignItemList = document.getElementById('zoneAssignItemList');
    const zoneItemCountBadge = document.getElementById('zoneItemCountBadge');
    const boardWorkerList = document.getElementById('boardWorkerList');
    const boardAssignmentList = document.getElementById('boardAssignmentList');
    const workerCountBadge = document.getElementById('workerCountBadge');
    const assignedCountBadge = document.getElementById('assignedCountBadge');
    const publishTaskList = document.getElementById('publishTaskList');

    // 모바일: 실시간 업무 배정표 접이식 토글 (데스크탑에서는 CSS가 무시함)
    const assignmentColumnHeader = document.getElementById('assignmentColumnHeader');
    if (assignmentColumnHeader) {
        assignmentColumnHeader.addEventListener('click', () => {
            assignmentColumnHeader.closest('.assignment-column').classList.toggle('open');
        });
    }

    // 2. 유틸리티 기능
    function showLoading(text) {
        loadingText.textContent = text;
        loadingOverlay.style.display = 'flex';
    }

    function hideLoading() {
        loadingOverlay.style.display = 'none';
    }

    // 현장 신호가 약해 응답이 안 올 때 로딩이 무한정 멈춰있지 않도록 타임아웃을 걸어주는 fetch 래퍼
    function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...options, signal: controller.signal })
            .catch(err => {
                if (err.name === 'AbortError') {
                    throw new Error('네트워크 응답이 없습니다. 신호가 약한 곳인지 확인 후 다시 시도해 주세요.');
                }
                throw err;
            })
            .finally(() => clearTimeout(timer));
    }

    function showToast(message, type = 'success') {
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    }

    // 전역 함수 노출
    window.goHome = function() {
        if (isScopedManagerView) return; // 현장소장 링크로 들어온 경우 다른 현장 목록으로 못 나가게 막음
        activeProjectCode = "";
        currentDetailData = null;
        localStorage.removeItem('lastActiveProjectCode');
        showSection('projectListSection');
        loadProjectList();
    };

    window.showSection = function(sectionId) {
        projectListSection.style.display = sectionId === 'projectListSection' ? 'block' : 'none';
        projectDetailSection.style.display = sectionId === 'projectDetailSection' ? 'block' : 'none';
        
        // 헤더 버튼 활성화 제어
        document.getElementById('homeTabBtn').classList.toggle('active', sectionId === 'projectListSection');
    };

    // 3. 모달 제어 함수들 (글로벌 바인딩)
    window.openNewProjectModal = function() {
        newProjectModal.style.display = 'flex';
        document.getElementById('newProjectForm').reset();
        
        // 기본 오늘 날짜 입력
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('newProjectDate').value = today;
        
        // 자주 쓰는 공지 칩 active 상태 초기화 (신규 등록 모달에서만)
        document.querySelectorAll('#noticeQuickTags .notice-tag').forEach(tag => tag.classList.remove('active'));
    };

    window.closeNewProjectModal = function() {
        newProjectModal.style.display = 'none';
    };

    // 자주 쓰는 공지사항 태그 토글 핸들러
    window.toggleNoticeTag = function(element, text, textareaId) {
        const textarea = document.getElementById(textareaId || 'newProjectNotice');
        let currentText = textarea.value.trim();

        // 줄바꿈 기준으로 배열 쪼개기
        let lines = currentText ? currentText.split('\n').map(l => l.trim()).filter(l => l !== "") : [];

        const isActive = element.classList.toggle('active');

        if (isActive) {
            // 활성화 시 추가
            if (!lines.includes(text)) {
                lines.push(text);
            }
        } else {
            // 비활성화 시 제거
            lines = lines.filter(line => line !== text);
        }

        textarea.value = lines.join('\n');
    };


    window.closePublishModal = function() {
        publishModal.style.display = 'none';
    };

    // 중앙 실시간 업무 배정표 영역(boardAssignmentList) 드롭 연동 바인딩
    boardAssignmentList.addEventListener('dragover', (e) => {
        e.preventDefault();
        boardAssignmentList.classList.add('dragover');
    });

    boardAssignmentList.addEventListener('dragleave', () => {
        boardAssignmentList.classList.remove('dragover');
    });

    boardAssignmentList.addEventListener('drop', async (e) => {
        e.preventDefault();
        boardAssignmentList.classList.remove('dragover');
        
        if (draggedData) {
            // 현재 활성화(파랗게 클릭 선택)된 기사가 있는지 체크
            if (activeWorkerName) {
                await assignWorker(draggedData.recordId, activeWorkerName, draggedData.stage);
            } else {
                showToast("왼쪽에서 배정할 기사님을 먼저 선택해 주시거나, 혹은 기사 이름 위로 카드를 직접 드래그해 주세요!", "warning");
            }
        }
    });

    // 3.5. 사진 갤러리 라이트박스 스와이프/키보드 탐색 설정 (한 번만 등록)
    (function setupGalleryLightboxGestures() {
        const el = document.getElementById('galleryLightbox');
        if (!el) return;
        el.addEventListener('touchstart', (e) => {
            galleryTouchStartX = e.touches[0].clientX;
            galleryWasSwipe = false;
        }, { passive: true });
        el.addEventListener('touchend', (e) => {
            if (galleryTouchStartX === null) return;
            const deltaX = e.changedTouches[0].clientX - galleryTouchStartX;
            galleryTouchStartX = null;
            if (Math.abs(deltaX) > 40) {
                galleryWasSwipe = true;
                if (deltaX < 0) galleryLightboxNext(); else galleryLightboxPrev();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (el.style.display !== 'flex') return;
            if (e.key === 'ArrowRight') galleryLightboxNext();
            else if (e.key === 'ArrowLeft') galleryLightboxPrev();
            else if (e.key === 'Escape') closeGalleryLightbox();
        });
    })();

    // 4. 초기화 실행: 현장 리스트 로딩 (마지막으로 보던 현장이 있으면 그 화면으로 바로 복귀)
    function runAdminInit() {
        // 현장소장용 개별 링크로 들어온 경우 - 다른 현장 못 보게 상단 메뉴 숨기고, 그 현장 화면으로 바로 진입
        if (isScopedManagerView) {
            const headerNavEl = document.getElementById('headerNav');
            if (headerNavEl) headerNavEl.style.display = 'none';
        }
        // 일정 앱에서 넘어오는 주인용 딥링크 (admin.html#site=<현장 id>). 현장소장 보기(?code=)에서는 무시한다.
        // 암호 확인이 끝난 뒤에만 이 함수가 불리므로 암호 화면을 건너뛰지 않는다.
        const hashMatch = !isScopedManagerView && /^#site=(rec[A-Za-z0-9]+)$/.exec(location.hash);
        const hashCode = hashMatch ? hashMatch[1] : '';
        if (hashMatch) history.replaceState(null, '', location.pathname + location.search);
        loadProjectList().then(() => {
            const targetCode = scopedProjectCode || hashCode || localStorage.getItem('lastActiveProjectCode');
            if (targetCode) {
                // 앱 재진입 - 저장해둔 화면을 바로 띄우고 최신화는 뒤에서 (로딩창 대기 없음)
                showProjectDetail(targetCode, { useCache: true });
            }
        });
    }

    // 현장소장용 링크는 암호 없이 바로 시작, 그 외엔 암호로 이미 인증된 상태면 바로 시작,
    // 아니면 암호 입력창을 띄우고 성공 시 시작.
    // runAdminInit()을 마이크로태스크로 한 틱 미뤄서, 이 시점 이후에 선언되는 const(예: ADMIN_LIST_CACHE_KEY)들이
    // 먼저 다 초기화되게 함 (안 그러면 "Cannot access ... before initialization" 오류 발생)
    if (isScopedManagerView || localStorage.getItem(ADMIN_UNLOCK_KEY) === ADMIN_UNLOCK_VALUE) {
        Promise.resolve().then(runAdminInit);
    } else {
        document.getElementById('pinLockOverlay').style.display = 'flex';
    }


    // 5. 현장 목록 및 자주쓰는공지 불러오기
    let globalQuickNotices = [];
    let globalMasterItems = [];
    let globalSamplePhotos = {}; // "구분|품목명|텍스트" -> 사진URL (품목설정 모달에서 사용)

    // 세션 안에서(탭을 완전히 닫기 전까지는) 현장목록을 다시 조회하지 않고 캐시로 즉시 복원 -
    // 다른 앱 갔다 오거나 화면 전환할 때마다 매번 서버 재조회하며 지체되는 것 방지.
    // 진짜 최신 데이터가 필요하면 상단 🔄 버튼으로 명시적으로 새로고침함
    const ADMIN_LIST_CACHE_KEY = 'cachedAdminListData';

    // forceRefresh: true면 캐시 무시하고 무조건 서버에서 새로 조회 (데이터가 실제로 바뀐 직후에만 사용)
    async function loadProjectList(forceRefresh = false) {
        if (!forceRefresh) {
            const cached = sessionStorage.getItem(ADMIN_LIST_CACHE_KEY);
            if (cached) {
                try {
                    const parsed = JSON.parse(cached);
                    // 현장이 0개로 캐싱된 경우는 일시적인 조회 오류였을 가능성이 있어 못 믿고 다시 조회함
                    // (한번 빈 값으로 캐싱되면 실제 데이터가 있어도 계속 빈 화면만 보이는 문제 방지)
                    if ((parsed.projects || []).length > 0) {
                        applyProjectListData(parsed, false);
                        return;
                    }
                } catch (e) {
                    // 캐시가 깨져있으면 무시하고 아래에서 정상적으로 새로 조회
                }
            }
        }

        showLoading("현장 목록을 조회하는 중...");
        try {
            const response = await fetchWithTimeout(`${API_ADMIN_GET_URL}?_t=${Date.now()}`, {
                cache: "no-store"
            });
            if (!response.ok) throw new Error("서버에서 목록 로드 실패");

            let data = await response.json();
            if (Array.isArray(data)) {
                data = data[0] || {};
            }

            sessionStorage.setItem(ADMIN_LIST_CACHE_KEY, JSON.stringify(data));
            applyProjectListData(data, true);

        } catch (error) {
            console.error(error);
            showToast("현장 목록을 불러오지 못했습니다.", "danger");
        } finally {
            hideLoading();
        }
    }

    // isFresh: 방금 서버에서 받아온 진짜 최신 데이터인지 여부.
    // 캐시로 복원하는 경우엔 이미 화면에서 실시간으로 갱신된 진행률(projectProgressCache)을
    // 오래된 캐시값으로 덮어쓰지 않도록, 아직 값이 없는 항목만 채워넣음
    function applyProjectListData(data, isFresh) {
        globalProjectList = data.projects || [];

        Object.entries(data.progress || {}).forEach(([id, val]) => {
            if (isFresh || !projectProgressCache.has(id)) projectProgressCache.set(id, val);
        });

        renderProjectGrid();
        renderNoticeQuickTags(data.quickNotices);
        renderCheckpointQuickTags(data.checkpointQuickList);
        globalMasterItems = data.masterItems || [];
        globalSamplePhotos = data.samplePhotos || {};
    }

    // 서버 재조회 없이 로컬 상태만 바꾼 경우(예: 보관 처리) 캐시도 같이 최신화해서,
    // 다음에 캐시로 복원할 때 방금 바뀐 내용이 다시 원래대로 안 보이게 함
    function refreshListCacheFromMemory() {
        const progress = {};
        projectProgressCache.forEach((val, id) => {
            if (val && val !== 'error') progress[id] = val;
        });
        sessionStorage.setItem(ADMIN_LIST_CACHE_KEY, JSON.stringify({
            projects: globalProjectList,
            progress,
            quickNotices: globalQuickNotices,
            checkpointQuickList: globalCheckpointQuickList,
            masterItems: globalMasterItems,
            samplePhotos: globalSamplePhotos
        }));
    }

    // 자주쓰는공지 칩 동적 렌더링 (신규 현장 등록 모달 + 기존 현장 상세 화면, 두 군데 모두에 반영)
    function renderNoticeQuickTags(notices) {
        globalQuickNotices = notices || globalQuickNotices || [];
        renderQuickTagsInto('noticeQuickTags', 'newProjectNotice');
        renderQuickTagsInto('detailNoticeQuickTags', 'detailProjectNotice');
    }

    // 특정 칩 컨테이너 하나를 지정된 textarea 기준으로 렌더링
    function renderQuickTagsInto(containerId, textareaId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = "";

        if (globalQuickNotices.length === 0) {
            container.innerHTML = `<span style="font-size: 12px; color: var(--text-muted); padding: 4px;">에어테이블에 등록된 공지 템플릿이 없습니다. 아래에서 새로 등록해 보세요!</span>`;
            return;
        }

        // 현재 textarea에 입력된 텍스트 수집해서 칩 active 상태 복원용 비교군 생성
        const textarea = document.getElementById(textareaId);
        const lines = textarea ? textarea.value.split('\n').map(l => l.trim()).filter(l => l !== "") : [];

        globalQuickNotices.forEach(text => {
            const span = document.createElement('span');
            span.className = 'notice-tag';
            span.textContent = text;

            // 만약 이미 textarea에 들어가 있는 공지라면 액티브 상태로 렌더링
            if (lines.includes(text)) {
                span.classList.add('active');
            }

            span.onclick = function() {
                toggleNoticeTag(this, text, textareaId);
            };
            container.appendChild(span);
        });
    }

    // 실시간 공지 템플릿 에어테이블 저장 및 웹 등록
    window.addNewNoticeTemplateTag = async function(inputId, textareaId) {
        inputId = inputId || 'customNoticeTagInput';
        textareaId = textareaId || 'newProjectNotice';
        const containerId = { newProjectNotice: 'noticeQuickTags', detailProjectNotice: 'detailNoticeQuickTags' }[textareaId];

        const input = document.getElementById(inputId);
        const text = input.value.trim();
        if (!text) return;

        if (globalQuickNotices.includes(text)) {
            showToast("이미 등록된 공지 템플릿입니다.", "warning");
            input.value = "";
            return;
        }

        showLoading("새 공지 템플릿을 등록하는 중...");
        try {
            const response = await fetchWithTimeout("https://primary-production-a6fa.up.railway.app/webhook/film-notice-create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ noticeText: text })
            });

            if (!response.ok) throw new Error("공지 등록 실패");

            // 성공 시 캐시 반영 및 칩 즉각 재생성 (양쪽 화면 모두)
            globalQuickNotices.push(text);
            renderNoticeQuickTags(globalQuickNotices);

            // 새로 생성된 칩을, 등록을 요청한 화면의 textarea에만 자동으로 클릭/활성화 처리
            const container = document.getElementById(containerId);
            const newChip = container ? Array.from(container.children).find(el => el.textContent === text) : null;
            if (newChip) {
                toggleNoticeTag(newChip, text, textareaId);
            }

            input.value = "";
            showToast("공지 템플릿이 에어테이블에 실시간 등록되었습니다.", "success");
        } catch (error) {
            console.error(error);
            showToast("공지 템플릿 등록에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };


    function renderProjectGrid() {
        projectGrid.innerHTML = "";

        const getFields = (p) => p.fields ? p.fields : p;
        const activeList = globalProjectList.filter(p => !getFields(p).보관함);
        const archivedList = globalProjectList.filter(p => getFields(p).보관함);

        renderArchiveToggleBar(archivedList.length);

        const projects = showArchivedProjects ? archivedList : activeList;

        if (!projects || projects.length === 0) {
            projectGrid.innerHTML = showArchivedProjects
                ? `<div class="empty-state">보관된 현장이 없습니다.</div>`
                : `<div class="empty-state">진행 중인 현장이 없습니다. 새 현장을 개설해 주세요.</div>`;
            return;
        }

        // 최신(나중에 등록된) 현장이 위로 오도록 시공일자 내림차순 정렬.
        // 시공일 미정(견적 앱에서 날짜 없이 만든 현장)은 맨 위 - 날짜를 채워야 할 현장이라 눈에 띄어야 한다.
        // 미정끼리는 나중에 만든 것이 위.
        const sortedProjects = [...projects].sort((a, b) => {
            const fieldsA = a.fields ? a.fields : a;
            const fieldsB = b.fields ? b.fields : b;
            const dateA = fieldsA.시공일자 || "";
            const dateB = fieldsB.시공일자 || "";
            if (!dateA !== !dateB) return dateA ? 1 : -1;
            if (!dateA) return String(fieldsB.createdTime || b.createdTime || "").localeCompare(String(fieldsA.createdTime || a.createdTime || ""));
            return dateB.localeCompare(dateA);
        });

        sortedProjects.forEach(project => {
            // Airtable 노드 버전에 따라 fields 주머니가 있을 수도, 없을 수도 있으므로 유연하게 자동 감지합니다.
            const fields = project.fields ? project.fields : project;
            const recordId = project.id;


            const card = document.createElement('div');
            card.className = 'project-card';
            card.addEventListener('click', () => showProjectDetail(recordId, { useCache: true }));

            const workersText = fields.시공기사 || "미정";
            const archiveBtnHtml = showArchivedProjects
                ? `<button class="card-btn secondary" onclick="event.stopPropagation(); toggleProjectArchive('${recordId}', false)">📤 보관 해제</button>`
                : `<button class="card-btn secondary" onclick="event.stopPropagation(); toggleProjectArchive('${recordId}', true)">📦 보관</button>`;

            const cardTitle = splitProjectTitle(fields.현장명);
            card.innerHTML = `
                <div class="card-header-info">
                    <span class="card-date-badge">🗓️ ${fields.시공일자 || '미지정'}</span>
                    <h3 class="card-title">${cardTitle.main}${cardTitle.sub ? `<span class="card-title-sub">${cardTitle.sub}</span>` : ''}</h3>
                     <div class="card-workers">👷 기사: ${workersText}</div>
                    <div class="card-progress" id="progress-${recordId}"></div>
                </div>
                <div class="card-footer-btns">
                    <button class="card-btn secondary" onclick="event.stopPropagation(); openProjectPhotoGallery('${recordId}', '${(fields.현장명 || '').replace(/'/g, "\\'")}')">📷 사진</button>
                    <button class="card-btn secondary" onclick="event.stopPropagation(); openRawPhotoCapture('${recordId}', '${(fields.현장명 || '').replace(/'/g, "\\'")}')">📸 원본</button>
                    <button class="card-btn secondary" onclick="event.stopPropagation(); window.open('${SETTLE_APP_BASE_URL}?site=${recordId}', '_blank', 'noopener')">💰 현장견적</button>
                    ${archiveBtnHtml}
                    ${showArchivedProjects ? '' : '<button class="card-btn primary">업무 ▶</button>'}
                </div>
            `;
            projectGrid.appendChild(card);
            renderProjectProgressBadge(recordId);
        });
    }

    // 카드의 진행률 배지 렌더링 - 목록 조회 한 번에 서버에서 프로젝트별로 미리 계산해서 오기 때문에
    // (예전처럼 카드마다 따로 상세조회를 안 해도 됨 - 진행률 배지 때문에 목록 열 때마다 실행이 여러 번 몰리던 문제 해결)
    function renderProjectProgressBadge(recordId) {
        const el = document.getElementById(`progress-${recordId}`);
        if (!el) return;
        const cached = projectProgressCache.get(recordId);

        if (cached && cached !== 'error') {
            const { done, total } = cached;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            // 미완료 품목이 있으면, 바로 그 품목만 골라서 보여주는 화면으로 점프하는 링크를 같이 표시
            const incompleteLinkHtml = (total > 0 && done < total)
                ? `<span class="card-progress-incomplete-link" onclick="event.stopPropagation(); openProjectIncompleteView('${recordId}')">⚠️ 미완료 보기</span>`
                : '';
            el.innerHTML = `
                <div class="card-progress-bar"><div class="card-progress-fill" style="width:${pct}%;"></div></div>
                <span class="card-progress-text">${done}/${total} 완료</span>
                ${incompleteLinkHtml}
            `;
            return;
        }

        // 작업이 아직 하나도 없는 신규 현장 등, 서버 집계에 없는 경우
        el.innerHTML = `<span class="card-progress-text muted">0/0 완료</span>`;
    }

    // 현장 목록 상단의 "보관함 보기" 토글 바 렌더링
    function renderArchiveToggleBar(archivedCount) {
        let bar = document.getElementById('archiveToggleBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'archiveToggleBar';
            bar.className = 'archive-toggle-bar';
            projectGrid.parentElement.insertBefore(bar, projectGrid);
        }
        if (showArchivedProjects) {
            bar.innerHTML = `<button type="button" class="archive-toggle-btn" onclick="toggleArchivedView()">← 활성 현장으로 돌아가기</button>`;
        } else {
            bar.innerHTML = archivedCount > 0
                ? `<button type="button" class="archive-toggle-btn" onclick="toggleArchivedView()">📦 보관함 보기 (${archivedCount})</button>`
                : '';
        }
    }

    // 보관함 보기 <-> 활성 현장 보기 전환
    window.toggleArchivedView = function() {
        showArchivedProjects = !showArchivedProjects;
        renderProjectGrid();
    };

    // 현장 보관/보관 해제
    window.toggleProjectArchive = async function(recordId, archived) {
        const project = globalProjectList.find(p => p.id === recordId);
        const projectName = project ? (project.fields ? project.fields : project).현장명 : "이 현장";
        const confirmMsg = archived
            ? `"${projectName}"을(를) 보관하시겠습니까? 현장 목록에서 안 보이게 되며, 보관함에서 언제든 다시 꺼낼 수 있습니다.`
            : `"${projectName}"을(를) 보관에서 해제하시겠습니까? 다시 활성 현장 목록에 표시됩니다.`;
        if (!confirm(confirmMsg)) return;

        showLoading(archived ? "현장을 보관하는 중..." : "보관을 해제하는 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'toggle_project_archive',
                    projectCode: recordId,
                    archived: archived
                })
            });
            if (!response.ok) throw new Error("보관 상태 변경 오류");

            // 로컬 캐시에도 즉시 반영해서 재조회 없이 바로 리렌더링
            if (project) {
                if (project.fields) project.fields.보관함 = archived;
                else project.보관함 = archived;
            }
            renderProjectGrid();
            refreshListCacheFromMemory();
            showToast(archived ? "현장을 보관했습니다." : "보관을 해제했습니다.");
        } catch (error) {
            console.error(error);
            showToast("보관 상태 변경에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // "아파트명 + 동호수" 형태의 현장명을 갤러리 제목 2줄(단지명 / 동호수)로 나눠줌.
    // 끝에 붙는 "OOO동" 또는 "OOO동 OOO호"만 둘째 줄로 떼어내고, 그 패턴이 없으면 한 줄로만 표시
    function splitProjectTitle(name) {
        const str = (name || '').trim();
        const m = str.match(/^(.*?)\s+(\d+\s*동(?:\s*\d+\s*호)?)$/);
        if (m) return { main: m[1].trim(), sub: m[2].trim() };
        return { main: str || '현장', sub: '' };
    }

    // 현장 사진 갤러리: 시공 완료된 사진만 모아서 구역별로 훑어볼 수 있게 보여줌 (예전 현장 기억 안 날 때 용도)
    // defaultType을 넘기면 그 종류만 체크된 상태로 열림 (예: '원본사진 보기' 버튼은 '원본'만 체크해서 진입)
    window.openProjectPhotoGallery = async function(recordId, projectName, defaultType) {
        galleryActiveRecordId = recordId;
        galleryActiveProjectName = projectName || '';
        const title = splitProjectTitle(projectName);
        document.getElementById('galleryModalTitleMain').textContent = title.main;
        document.getElementById('galleryModalTitleSub').textContent = title.sub;
        document.getElementById('photoGalleryModal').style.display = 'flex';
        document.getElementById('galleryZoneTabs').innerHTML = '';
        document.getElementById('galleryPhotoGrid').innerHTML = `<div class="empty-state">사진을 불러오는 중...</div>`;

        // 열 때마다 기본값(시공사진만 체크, 원본사진 보기로 열었으면 원본만 체크)으로 초기화
        const dt = defaultType || '시공';
        galleryTypeFilter = { 시공: dt === '시공', 밑작업: dt === '밑작업', 원본: dt === '원본', 뒷정리: dt === '뒷정리' };
        document.getElementById('galleryTypeConstruction').checked = dt === '시공';
        document.getElementById('galleryTypePrep').checked = dt === '밑작업';
        document.getElementById('galleryTypeRaw').checked = dt === '원본';
        document.getElementById('galleryTypeCleanup').checked = dt === '뒷정리';

        showLoading("현장 사진을 불러오는 중...");
        try {
            const response = await fetchWithTimeout(`${API_DETAIL_URL}?code=${recordId}`);
            if (!response.ok) throw new Error("사진 조회 실패");
            const result = await response.json();
            const data = Array.isArray(result) ? result[0] : result;

            // 품목명 -> 구역 매핑 (시공품목 마스터 데이터 기준)
            const zoneByItem = {};
            (data.masterItems || []).forEach(item => {
                zoneByItem[item.품목명] = item.구역 || '기타';
            });

            const isValidPhoto = (p) => !!p && p.url && !p.url.includes('1x1.png') && !(p.filename && p.filename.includes('1x1.png'));

            // 뒷정리('한번에' 품목) 사진은 시공 사진과 섞지 않고 '현장정리' 구역으로 따로 모은다
            const 뒷정리품목 = new Set((data.masterItems || []).filter(item => item.작업방식 === '한번에').map(item => item.품목명));

            const photos = [];
            // 완료보고 여부와 상관없이, 찍혀서 이미 저장된 사진은 바로 갤러리에 보여줌
            // (임시저장 단계에서 찍은 사진도 완료보고 전까지 안 보이던 문제 수정)
            (data.tasks || []).forEach(task => {
                const fields = task.fields || {};
                if (뒷정리품목.has(fields.시공품목)) {
                    (fields.시공후사진 || []).forEach((photo, idx) => {
                        if (isValidPhoto(photo)) {
                            photos.push({ url: photo.url, 구역: '현장정리', 품목명: fields.시공품목 || '', type: '뒷정리', taskId: task.id, fieldName: '시공후사진', slotIndex: idx });
                        }
                    });
                    return;
                }
                const zone = zoneByItem[fields.시공품목] || '기타';
                // taskId/fieldName/slotIndex: 확대보기에서 삭제할 때 기사님 앱과 동일한 delete_photo 페이로드를 만들기 위한 좌표.
                // slotIndex는 Airtable 첨부 배열의 원래 인덱스(placeholder 슬롯 포함) = 기사님 앱의 슬롯 번호와 같음
                (fields.시공후사진 || []).forEach((photo, idx) => {
                    if (isValidPhoto(photo)) {
                        photos.push({ url: photo.url, 구역: zone, 품목명: fields.시공품목 || '', type: '시공', taskId: task.id, fieldName: '시공후사진', slotIndex: idx });
                    }
                });
                (fields.시공전사진 || []).forEach((photo, idx) => {
                    if (isValidPhoto(photo)) {
                        photos.push({ url: photo.url, 구역: zone, 품목명: fields.시공품목 || '', type: '밑작업', taskId: task.id, fieldName: '시공전사진', slotIndex: idx });
                    }
                });
            });

            // 원본사진: 기사 배정/작업목록과 무관하게 구역만 지정해서 바로 찍어둔 현장 사전상태 사진
            (data.rawPhotos || []).forEach(rp => {
                if (isValidPhoto(rp)) {
                    photos.push({ url: rp.url, 구역: rp.구역 || '기타', 품목명: '', type: '원본', rawId: rp.id || null }); // rawId: 원본사진 레코드ID (삭제용)
                }
            });

            galleryAllPhotos = photos;
            galleryActiveZone = '전체';
            renderGalleryZoneTabs();
            renderGalleryPhotoGrid();
        } catch (error) {
            console.error(error);
            document.getElementById('galleryPhotoGrid').innerHTML = `<div class="empty-state">사진을 불러오지 못했습니다.</div>`;
            showToast("현장 사진을 불러오지 못했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    window.closePhotoGalleryModal = function() {
        document.getElementById('photoGalleryModal').style.display = 'none';
        galleryAllPhotos = [];
        galleryActiveRecordId = null;
        galleryActiveProjectName = '';
    };

    // 편집 기능 없이 사진만 보이는 외부 공유용 갤러리 링크 복사 (인테리어 업자 등에게 전달용)
    // - types: 지금 보고 있는 시공사진/밑작업 사진 체크 상태. 받는 쪽도 똑같은 사진을 본다.
    // - n: 현장명(base64url). 카톡 미리보기 카드 제목에 쓴다. 미리보기 봇은 JS를 실행하지 않아서
    //      페이지가 열린 뒤 제목을 바꿔봐야 소용없고, 링크에 실어 보내야 서버가 카드 제목을 만든다.
    //      (견적서 링크가 쓰는 방식과 같다. 한글을 그대로 넣으면 주소가 3~4배로 길어져 base64url 사용)
    window.copyGalleryShareLink = function() {
        if (!galleryActiveRecordId) return;
        const params = new URLSearchParams();
        if (galleryActiveProjectName) params.set('n', toBase64Url(galleryActiveProjectName));
        const types = [];
        if (galleryTypeFilter.시공) types.push('done');
        if (galleryTypeFilter.밑작업) types.push('prep');
        if (types.length) params.set('types', types.join(','));
        const query = params.toString();
        copyLink(`${GALLERY_APP_BASE_URL}/${galleryActiveRecordId}${query ? `?${query}` : ''}`);
    };

    // 한글을 base64url 로. URLSearchParams 가 다시 % 로 감싸지 않도록 +, /, = 를 빼고 -, _ 만 쓴다.
    function toBase64Url(text) {
        const bytes = new TextEncoder().encode(text);
        let bin = '';
        bytes.forEach(b => { bin += String.fromCharCode(b); });
        return btoa(bin).split('+').join('-').split('/').join('_').split('=').join('');
    }

    // 원본사진 캡처: 밑작업 기사 지정/작업목록 진입 없이, 구역만 골라서 바로 찍어 올리는 팀 공지용 사진
    // (현장소장 링크로 들어온 팀장님도 로그인 없이 그대로 사용 가능)
    // 2단계 구성: 1) 구역 선택 → 2) 촬영하기/앨범에서 선택 중 하나 고르기 (둘 다 명시적으로 지원)
    window.openRawPhotoCapture = function(recordId, projectName) {
        rawPhotoTargetProject = { id: recordId, name: projectName || '현장' };
        document.getElementById('rawPhotoZoneModalTitle').textContent = `📸 ${rawPhotoTargetProject.name} - 원본사진`;
        document.getElementById('rawPhotoFloorInput').value = '1'; // 열 때마다 1층으로 초기화
        showRawPhotoZoneStep();
        document.getElementById('rawPhotoZoneModal').style.display = 'flex';
    };

    // 현장 상세화면 상단 "📸 원본사진 찍기" 버튼용 - 현재 열려있는 현장 기준으로 캡처 팝업을 엶
    window.openRawPhotoCaptureForActiveProject = function() {
        if (!activeProjectCode) return;
        const name = (currentDetailData && currentDetailData.project && currentDetailData.project.현장명) || '';
        openRawPhotoCapture(activeProjectCode, name);
    };

    // 현장 상세화면 상단 "📷 원본사진 보기" 버튼용 - 기존 사진 갤러리를 원본사진만 체크된 상태로 엶
    window.openRawPhotoGalleryForActiveProject = function() {
        if (!activeProjectCode) return;
        const name = (currentDetailData && currentDetailData.project && currentDetailData.project.현장명) || '';
        openProjectPhotoGallery(activeProjectCode, name, '원본');
    };

    window.closeRawPhotoZoneModal = function() {
        document.getElementById('rawPhotoZoneModal').style.display = 'none';
        rawPhotoTargetProject = null;
    };

    function showRawPhotoZoneStep() {
        document.getElementById('rawPhotoZoneStep').style.display = 'block';
        document.getElementById('rawPhotoActionStep').style.display = 'none';
    }

    window.backToRawPhotoZoneStep = function() {
        showRawPhotoZoneStep();
    };

    // 방을 고르면 (층 선택값과 합쳐서) "촬영하기 / 앨범에서 선택" 2단계 화면으로 넘어감
    window.selectRawPhotoRoom = function(room) {
        if (!rawPhotoTargetProject) return;
        const floor = document.getElementById('rawPhotoFloorInput').value;
        const zone = composeZone(floor, room);
        rawPhotoSelectedZone = zone;
        document.getElementById('rawPhotoActionZoneLabel').textContent = `📍 ${zone}`;
        document.getElementById('rawPhotoZoneStep').style.display = 'none';
        document.getElementById('rawPhotoActionStep').style.display = 'block';
    };

    window.triggerRawPhotoCamera = function() {
        const input = document.getElementById('rawPhotoFileInputCamera');
        input.value = ''; // 같은 파일을 연속으로 다시 찍어도 change 이벤트가 뜨도록 초기화
        input.click();
    };

    window.triggerRawPhotoGallery = function() {
        const input = document.getElementById('rawPhotoFileInputGallery');
        input.value = '';
        input.click();
    };

    // 촬영/앨범 두 입력 모두 같은 업로드 로직을 공유
    async function uploadRawPhotoFiles(files) {
        const project = rawPhotoTargetProject;
        const zone = rawPhotoSelectedZone;
        if (files.length === 0 || !project || !zone) return;

        showLoading(`원본사진 업로드 중... (0/${files.length})`);
        let successCount = 0;
        for (let i = 0; i < files.length; i++) {
            try {
                const formData = new FormData();
                formData.append('projectCode', project.id);
                formData.append('구역', zone);
                formData.append('image', files[i]);
                const response = await fetchWithTimeout(API_RAW_PHOTO_UPLOAD_URL, { method: 'POST', body: formData }, 30000);
                if (!response.ok) throw new Error('업로드 실패');
                successCount++;
                showLoading(`원본사진 업로드 중... (${successCount}/${files.length})`);
            } catch (error) {
                console.error(error);
            }
        }
        hideLoading();

        if (successCount === files.length) {
            showToast(`📸 ${zone} 원본사진 ${successCount}장 업로드 완료!`);
        } else {
            showToast(`${successCount}/${files.length}장만 업로드되었습니다. 신호가 약한 곳인지 확인해 주세요.`, "danger");
        }

        // 같은 구역이나 다른 구역 사진을 이어서 올릴 수 있게 구역 선택 화면으로 복귀 (닫고 싶으면 팝업의 닫기 버튼 사용)
        rawPhotoTargetProject = project;
        document.getElementById('rawPhotoZoneModalTitle').textContent = `📸 ${project.name} - 원본사진`;
        showRawPhotoZoneStep();
        document.getElementById('rawPhotoZoneModal').style.display = 'flex';
    }

    document.getElementById('rawPhotoFileInputCamera').addEventListener('change', (e) => {
        startRawPhotoAnnotateQueue(Array.from(e.target.files || []));
    });
    document.getElementById('rawPhotoFileInputGallery').addEventListener('change', (e) => {
        startRawPhotoAnnotateQueue(Array.from(e.target.files || []));
    });

    // ===== 원본사진 마킹(주석) 편집기 =====
    // 촬영/앨범으로 고른 사진을 바로 올리지 않고, 사각형/원/화살표로 구역을 표시하고
    // 시공방법·주의사항 등 텍스트 코멘트를 얹은 뒤 업로드하기 위한 캔버스 편집기.
    // 여러 장을 한번에 골랐을 때는 한 장씩 순서대로 편집하고, 다 끝나면 한번에 업로드한다.
    const ANNOTATE_MAX_DIM = 1600; // 캔버스 해상도(=최종 업로드 해상도) 상한. 화면 표시는 CSS로 축소되고, 그리기 좌표는 이 해상도 기준.
    let annotateQueue = [];       // 편집 대기 중인 원본 File 목록
    let annotateIndex = 0;        // 지금 편집 중인 사진의 큐 인덱스
    let annotateResultFiles = []; // 편집(또는 건너뛰기) 완료된 File 목록 - 큐가 끝나면 한번에 업로드
    let annotateImage = null;     // 현재 캔버스에 그려진 원본 이미지(ImageBitmap)
    let annotateShapes = [];      // 현재 사진에 그려진 도형/텍스트 목록
    let annotateTool = 'rect';    // rect | circle | arrow | text
    let annotateColor = '#ef4444';
    let annotateDragStart = null; // 드래그 중인 도형의 시작점 {x,y}
    let annotateDragCurrent = null; // 드래그 중인 도형의 현재점 {x,y} (미리보기용)
    let annotateTextPos = null;   // 텍스트 도구로 탭한 위치(캔버스 좌표) - 입력 확정 대기중
    let annotateEditMode = false; // true면 '원본사진 보기'에서 기존 사진을 다시 여는 편집 모드 (새 촬영 큐가 아님)
    let annotateEditRawId = null; // 편집 모드에서 지금 고치고 있는 원본사진 레코드ID

    function startRawPhotoAnnotateQueue(files) {
        if (files.length === 0) return;
        annotateEditMode = false;
        annotateEditRawId = null;
        annotateQueue = files;
        annotateIndex = 0;
        annotateResultFiles = [];
        setAnnotateFooterMode('capture');
        document.getElementById('rawPhotoZoneModal').style.display = 'none';
        document.getElementById('rawPhotoAnnotateModal').style.display = 'flex';
        loadAnnotatePhoto();
    }

    // '원본사진 보기' 확대보기에서 ✏️ 편집을 눌렀을 때 - 기존에 올라간 사진을 그대로 불러와서 이어서 마킹
    window.startRawPhotoAnnotateEdit = async function(rawId, url) {
        annotateEditMode = true;
        annotateEditRawId = rawId;
        annotateQueue = [];
        annotateIndex = 0;
        annotateResultFiles = [];
        setAnnotateFooterMode('edit');
        document.getElementById('annotateProgressLabel').textContent = '사진 편집';
        annotateShapes = [];
        annotateDragStart = null;
        annotateDragCurrent = null;
        hideAnnotateTextInput();
        document.getElementById('rawPhotoAnnotateModal').style.display = 'flex';

        showLoading('사진을 불러오는 중...');
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('사진을 불러오지 못했습니다');
            const blob = await res.blob();
            await loadAnnotateImageFromBlob(blob);
        } catch (e) {
            showToast('사진을 불러오지 못했습니다: ' + e.message, 'danger');
            window.cancelRawPhotoAnnotateQueue();
        } finally {
            hideLoading();
        }
    };

    // 편집기 하단 버튼 문구/동작을 촬영모드(다음 사진으로 넘어감) / 편집모드(그 자리에서 저장)에 맞게 바꿈
    function setAnnotateFooterMode(mode) {
        const skipBtn = document.getElementById('annotateSkipBtn');
        const saveBtn = document.getElementById('annotateSaveBtn');
        if (mode === 'edit') {
            skipBtn.textContent = '취소';
            saveBtn.textContent = '✔ 저장';
        } else {
            skipBtn.textContent = '건너뛰기';
            saveBtn.textContent = '✔ 저장하고 다음';
        }
    }

    // File/Blob 이미지를 편집 캔버스에 그려넣는 공통 로직 (새 촬영 큐 / 기존 사진 편집 둘 다 공유)
    async function loadAnnotateImageFromBlob(blobOrFile) {
        const bitmap = await createImageBitmap(blobOrFile);
        let w = bitmap.width, h = bitmap.height;
        if (w > ANNOTATE_MAX_DIM || h > ANNOTATE_MAX_DIM) {
            const scale = ANNOTATE_MAX_DIM / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
        }
        const canvas = document.getElementById('annotateCanvas');
        canvas.width = w;
        canvas.height = h;

        const offscreen = document.createElement('canvas');
        offscreen.width = w;
        offscreen.height = h;
        offscreen.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        annotateImage = offscreen;
        bitmap.close && bitmap.close();

        redrawAnnotateCanvas();
    }

    async function loadAnnotatePhoto() {
        const file = annotateQueue[annotateIndex];
        document.getElementById('annotateProgressLabel').textContent =
            annotateQueue.length > 1 ? `${annotateIndex + 1} / ${annotateQueue.length}장` : '사진 표시';
        annotateShapes = [];
        annotateDragStart = null;
        annotateDragCurrent = null;
        hideAnnotateTextInput();
        await loadAnnotateImageFromBlob(file);
    }

    window.setAnnotateTool = function(tool) {
        annotateTool = tool;
        document.querySelectorAll('.annotate-tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
    };

    window.setAnnotateColor = function(color) {
        annotateColor = color;
        document.querySelectorAll('.annotate-color-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.color === color);
        });
    };

    window.undoAnnotate = function() {
        annotateShapes.pop();
        redrawAnnotateCanvas();
    };

    function redrawAnnotateCanvas() {
        const canvas = document.getElementById('annotateCanvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(annotateImage, 0, 0);
        annotateShapes.forEach(s => drawAnnotateShape(ctx, s));
        if (annotateDragStart && annotateDragCurrent && annotateTool !== 'text') {
            drawAnnotateShape(ctx, {
                type: annotateTool,
                x1: annotateDragStart.x, y1: annotateDragStart.y,
                x2: annotateDragCurrent.x, y2: annotateDragCurrent.y,
                color: annotateColor
            });
        }
    }

    function drawAnnotateShape(ctx, s) {
        const lineWidth = Math.max(4, Math.round(annotateImage.width / 260));
        if (s.type === 'rect') {
            ctx.strokeStyle = s.color;
            ctx.lineWidth = lineWidth;
            ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
        } else if (s.type === 'circle') {
            const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
            const rx = Math.abs(s.x2 - s.x1) / 2, ry = Math.abs(s.y2 - s.y1) / 2;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (s.type === 'arrow') {
            const headLen = lineWidth * 4.5;
            const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
            ctx.strokeStyle = s.color;
            ctx.fillStyle = s.color;
            ctx.lineWidth = lineWidth;
            ctx.beginPath();
            ctx.moveTo(s.x1, s.y1);
            ctx.lineTo(s.x2, s.y2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(s.x2, s.y2);
            ctx.lineTo(s.x2 - headLen * Math.cos(angle - Math.PI / 6), s.y2 - headLen * Math.sin(angle - Math.PI / 6));
            ctx.lineTo(s.x2 - headLen * Math.cos(angle + Math.PI / 6), s.y2 - headLen * Math.sin(angle + Math.PI / 6));
            ctx.closePath();
            ctx.fill();
        } else if (s.type === 'text') {
            const fontSize = Math.max(24, Math.round(annotateImage.width / 34));
            ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Malgun Gothic", sans-serif`;
            const padX = fontSize * 0.35, padY = fontSize * 0.28;
            const metrics = ctx.measureText(s.text);
            const boxW = metrics.width + padX * 2;
            const boxH = fontSize + padY * 2;
            ctx.fillStyle = s.color;
            ctx.fillRect(s.x1, s.y1, boxW, boxH);
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'middle';
            ctx.fillText(s.text, s.x1 + padX, s.y1 + boxH / 2);
        }
    }

    // 화면(CSS) 좌표 → 캔버스 실제 픽셀 좌표로 변환 (캔버스가 CSS로 축소 표시되므로 배율 보정 필요)
    function getAnnotateCanvasPos(evt) {
        const canvas = document.getElementById('annotateCanvas');
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (evt.clientX - rect.left) * scaleX,
            y: (evt.clientY - rect.top) * scaleY
        };
    }

    (function setupAnnotateCanvasEvents() {
        const canvas = document.getElementById('annotateCanvas');
        canvas.addEventListener('pointerdown', (e) => {
            const pos = getAnnotateCanvasPos(e);
            if (annotateTool === 'text') {
                showAnnotateTextInput(pos);
                return;
            }
            annotateDragStart = pos;
            annotateDragCurrent = pos;
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!annotateDragStart) return;
            annotateDragCurrent = getAnnotateCanvasPos(e);
            redrawAnnotateCanvas();
        });
        canvas.addEventListener('pointerup', (e) => {
            if (!annotateDragStart) return;
            const pos = getAnnotateCanvasPos(e);
            const moved = Math.hypot(pos.x - annotateDragStart.x, pos.y - annotateDragStart.y) > 6;
            if (moved) {
                annotateShapes.push({
                    type: annotateTool,
                    x1: annotateDragStart.x, y1: annotateDragStart.y,
                    x2: pos.x, y2: pos.y,
                    color: annotateColor
                });
            }
            annotateDragStart = null;
            annotateDragCurrent = null;
            redrawAnnotateCanvas();
        });
    })();

    function showAnnotateTextInput(pos) {
        annotateTextPos = pos;
        const canvas = document.getElementById('annotateCanvas');
        const rect = canvas.getBoundingClientRect();
        const wrap = document.getElementById('annotateTextInputWrap');
        const cssScale = rect.width / canvas.width;
        wrap.style.left = `${pos.x * cssScale}px`;
        wrap.style.top = `${pos.y * cssScale}px`;
        wrap.style.display = 'flex';
        const input = document.getElementById('annotateTextInput');
        input.value = '';
        setTimeout(() => input.focus(), 50);
    }

    function hideAnnotateTextInput() {
        document.getElementById('annotateTextInputWrap').style.display = 'none';
        annotateTextPos = null;
    }

    window.confirmAnnotateText = function() {
        const input = document.getElementById('annotateTextInput');
        const text = input.value.trim();
        if (text && annotateTextPos) {
            annotateShapes.push({ type: 'text', x1: annotateTextPos.x, y1: annotateTextPos.y, text, color: annotateColor });
        }
        hideAnnotateTextInput();
        redrawAnnotateCanvas();
    };

    window.cancelAnnotateText = function() {
        hideAnnotateTextInput();
    };

    // 지금 사진은 마킹 없이 원본 그대로 업로드 목록에 담기 (편집모드에서는 "취소"로 동작 - cancelRawPhotoAnnotateQueue가 처리)
    window.skipRawPhotoAnnotate = function() {
        if (annotateEditMode) {
            window.cancelRawPhotoAnnotateQueue();
            return;
        }
        annotateResultFiles.push(annotateQueue[annotateIndex]);
        advanceAnnotateQueue();
    };

    // 지금 사진에 그린 도형/텍스트를 이미지에 합성해서 저장
    // - 촬영모드: 업로드 목록에 담아뒀다가 큐가 끝나면 한번에 업로드
    // - 편집모드: 그 자리에서 바로 raw-photo-update로 덮어쓰기
    window.saveRawPhotoAnnotate = async function() {
        if (annotateEditMode) {
            const canvas = document.getElementById('annotateCanvas');
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            showLoading('저장 중...');
            try {
                const formData = new FormData();
                formData.append('recordId', annotateEditRawId);
                formData.append('image', blob, 'photo.jpg');
                const response = await fetchWithTimeout(API_RAW_PHOTO_UPDATE_URL, { method: 'POST', body: formData }, 30000);
                if (!response.ok) throw new Error('저장 실패');
                showToast('✏️ 원본사진이 수정되었습니다.');
                finishRawPhotoAnnotateEdit();
            } catch (e) {
                showToast('저장 실패: ' + e.message, 'danger');
            } finally {
                hideLoading();
            }
            return;
        }

        if (annotateShapes.length === 0) {
            annotateResultFiles.push(annotateQueue[annotateIndex]);
            advanceAnnotateQueue();
            return;
        }
        const canvas = document.getElementById('annotateCanvas');
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        const originalName = annotateQueue[annotateIndex].name || 'photo.jpg';
        const markedFile = new File([blob], originalName.replace(/\.\w+$/, '') + '_marked.jpg', { type: 'image/jpeg' });
        annotateResultFiles.push(markedFile);
        advanceAnnotateQueue();
    };

    function advanceAnnotateQueue() {
        annotateIndex++;
        if (annotateIndex < annotateQueue.length) {
            loadAnnotatePhoto();
        } else {
            document.getElementById('rawPhotoAnnotateModal').style.display = 'none';
            const filesToUpload = annotateResultFiles;
            annotateQueue = [];
            annotateResultFiles = [];
            document.getElementById('rawPhotoZoneModal').style.display = 'flex';
            uploadRawPhotoFiles(filesToUpload);
        }
    }

    // 편집모드 저장 성공 후 - 편집기를 닫고 갤러리로 돌아가서 목록을 새로고침 (수정된 사진이 바로 반영되게)
    function finishRawPhotoAnnotateEdit() {
        annotateEditMode = false;
        annotateEditRawId = null;
        document.getElementById('rawPhotoAnnotateModal').style.display = 'none';
        if (galleryActiveRecordId) {
            openProjectPhotoGallery(galleryActiveRecordId, galleryActiveProjectName, '원본');
        }
    }

    // 편집기 전체를 취소
    // - 촬영모드: 지금까지 편집/건너뛴 사진들까지 전부 버리고 업로드하지 않음 (확인 필요)
    // - 편집모드: 그냥 갤러리로 되돌아감 (원본은 그대로 있으니 확인 불필요)
    window.cancelRawPhotoAnnotateQueue = function() {
        if (annotateEditMode) {
            annotateEditMode = false;
            annotateEditRawId = null;
            document.getElementById('rawPhotoAnnotateModal').style.display = 'none';
            document.getElementById('photoGalleryModal').style.display = 'flex';
            return;
        }
        if (!confirm('지금까지 표시한 내용이 모두 취소됩니다. 그만둘까요?')) return;
        annotateQueue = [];
        annotateResultFiles = [];
        document.getElementById('rawPhotoAnnotateModal').style.display = 'none';
        document.getElementById('rawPhotoZoneModal').style.display = 'flex';
    };

    // 시공사진/밑작업 사진 체크박스로 걸러낸 목록 (구역 탭/그리드가 공통으로 이 목록을 기준으로 삼음)
    function getGalleryTypeFilteredPhotos() {
        return galleryAllPhotos.filter(p => galleryTypeFilter[p.type]);
    }

    window.toggleGalleryTypeFilter = function(type) {
        galleryTypeFilter[type] = !galleryTypeFilter[type];
        galleryActiveZone = '전체'; // 필터 바뀌면 지금 보던 구역 탭이 비어있을 수 있어 전체로 되돌림
        renderGalleryZoneTabs();
        renderGalleryPhotoGrid();
    };

    // 사진에 실제로 찍힌 구역들만, 층→방 순서로 정렬해서 탭으로 노출 ("전체" 탭이 항상 맨 앞)
    // 2층, 3층 등 새 구역이 나와도 고정 목록에 없다고 누락되지 않고 자동으로 탭이 생김
    function renderGalleryZoneTabs() {
        const container = document.getElementById('galleryZoneTabs');
        const visiblePhotos = getGalleryTypeFilteredPhotos();
        const zonesPresent = sortZones([...new Set(visiblePhotos.map(p => p.구역).filter(Boolean))]);
        const tabs = ['전체', ...zonesPresent];

        container.innerHTML = tabs.map(zone => {
            const count = zone === '전체' ? visiblePhotos.length : visiblePhotos.filter(p => p.구역 === zone).length;
            return `<button type="button" class="gallery-zone-tab ${zone === galleryActiveZone ? 'active' : ''}" onclick="filterGalleryByZone('${zone}')">${zone} (${count})</button>`;
        }).join('');
    }

    window.filterGalleryByZone = function(zone) {
        galleryActiveZone = zone;
        renderGalleryZoneTabs();
        renderGalleryPhotoGrid();
    };

    function renderGalleryPhotoGrid() {
        const grid = document.getElementById('galleryPhotoGrid');
        const visiblePhotos = getGalleryTypeFilteredPhotos();
        const photos = galleryActiveZone === '전체'
            ? visiblePhotos
            : visiblePhotos.filter(p => p.구역 === galleryActiveZone);

        galleryFilteredPhotos = photos; // 라이트박스 이전/다음 탐색은 지금 보이는(필터링된) 목록 기준

        if (photos.length === 0) {
            grid.innerHTML = `<div class="empty-state">시공 완료된 사진이 아직 없습니다.</div>`;
            return;
        }

        // 사진마다 어느 구역/품목인지 캡션으로 함께 표시 ("전체" 탭에서도 구분 가능하게).
        // 체크박스가 2개 이상 켜져서 섞여 보일 때는 어느 종류인지도 같이 표시. 원본사진은 품목명이 없음
        const showTypeLabel = Object.values(galleryTypeFilter).filter(Boolean).length > 1;
        grid.innerHTML = photos.map((p, idx) => `
            <div class="gallery-photo-tile" onclick="openGalleryLightbox(${idx})">
                <img src="${p.url}" alt="${p.품목명 || p.구역}" loading="lazy">
                <div class="gallery-photo-caption">${p.구역}${p.품목명 ? ` · ${p.품목명}` : ''}${showTypeLabel ? ` · ${p.type}` : ''}</div>
            </div>
        `).join('');
    }

    window.openGalleryLightbox = function(index) {
        galleryLightboxIndex = index;
        showGalleryLightboxPhoto();
        // 사진 삭제는 관리자만. 현장소장 링크(?code=)로 들어온 팀장님에게는 🗑 버튼을 아예 안 보여줌
        document.getElementById('galleryLightboxDeleteBtn').style.display = isScopedManagerView ? 'none' : 'flex';
        document.getElementById('galleryLightbox').style.display = 'flex';
    };

    // 원본사진 확대보기에서 ✏️ 버튼으로 구역표시/코멘트 편집기를 다시 엶 (원본사진만 - rawId가 있어야 저장 대상 특정 가능)
    window.editGalleryPhoto = function() {
        const photo = galleryFilteredPhotos[galleryLightboxIndex];
        if (!photo || photo.type !== '원본' || !photo.rawId) return;
        document.getElementById('galleryLightbox').style.display = 'none';
        startRawPhotoAnnotateEdit(photo.rawId, photo.url);
    };

    // 확대보기에서 지금 보고 있는 사진 삭제 (잘못 올린 사진을 기사님 앱에 들어가지 않고 바로 지우기 위한 용도)
    // - 시공/밑작업: 기사님 앱의 deletePhoto와 완전히 같은 delete_photo 페이로드 → 해당 슬롯만 비워져서 다른 슬롯 위치가 안 밀림
    // - 원본: 원본사진 테이블은 레코드 1건 = 사진 1장이라 delete_raw_photo로 레코드 자체를 삭제
    window.deleteGalleryPhoto = async function() {
        if (isScopedManagerView) return;
        const photo = galleryFilteredPhotos[galleryLightboxIndex];
        if (!photo) return;
        if (photo.type === '원본' && !photo.rawId) {
            showToast('원본사진 정보를 다시 불러온 뒤 삭제해 주세요 (새로고침 필요).', 'danger');
            return;
        }
        if (!confirm('이 사진을 삭제할까요?')) return;

        const payload = photo.type === '원본'
            ? { type: 'delete_raw_photo', projectCode: galleryActiveRecordId, recordId: photo.rawId }
            : { type: 'delete_photo', projectCode: galleryActiveRecordId, recordId: photo.taskId, fieldName: photo.fieldName, slotIndex: photo.slotIndex };

        showLoading('사진 삭제 중...');
        try {
            const res = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error('사진 삭제 실패');

            // 전체 목록에서 빼고 탭/그리드를 다시 그리면 galleryFilteredPhotos도 같이 갱신됨
            galleryAllPhotos = galleryAllPhotos.filter(p => p !== photo);
            renderGalleryZoneTabs();
            renderGalleryPhotoGrid();

            if (galleryFilteredPhotos.length === 0) {
                document.getElementById('galleryLightbox').style.display = 'none';
            } else {
                galleryLightboxIndex = Math.min(galleryLightboxIndex, galleryFilteredPhotos.length - 1);
                showGalleryLightboxPhoto();
            }
            showToast('사진이 삭제되었습니다.');
        } catch (error) {
            console.error(error);
            showToast('사진 삭제에 실패했습니다.', 'danger');
        } finally {
            hideLoading();
        }
    };

    function showGalleryLightboxPhoto() {
        const photo = galleryFilteredPhotos[galleryLightboxIndex];
        if (!photo) return;
        document.getElementById('galleryLightboxImg').src = photo.url;
        document.getElementById('galleryLightboxEditBtn').style.display = (photo.type === '원본' && photo.rawId) ? 'flex' : 'none';
    }

    window.galleryLightboxNext = function() {
        if (galleryFilteredPhotos.length === 0) return;
        galleryLightboxIndex = (galleryLightboxIndex + 1) % galleryFilteredPhotos.length;
        showGalleryLightboxPhoto();
    };

    window.galleryLightboxPrev = function() {
        if (galleryFilteredPhotos.length === 0) return;
        galleryLightboxIndex = (galleryLightboxIndex - 1 + galleryFilteredPhotos.length) % galleryFilteredPhotos.length;
        showGalleryLightboxPhoto();
    };

    window.closeGalleryLightbox = function() {
        // 스와이프 직후에 발생하는 클릭 이벤트로 바로 닫히지 않게 방지
        if (galleryWasSwipe) { galleryWasSwipe = false; return; }
        document.getElementById('galleryLightbox').style.display = 'none';
    };

    // 링크 복사 클립보드 기능
    window.copyLink = function(url) {
        if (!url) {
            showToast("링크 주소가 존재하지 않습니다.", "danger");
            return;
        }
        navigator.clipboard.writeText(url).then(() => {
            showToast("링크복사 완료");
        }).catch(err => {
            console.error(err);
            showToast("복사에 실패했습니다. 수동으로 복사해 주세요.", "danger");
        });
    };

    // 기사님에게 카톡으로 보낼 현장별 접속 링크.
    // n = 현장명(base64url). 카톡 미리보기 카드 제목에 쓴다. 미리보기 봇은 JS를 실행하지 않아서
    // 페이지가 열린 뒤 제목을 바꿔봐야 소용없고, 링크에 실어 보내야 서버가 카드 제목을 만든다.
    // (갤러리 공유 링크와 같은 방식)
    function buildWorkerLink() {
        const name = (currentDetailData && currentDetailData.project && currentDetailData.project.현장명) || '';
        const query = name ? `?n=${toBase64Url(name)}` : '';
        return `${WORKER_APP_BASE_URL}/${activeProjectCode}${query}`;
    }

    window.copyWorkerLink = function() {
        if (activeProjectCode) {
            copyLink(buildWorkerLink());
        }
    };

    window.openWorkerLink = function() {
        if (activeProjectCode) {
            const url = buildWorkerLink();
            // 모바일 브라우저/웹뷰에서는 window.open()이 새 탭 대신 현재 창을 덮어써버리는 경우가 있어,
            // 실제 <a target="_blank"> 클릭을 흉내내는 방식이 더 안정적으로 새 탭을 연다.
            const a = document.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
    };

    // 다른 팀장에게 전달할 현장별 개별 링크 - admin.html 자기 자신 주소에 ?code=현장ID만 붙임.
    // 이 링크로 들어오면 암호 없이 바로 그 현장 화면으로 들어가고, 다른 현장 목록/전역 설정은 안 보임 (isScopedManagerView)
    window.copyManagerLink = function() {
        if (activeProjectCode) {
            const baseUrl = window.location.origin + window.location.pathname;
            copyLink(`${baseUrl}?code=${activeProjectCode}`);
        }
    };

    // 제목 줄바꿈 위치는 이 기기(localStorage)에만 기억한다. 실제 현장명은 한 줄로 저장한다 -
    // 드라이브 폴더 검색·노션 제목 등이 현장명을 그대로 쓰기 때문에 이름 안에 줄바꿈을 넣지 않는다.
    const TITLE_BREAK_KEY = 'siteTitleBreaks_v1';
    function loadTitleBreaks() {
        try { return JSON.parse(localStorage.getItem(TITLE_BREAK_KEY)) || {}; } catch (e) { return {}; }
    }
    function titleWithBreaks(projectId, name) {
        const lines = loadTitleBreaks()[projectId];
        return (Array.isArray(lines) && lines.join(' ') === name) ? lines.join('\n') : name;
    }
    function rememberTitleBreaks(projectId, lines) {
        const map = loadTitleBreaks();
        if (lines.length > 1) map[projectId] = lines; else delete map[projectId];
        try { localStorage.setItem(TITLE_BREAK_KEY, JSON.stringify(map)); } catch (e) { /* 저장 실패해도 이름 변경은 계속 */ }
    }

    // 현장명 수정 (제목 앞 연필 아이콘) - 오타 정정이나 동/호수 추가, 제목 줄 나누기용
    window.renameProjectPrompt = function() {
        if (!activeProjectCode) return;
        const current = (currentDetailData && currentDetailData.project && currentDetailData.project.현장명) || '';
        document.getElementById('renameInput').value = titleWithBreaks(activeProjectCode, current);
        document.getElementById('renameModal').style.display = 'flex';
    };

    window.closeRenameModal = function() {
        document.getElementById('renameModal').style.display = 'none';
    };

    window.submitRenameProject = async function() {
        if (!activeProjectCode) return;
        const current = (currentDetailData && currentDetailData.project && currentDetailData.project.현장명) || '';
        const lines = document.getElementById('renameInput').value.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length === 0) return;
        const newName = lines.join(' ');
        closeRenameModal();
        rememberTitleBreaks(activeProjectCode, lines);
        if (newName === current) {
            detailProjectTitle.textContent = titleWithBreaks(activeProjectCode, current);
            return;
        }

        showLoading("현장명 변경 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_project_name',
                    projectCode: activeProjectCode,
                    newName: newName
                })
            });
            if (!response.ok) throw new Error("현장명 변경 오류");

            // 현장 목록 캐시에도 즉시 반영해서, 뒤로 나갔을 때 재조회 없이 바로 새 이름이 보이게 함
            const project = globalProjectList.find(p => p.id === activeProjectCode);
            if (project) {
                if (project.fields) project.fields.현장명 = newName;
                else project.현장명 = newName;
            }
            refreshListCacheFromMemory();

            showToast("현장명이 변경되었습니다!");
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("현장명 변경에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 시공일 배지(달력)에서 날짜를 고르면 바로 저장. 견적 앱에서 날짜 없이 만든 현장을 여기서 채운다.
    // n8n 은 update_project_name 이 newDate 도 받는다 (보낸 것만 바꿈)
    window.saveProjectDate = async function(newDate) {
        if (!activeProjectCode || !newDate || isScopedManagerView) return;
        const current = (currentDetailData && currentDetailData.project && currentDetailData.project.시공일자) || '';
        if (newDate === current) return;

        showLoading("시공일 저장 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'update_project_name', projectCode: activeProjectCode, newDate: newDate })
            });
            if (!response.ok) throw new Error("시공일 변경 오류");

            // 목록 캐시에도 반영 - 뒤로 나가면 날짜순 자리로 바로 옮겨져 보이게
            const project = globalProjectList.find(p => p.id === activeProjectCode);
            if (project) {
                if (project.fields) project.fields.시공일자 = newDate;
                else project.시공일자 = newDate;
            }
            refreshListCacheFromMemory();

            showToast(`시공일을 ${newDate} 로 저장했습니다!`);
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("시공일 저장에 실패했습니다.", "danger");
            const dateInput = document.getElementById('detailDateInput');
            if (dateInput) dateInput.value = current;
        } finally {
            hideLoading();
        }
    };

    // 6. 새 현장 개설 제출
    window.handleNewProjectSubmit = async function(event) {
        event.preventDefault();

        const name = document.getElementById('newProjectName').value.trim();
        const date = document.getElementById('newProjectDate').value;
        const address = document.getElementById('newProjectAddress').value.trim();
        const notice = document.getElementById('newProjectNotice').value;
        const workers = document.getElementById('newProjectWorkers').value.trim();

        showLoading("신규 현장 등록 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'create_project',
                    projectName: name,
                    projectDate: date,
                    address: address,
                    notice: notice,
                    workersText: workers
                })
            });

            if (!response.ok) throw new Error("등록 오류");
            
            showToast("현장 등록이 성공적으로 완료되었습니다!");
            closeNewProjectModal();
            loadProjectList(true); // 방금 새로 생겼으니 캐시 말고 무조건 새로 조회
        } catch (error) {
            console.error(error);
            showToast("현장 등록에 실패했습니다. 다시 시도해 주세요.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 7. 상세 화면 진입 및 드래그 앤 드롭 업무 배분

    // 현장 상세 데이터는 조회에 2초 넘게 걸리는데, 폰에서 다른 앱 갔다 오면 브라우저가 탭을 버려서
    // 페이지가 통째로 다시 실행되고 그때마다 이 조회를 처음부터 다시 함 -> 들어올 때마다 로딩창 대기.
    // 그래서 상세 데이터도 목록처럼 세션에 저장해두고, 다시 들어올 땐 저장해둔 화면을 먼저 즉시 띄운 뒤
    // 최신 데이터는 뒤에서 조용히 받아와 바뀐 게 있을 때만 다시 그림.
    const DETAIL_CACHE_PREFIX = 'cachedProjectDetail_';
    const DETAIL_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 탭을 하루 종일 열어둔 경우 어제 화면이 잠깐 보이는 것 방지

    function readDetailCache(recordId) {
        try {
            const raw = sessionStorage.getItem(DETAIL_CACHE_PREFIX + recordId);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.data || !parsed.data.project) return null;
            if (Date.now() - (parsed.savedAt || 0) > DETAIL_CACHE_MAX_AGE_MS) return null;
            return parsed.data;
        } catch (e) {
            return null; // 캐시가 깨져있으면 없는 셈 치고 정상 조회
        }
    }

    function writeDetailCache(recordId, data) {
        try {
            sessionStorage.setItem(DETAIL_CACHE_PREFIX + recordId, JSON.stringify({ savedAt: Date.now(), data }));
        } catch (e) {
            // 저장공간이 꽉 찬 경우 - 캐시만 포기하고 기능은 그대로 진행
        }
    }

    function clearDetailCaches() {
        Object.keys(sessionStorage)
            .filter(k => k.startsWith(DETAIL_CACHE_PREFIX))
            .forEach(k => sessionStorage.removeItem(k));
    }

    // 배정표 화면에 실제로 그려지는 값들만 추려낸 요약본.
    // 사진 URL은 Airtable이 조회할 때마다 새로 발급해서 매번 달라지므로 비교에서 제외 -
    // 이걸로 비교해야 "바뀐 게 없는데 화면만 다시 그려서 펼쳐둔 카드가 접히는" 일이 안 생김
    function detailBoardSignature(data) {
        if (!data) return '';
        const p = data.project || {};
        const tasks = (data.tasks || []).map(t => {
            const f = t.fields || {};
            return [t.id, f.시공품목, f.밑작업기사, f.시공기사, !!f.밑작업완료, !!f.시공완료,
                    f.작업우선순위, f.시공우선순위, f.현장특이사항].join('|');
        });
        return JSON.stringify([p.현장명, p.시공일자, p.공지사항, p.중점체크사항,
                               (data.workers || []).join(','), (data.activeItems || []).join(','), tasks]);
    }

    function applyDetailData(recordId, data) {
        currentDetailData = data;

        // 최신 작업 현황으로 현장 목록 카드의 진행률 캐시도 같이 갱신
        // (재조회 없이도 목록으로 돌아갔을 때 최신 숫자가 보이게)
        const dtasks = currentDetailData.tasks || [];
        projectProgressCache.set(recordId, {
            done: dtasks.filter(t => t.fields.밑작업완료 && t.fields.시공완료).length,
            total: dtasks.length
        });

        // 상세 화면 첫 진입 시 첫 번째 기사님을 자동으로 선택하여 배정표가 바로 열리도록 설정
        if (!activeWorkerName && currentDetailData.workers && currentDetailData.workers.length > 0) {
            activeWorkerName = currentDetailData.workers[0];
        }
    }

    // useCache: 단순히 화면에 들어오기만 하는 경우(앱 재진입 / 현장 카드 클릭)에만 true.
    // 저장 직후 재조회나 🔄 새로고침은 방금 바뀐 내용이 반드시 보여야 하므로 캐시를 쓰지 않음
    async function showProjectDetail(recordId, options = {}) {
        const { useCache = false } = options;

        if (recordId !== activeProjectCode) {
            // 다른 현장으로 이동하는 경우에만 이전 현장의 선택/배정 상태를 초기화
            activeWorkerName = null;
            activeZoneTab = null;
            zonePendingChanges.clear();
        }
        activeProjectCode = recordId;

        const cached = useCache ? readDetailCache(recordId) : null;
        if (cached) {
            // 저장해둔 화면을 로딩창 없이 먼저 보여주고, 최신화는 아래에서 뒤따라 진행
            applyDetailData(recordId, cached);
            renderDetailSection();
            showSection('projectDetailSection');
            localStorage.setItem('lastActiveProjectCode', recordId);
        } else {
            showLoading("현장 상세 정보를 불러오는 중...");
        }

        try {
            const response = await fetchWithTimeout(`${API_DETAIL_URL}?code=${recordId}`);
            if (!response.ok) throw new Error("상세조회 실패");

            const result = await response.json();
            // n8n은 데이터를 리턴할 때 항상 배열 [ { ... } ] 형태로 감싸서 주므로, 첫 번째 원소를 꺼내줍니다.
            const data = Array.isArray(result) ? result[0] : result;

            // 응답을 기다리는 사이에 다른 현장으로 옮겨갔으면 지금 보고 있는 화면을 덮어쓰지 않음
            if (activeProjectCode !== recordId) return;

            writeDetailCache(recordId, data);
            const boardChanged = !cached || detailBoardSignature(cached) !== detailBoardSignature(data);
            applyDetailData(recordId, data);

            // 캐시로 이미 띄워둔 화면은, 실제로 내용이 바뀌었을 때만 다시 그림
            if (boardChanged) renderDetailSection();
            if (!cached) {
                showSection('projectDetailSection');
                // 마지막으로 보던 현장을 기억해뒀다가, 앱을 다시 열면 이 현장 화면으로 바로 복귀
                localStorage.setItem('lastActiveProjectCode', recordId);
            }
        } catch (error) {
            console.error(error);
            if (cached) {
                // 화면은 저장해둔 내용으로 이미 떠 있으므로 닫지 않고, 최신화에 실패했다는 것만 알림
                showToast("최신 정보를 받지 못했습니다. 마지막으로 보던 내용입니다.", "danger");
            } else {
                showToast("현장 데이터를 불러오지 못했습니다.", "danger");
                localStorage.removeItem('lastActiveProjectCode');
            }
        } finally {
            hideLoading();
        }
    }

    // 현장 목록 카드의 "⚠️ 미완료 보기" 링크 - 상세화면 들어가자마자 미완료 품목만 바로 보여줌
    window.openProjectIncompleteView = async function(recordId) {
        await showProjectDetail(recordId);
        activeZoneTab = INCOMPLETE_TAB;
        renderZoneAssignBoard();
    };

    // 🔄 버튼 - 현재 보고 있는 현장 데이터를 다시 불러와서 배정표/완료 상태를 최신으로 갱신
    window.refreshBoardData = async function() {
        if (!activeProjectCode) return;
        await showProjectDetail(activeProjectCode);
        showToast("최신 정보로 새로고침했습니다.", "success");
    };


    function renderDetailSection() {
        const p = currentDetailData.project;
        detailProjectTitle.textContent = titleWithBreaks(activeProjectCode, p.현장명);
        const dateParts = String(p.시공일자 || '').split('-');
        detailProjectDate.textContent = `시공일: ${dateParts.length === 3 ? `${Number(dateParts[1])}/${Number(dateParts[2])}` : '미정'}`;
        const dateInput = document.getElementById('detailDateInput');
        if (dateInput) {
            dateInput.value = p.시공일자 || '';
            dateInput.disabled = !!isScopedManagerView; // 현장소장 링크 화면에서는 날짜를 못 바꾼다
        }

        // 공지 및 주의사항 표시
        const noticeEl = document.getElementById('detailProjectNotice');
        if (noticeEl) {
            noticeEl.value = p.공지사항 || "";
        }
        renderQuickTagsInto('detailNoticeQuickTags', 'detailProjectNotice');
        renderNoticeSamplePhotos();

        // 중점체크사항 (사장님 전용 점검 메모장) 렌더링
        renderCheckpointChecklist();

        // 1. 3분할 보드 - 1열 (시공기사 목록) 렌더링
        renderBoardWorkers();

        // 2. 3분할 보드 - 3열 (구역별 품목 활성화 + 기사 배정 매트릭스) 렌더링
        renderZoneAssignBoard();

        // 3. 3분할 보드 - 2열 (배정 내역 리스트) 렌더링
        renderBoardAssignments();
    }

    const INCOMPLETE_TAB = '__INCOMPLETE__'; // 구역 탭 대신 "미완료만 보기"를 고른 상태를 나타내는 특수값

    // 구역별 품목 활성화 + 기사 배정 매트릭스 (구역 탭 + 탭 내 품목 행 리스트)
    function renderZoneAssignBoard() {
        const allItems = [...(currentDetailData.masterItems || [])];
        const activeItems = currentDetailData.activeItems || []; // 이미 현장에 개설 완료된 품목들
        const tasks = currentDetailData.tasks || [];
        const workers = currentDetailData.workers || [];

        // 구역 탭은 실제 등록된 품목들의 구역 값 기준으로 동적으로 만듦 (2층/3층 등 새 구역이 나와도
        // 코드 수정 없이 자동으로 탭이 생김). 값이 비어있는 품목만 "기타"로 묶음
        // 뒷정리('한번에' 품목)는 구역과 상관없는 일이라 구역 탭에 섞지 않고 🧹 뒷정리 탭에 따로 모은다
        const cleanupItems = allItems.filter(item => item.작업방식 === '한번에');
        const zoneMap = new Map();
        allItems.forEach(item => {
            if (item.작업방식 === '한번에') return;
            const zone = item.구역 || "기타";
            if (!zoneMap.has(zone)) zoneMap.set(zone, []);
            zoneMap.get(zone).push(item);
        });

        const zoneNames = sortZones([...zoneMap.keys()]);

        // 구역 상관없이 활성화됐지만 밑작업+시공이 둘 다 안 끝난 품목만 모음 - "미완료" 탭용
        const incompleteEntries = [];
        allItems.forEach(item => {
            // 뒷정리는 매일 새로 하는 일이라 '미완료' 에 넣으면 현장이 끝날 때까지 안 빠진다 - 🧹 탭에서 본다
            if (item.작업방식 === '한번에') return;
            const zone = item.구역 || "기타";
            const isActive = activeItems.includes(item.품목명);
            if (!isActive) return;
            const task = tasks.find(t => t.fields.시공품목 === item.품목명);
            if (!task) return;
            // 파손 비포는 찍었는데 애프터가 아직 없으면(순서상 개수가 안 맞으면), 밑작업/시공이 다 끝났어도 미완료로 취급
            const isValidDamagePhoto = (p) => !!p && p.url && !p.url.includes('1x1.png');
            const damageBeforeCount = (task.fields.파손비포사진 || []).filter(isValidDamagePhoto).length;
            const damageAfterCount = (task.fields.파손애프터사진 || []).filter(isValidDamagePhoto).length;
            const hasUnpairedDamagePhoto = damageBeforeCount > damageAfterCount;
            const isFullyCompleted = !!(task.fields.밑작업완료 && task.fields.시공완료) && !hasUnpairedDamagePhoto;
            if (!isFullyCompleted) incompleteEntries.push({ item, task, zone });
        });

        const cleanupTabOk = activeZoneTab === CLEANUP_TAB && cleanupItems.length > 0;
        if (!activeZoneTab || (activeZoneTab !== INCOMPLETE_TAB && !cleanupTabOk && !zoneMap.has(activeZoneTab))) {
            activeZoneTab = zoneNames[0] || (cleanupItems.length ? CLEANUP_TAB : null);
        }
        // 미완료 탭을 보다가 마지막 미완료 항목까지 끝내면 자동으로 첫 구역 탭으로 돌아감
        if (activeZoneTab === INCOMPLETE_TAB && incompleteEntries.length === 0) {
            activeZoneTab = zoneNames[0] || null;
        }

        zoneAssignTabs.innerHTML = "";

        if (incompleteEntries.length > 0) {
            const incompleteTab = document.createElement('button');
            incompleteTab.type = 'button';
            incompleteTab.className = `item-category-tab incomplete-tab ${activeZoneTab === INCOMPLETE_TAB ? 'active' : ''}`;
            incompleteTab.textContent = `⚠️ 미완료 (${incompleteEntries.length})`;
            incompleteTab.addEventListener('click', () => {
                activeZoneTab = INCOMPLETE_TAB;
                renderZoneAssignBoard();
            });
            zoneAssignTabs.appendChild(incompleteTab);
        }

        if (cleanupItems.length > 0) {
            // (오늘 끝낸 수 / 켜 둔 수) - 매일 하는 일은 날짜가 바뀌면 다시 0부터
            const 켜진것 = cleanupItems.filter(item => activeItems.includes(item.품목명));
            const 끝낸수 = 켜진것.filter(item => {
                const t = tasks.find(x => x.fields.시공품목 === item.품목명);
                return t && 뒷정리완료(t.fields, item.품목명);
            }).length;
            const cleanupTab = document.createElement('button');
            cleanupTab.type = 'button';
            cleanupTab.className = `item-category-tab cleanup-tab ${activeZoneTab === CLEANUP_TAB ? 'active' : ''}`;
            cleanupTab.textContent = 켜진것.length ? `🧹 현장정리 (${끝낸수}/${켜진것.length})` : `🧹 현장정리 (${cleanupItems.length})`;
            cleanupTab.addEventListener('click', () => {
                activeZoneTab = CLEANUP_TAB;
                renderZoneAssignBoard();
            });
            zoneAssignTabs.appendChild(cleanupTab);
        }

        zoneNames.forEach(zone => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = `item-category-tab ${zone === activeZoneTab ? 'active' : ''}`;
            tab.textContent = `${zone} (${zoneMap.get(zone).length})`;
            tab.addEventListener('click', () => {
                activeZoneTab = zone;
                renderZoneAssignBoard();
            });
            zoneAssignTabs.appendChild(tab);
        });

        zoneAssignItemList.innerHTML = "";

        // "미완료" 탭: 구역 구분 없이 미완료 품목만 방 이름 붙여서 나열
        if (activeZoneTab === INCOMPLETE_TAB) {
            zoneItemCountBadge.textContent = `${incompleteEntries.length}개`;
            incompleteEntries.forEach(({ item, task, zone }) => {
                zoneAssignItemList.appendChild(createZoneItemRow(item, true, task, workers, zone));
            });
            return;
        }

        const itemsInZone = [...(activeZoneTab === CLEANUP_TAB ? cleanupItems : (zoneMap.get(activeZoneTab) || []))];
        // 켜져 있는(활성화된) 품목이 위로 모이고, 꺼져있는 품목은 아래로 - 이미 시공할 걸로 골라둔 것부터 눈에 띄게
        itemsInZone.sort((a, b) => {
            const aActive = getEffectiveActive(a.품목명);
            const bActive = getEffectiveActive(b.품목명);
            if (aActive !== bActive) return aActive ? -1 : 1;
            const pA = a.우선순위 !== undefined ? a.우선순위 : 999;
            const pB = b.우선순위 !== undefined ? b.우선순위 : 999;
            if (pA !== pB) return pA - pB;
            return (a.품목명 || "").localeCompare(b.품목명 || "");
        });

        zoneItemCountBadge.textContent = `${itemsInZone.length}개`;

        if (itemsInZone.length === 0) {
            zoneAssignItemList.innerHTML = `<div class="empty-state" style="padding: 20px;">이 구역에 등록된 품목이 없습니다.</div>`;
            return;
        }

        itemsInZone.forEach(item => {
            const isActive = activeItems.includes(item.품목명);
            const task = tasks.find(t => t.fields.시공품목 === item.품목명);
            zoneAssignItemList.appendChild(createZoneItemRow(item, isActive, task, workers));
        });

        updateZoneSaveToolbar();
    }

    function createZoneItemRow(item, isActive, task, workers, zoneLabel) {
        const itemName = item.품목명;
        const fields = task ? task.fields : {};
        const 뒷정리 = item.작업방식 === '한번에';
        const pending = zonePendingChanges.get(itemName) || {};
        const effectiveActive = pending.active !== undefined ? pending.active : isActive;
        const effectivePrep = pending.밑작업 !== undefined ? pending.밑작업 : (fields.밑작업기사 || "");
        const effectiveWrap = pending.시공 !== undefined ? pending.시공 : (fields.시공기사 || "");
        const hasAnyAssignee = 뒷정리 ? !!effectiveWrap : !!(effectivePrep || effectiveWrap);
        const isValidDamagePhotoRow = (p) => !!p && p.url && !p.url.includes('1x1.png');
        const damageBeforeCountRow = (fields.파손비포사진 || []).filter(isValidDamagePhotoRow).length;
        const damageAfterCountRow = (fields.파손애프터사진 || []).filter(isValidDamagePhotoRow).length;
        const isFullyCompleted = 뒷정리
            ? !!(isActive && task && 뒷정리완료(fields, itemName))
            : !!(fields.밑작업완료 && fields.시공완료) && damageBeforeCountRow <= damageAfterCountRow;

        const row = document.createElement('div');
        row.className = `zone-item-row ${isFullyCompleted ? 'completed' : ''} ${zonePendingChanges.has(itemName) ? 'pending' : ''}`;

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'zone-item-toggle';
        if (hasAnyAssignee) toggleLabel.title = '기사가 배정된 품목은 비활성화할 수 없습니다.';
        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.checked = effectiveActive;
        toggleInput.disabled = hasAnyAssignee;
        toggleInput.addEventListener('change', () => {
            setZonePending(itemName, 'active', toggleInput.checked, isActive);
            renderZoneAssignBoard();
        });
        toggleLabel.appendChild(toggleInput);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'zone-item-name';
        nameSpan.textContent = zoneLabel ? `${itemName} · ${zoneLabel}` : itemName;
        if (뒷정리) {
            const modeBadge = document.createElement('span');
            modeBadge.className = 'zone-item-mode-badge';
            modeBadge.textContent = item.반복 === '매일' ? '매일' : '한 번';
            nameSpan.appendChild(modeBadge);
        }

        // 기사 배정 전이라도 밑작업/시공 지침을 미리 손볼 수 있는 버튼 - 품목이 켜져 있어야(작업 레코드가 있어야) 누를 수 있음
        // 뒷정리는 밑작업/시공 구분이 없어(담당 한 명) 지침 버튼도 하나만 노출
        const guidelineBtnWrap = document.createElement('div');
        guidelineBtnWrap.className = 'zone-item-guideline-wrap';
        if (뒷정리) {
            guidelineBtnWrap.appendChild(createGuidelineStageBtn(itemName, '시공', task, '📋 지침'));
        } else {
            guidelineBtnWrap.appendChild(createGuidelineStageBtn(itemName, '밑작업', task, '🔧 밑작업'));
            guidelineBtnWrap.appendChild(createGuidelineStageBtn(itemName, '시공', task, '🛠 시공'));
        }

        const assignWrap = document.createElement('div');
        assignWrap.className = 'zone-item-assign';
        if (뒷정리) {
            // 뒷정리는 밑작업/시공으로 안 나뉜다 - 담당 한 명(시공기사 칸에 저장)
            assignWrap.appendChild(createZoneAssignSelect(itemName, '시공', effectiveWrap, effectiveActive, fields, workers, isActive, '담당'));
        } else {
            assignWrap.appendChild(createZoneAssignSelect(itemName, '밑작업', effectivePrep, effectiveActive, fields, workers, isActive));
            assignWrap.appendChild(createZoneAssignSelect(itemName, '시공', effectiveWrap, effectiveActive, fields, workers, isActive));
        }

        row.appendChild(toggleLabel);
        row.appendChild(nameSpan);
        row.appendChild(guidelineBtnWrap);
        row.appendChild(assignWrap);

        if (isFullyCompleted) {
            const badge = document.createElement('span');
            badge.className = 'zone-item-done-badge';
            badge.textContent = '✅';
            if (뒷정리 && item.반복 === '매일') badge.title = '오늘 완료';
            row.appendChild(badge);
        }

        return row;
    }

    function createGuidelineStageBtn(itemName, stage, task, label) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'zone-item-guideline-btn';
        btn.textContent = label;
        btn.disabled = !task;
        btn.title = task ? `${stage} 지침 편집` : '먼저 품목을 켜야 지침을 편집할 수 있습니다.';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.openItemStageGuidelineModal(itemName, stage);
        });
        return btn;
    }

    function createZoneAssignSelect(itemName, stage, effectiveValue, effectiveActive, fields, workers, isActive, placeholder) {
        const select = document.createElement('select');
        select.className = 'zone-assign-select';
        // 매일 하는 뒷정리는 날마다 담당이 바뀔 수 있어 끝냈어도 잠그지 않는다
        const isDone = isActive && !is매일(itemName) && !!(stage === '밑작업' ? fields.밑작업완료 : fields.시공완료);
        select.disabled = !effectiveActive || isDone;
        if (isDone) select.classList.add('done');

        let optionsHtml = `<option value="">${placeholder || stage}</option>`;
        workers.forEach(w => {
            optionsHtml += `<option value="${w}">${w}</option>`;
        });
        select.innerHTML = optionsHtml;
        select.value = effectiveValue || "";

        select.addEventListener('change', () => {
            const serverValue = isActive ? (fields[stage + '기사'] || "") : "";
            setZonePending(itemName, stage, select.value, serverValue);
            renderZoneAssignBoard();
        });

        return select;
    }

    // ===== 품목별 밑작업/시공 지침 편집 모달 (기사 배정 없이도 바로 편집 가능) =====
    // 원래는 업무배정표 카드(기사 배정된 것만 보임)에서만 밑작업/시공 지침을 손볼 수 있었는데,
    // 배정 전에 미리 지침부터 정리해두고 싶다는 요청으로 추가. 품목 배정 매트릭스 행에서 바로 열리고,
    // 업무배정표 카드와 완전히 같은 본문(buildGuidelineStageInnerHtml)을 그대로 재사용해서
    // "다른 카테고리 품목에 적용" 일괄적용까지 카드에서와 동일하게 동작함.
    window.openItemStageGuidelineModal = function(itemName, stage) {
        const task = (currentDetailData.tasks || []).find(t => t.fields.시공품목 === itemName);
        if (!task) {
            showToast('먼저 품목을 켜야 지침을 편집할 수 있습니다.', 'danger');
            return;
        }
        document.getElementById('itemGuidelineModalTitle').textContent = `${stage === '밑작업' ? '🔧' : '🛠'} "${itemName}" (${stage}) 지침 편집`;
        const bodyEl = document.getElementById('itemGuidelineBody');
        bodyEl.innerHTML = `<div class="assignment-card-body" style="display: block; padding-top: 4px;">${buildGuidelineStageInnerHtml(task, stage)}</div>`;
        document.getElementById('itemGuidelineModal').style.display = 'flex';
    };

    window.closeItemGuidelineModal = function() {
        document.getElementById('itemGuidelineModal').style.display = 'none';
    };

    // 대기 중인 변경사항까지 반영한 "지금 화면에 보여줄" 활성화 여부 (서버 상태 + 아직 저장 안 한 토글)
    function getEffectiveActive(itemName) {
        const pending = zonePendingChanges.get(itemName);
        const isActiveNow = (currentDetailData.activeItems || []).includes(itemName);
        return (pending && pending.active !== undefined) ? pending.active : isActiveNow;
    }

    // 매트릭스에서 체크/선택한 내용을 임시로만 기록 (서버에는 저장 버튼을 눌러야 반영됨)
    // 원래 서버 상태로 되돌아오면 해당 항목의 대기 기록을 지워서 "N개 대기중" 카운트를 정확히 유지
    function setZonePending(itemName, key, value, baseline) {
        let entry = zonePendingChanges.get(itemName);
        if (value === baseline) {
            if (entry) {
                delete entry[key];
                if (Object.keys(entry).length === 0) zonePendingChanges.delete(itemName);
            }
            return;
        }
        if (!entry) {
            entry = {};
            zonePendingChanges.set(itemName, entry);
        }
        entry[key] = value;
    }

    // 목록 아래(zoneSaveToolbar)와 목록 위(zoneSaveToolbarTop) 두 곳에 저장 툴바를 두어서,
    // 품목이 많아 아래까지 스크롤하지 않아도 바로 저장할 수 있게 함 - 둘 다 항상 같은 상태로 동기화
    function updateZoneSaveToolbar() {
        const n = zonePendingChanges.size;
        [['zoneSaveToolbar', 'zoneSaveCount'], ['zoneSaveToolbarTop', 'zoneSaveCountTop']].forEach(([toolbarId, countId]) => {
            const toolbar = document.getElementById(toolbarId);
            const countEl = document.getElementById(countId);
            if (!toolbar || !countEl) return;
            if (n > 0) {
                toolbar.style.display = 'flex';
                countEl.textContent = `${n}개 품목 변경사항 대기 중`;
            } else {
                toolbar.style.display = 'none';
            }
        });
    }

    window.cancelZonePendingChanges = function() {
        zonePendingChanges.clear();
        renderZoneAssignBoard();
    };

    // 매트릭스에 쌓인 활성화/비활성화 + 기사 배정 변경사항을 한 번에 서버에 반영
    window.saveZonePendingChanges = async function() {
        if (zonePendingChanges.size === 0) return;
        const entries = [...zonePendingChanges.entries()];
        const activeItems = currentDetailData.activeItems || [];
        const tasks = currentDetailData.tasks || [];

        showLoading(`변경사항 ${entries.length}건 저장 중...`);
        try {
            // 1. 활성화/비활성화 처리 (신규 생성된 품목의 레코드 ID 확보)
            const newRecordIds = {};
            for (const [itemName, change] of entries) {
                if (change.active === undefined) continue;
                const serverActive = activeItems.includes(itemName);
                if (change.active === serverActive) continue;

                if (change.active) {
                    const res = await fetchWithTimeout(API_SAVE_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'toggle_item_create', projectCode: activeProjectCode, itemName: itemName })
                    });
                    if (!res.ok) throw new Error(`${itemName} 활성화 실패`);
                    const data = await res.json().catch(() => null);
                    const rec = Array.isArray(data) ? data[0] : data;
                    if (rec && rec.id) newRecordIds[itemName] = rec.id;
                } else {
                    const res = await fetchWithTimeout(API_SAVE_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'toggle_item_delete', projectCode: activeProjectCode, itemName: itemName })
                    });
                    if (!res.ok) throw new Error(`${itemName} 제외 실패`);
                }
            }

            // 2. 기사 배정/취소 처리 (신규 활성화된 품목은 방금 받은 레코드 ID 사용)
            //   - 이번에 끈 품목은 레코드가 방금 지워졌으므로 배정 취소를 보내지 않는다
            //     (예전에는 지워진 레코드에 취소를 보내 '없는 레코드' 오류가 나고, 나머지는 다 저장됐는데도
            //      '일부 저장 실패' 가 떠서 배정이 안 된 줄 알았다 - 2026-10-08)
            //   - 하나가 실패해도 나머지는 그대로 보내고, 실패한 품목 이름을 알려준다
            const assignJobs = [];
            const failed = [];
            entries.forEach(([itemName, change]) => {
                if (change.active === false) return;
                const task = tasks.find(t => t.fields.시공품목 === itemName);
                const recordId = newRecordIds[itemName] || (task && task.id);
                const wantsAssign = ['밑작업', '시공'].some(stage => change[stage]);
                if (!recordId) {
                    if (wantsAssign) failed.push(`${itemName} (품목 켜기 확인 안 됨)`);
                    return;
                }

                ['밑작업', '시공'].forEach(stage => {
                    if (change[stage] === undefined) return;
                    const serverValue = task ? (task.fields[stage + '기사'] || "") : "";
                    if (change[stage] === serverValue) return;

                    const body = change[stage]
                        ? { type: 'assign_worker', projectCode: activeProjectCode, recordId: recordId, workerName: change[stage], stage: stage }
                        : { type: 'unassign_worker', projectCode: activeProjectCode, recordId: recordId, stage: stage };
                    assignJobs.push({ label: `${itemName} ${stage}`, run: () => fetchWithTimeout(API_SAVE_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    }).then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); }) });
                });
            });
            const results = await Promise.allSettled(assignJobs.map(j => j.run()));
            results.forEach((r, i) => { if (r.status === 'rejected') failed.push(assignJobs[i].label); });

            zonePendingChanges.clear();
            if (failed.length) {
                showToast(`저장 못 한 것: ${failed.join(', ')} — 다시 지정해 주세요. (나머지는 저장됨)`, "danger");
            } else {
                showToast(`${entries.length}개 품목의 변경사항이 저장되었습니다!`);
            }
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast(`저장에 실패했습니다: ${error.message} — 다시 확인해 주세요.`, "danger");
            zonePendingChanges.clear();
            await showProjectDetail(activeProjectCode);
        } finally {
            hideLoading();
        }
    };

    // ===== 품목 일괄설정 모달 =====
    // 구역 탭을 하나씩 넘기며 품목을 찾아 켜는 게 번거로워서, 전체 구역을 한 화면에 펼쳐놓고
    // 시공할 품목을 빠르게 체크할 수 있게 함. 체크 상태는 기존 zonePendingChanges에 그대로 쌓여서
    // 매트릭스 화면 하단의 저장 툴바와 완전히 같은 방식으로 동작함(모달 안에서 바로 저장도 가능).
    // 구역이 14개나 되다 보니 한 화면에 다 펼쳐놓으면 찾기 힘들어서, 구역별 탭(색깔 구분)으로 나눠
    // 지금 보고 있는 구역의 품목만 렌더링한다.
    let bulkItemSetupGroups = []; // [{ key, label, items }]
    let bulkItemSetupActiveKey = null;
    let bulkItemSetupMode = 'category'; // 'category' | 'zone' - 문+틀/샤시처럼 종류별로 보는 게 기본, 구역별로도 전환 가능
    const BULK_ITEM_TAB_COLORS = [
        { bg: '#dbeafe', text: '#1e40af' },
        { bg: '#dcfce7', text: '#166534' },
        { bg: '#fef3c7', text: '#92400e' },
        { bg: '#fce7f3', text: '#9d174d' },
        { bg: '#ede9fe', text: '#5b21b6' },
        { bg: '#ffe4e6', text: '#9f1239' },
        { bg: '#cffafe', text: '#155e75' },
        { bg: '#fef9c3', text: '#854d0e' },
        { bg: '#e0e7ff', text: '#3730a3' },
        { bg: '#d1fae5', text: '#065f46' }
    ];

    // 구역별/카테고리별 두 가지 방식으로 품목을 묶음 - 카테고리는 시공품목 마스터의 카테고리 값을 그대로 씀
    // (뒷정리 품목들도 카테고리 값이 "뒷정리"로 들어있어서 별도 처리 없이 자연스럽게 한 탭으로 묶임)
    function buildBulkItemGroups(mode) {
        const allItems = [...(currentDetailData.masterItems || [])];
        if (mode === 'category') {
            const catMap = new Map();
            allItems.forEach(item => {
                const cat = item.카테고리 || '기타';
                if (!catMap.has(cat)) catMap.set(cat, []);
                catMap.get(cat).push(item);
            });
            const catNames = [...catMap.keys()].sort((a, b) => {
                if (a === '기타') return 1;
                if (b === '기타') return -1;
                return catMap.get(b).length - catMap.get(a).length; // 품목 많은 카테고리가 앞으로
            });
            return catNames.map(cat => ({ key: `c:${cat}`, label: cat, items: catMap.get(cat) }));
        }

        const cleanupItems = allItems.filter(item => item.작업방식 === '한번에');
        const zoneMap = new Map();
        allItems.forEach(item => {
            if (item.작업방식 === '한번에') return;
            const zone = item.구역 || '기타';
            if (!zoneMap.has(zone)) zoneMap.set(zone, []);
            zoneMap.get(zone).push(item);
        });
        const zoneNames = sortZones([...zoneMap.keys()]);
        const groups = zoneNames.map(zone => ({ key: `z:${zone}`, label: zone, items: zoneMap.get(zone) }));
        if (cleanupItems.length > 0) groups.push({ key: 'z:__CLEANUP__', label: '🧹 현장정리', items: cleanupItems });
        return groups;
    }

    window.openBulkItemSetupModal = function() {
        bulkItemSetupGroups = buildBulkItemGroups(bulkItemSetupMode);
        bulkItemSetupActiveKey = bulkItemSetupGroups[0] ? bulkItemSetupGroups[0].key : null;

        renderBulkItemSetupModeToggle();
        renderBulkItemSetupTabs();
        renderBulkItemSetupBody();
        updateBulkItemSetupCount();
        document.getElementById('bulkItemSetupModal').style.display = 'flex';
    };

    function renderBulkItemSetupModeToggle() {
        const el = document.getElementById('bulkItemSetupModeToggle');
        if (!el) return;
        el.innerHTML = `
            <button type="button" class="bulk-item-mode-btn ${bulkItemSetupMode === 'category' ? 'active' : ''}" onclick="setBulkItemSetupMode('category')">카테고리별</button>
            <button type="button" class="bulk-item-mode-btn ${bulkItemSetupMode === 'zone' ? 'active' : ''}" onclick="setBulkItemSetupMode('zone')">구역별</button>
        `;
    }

    window.setBulkItemSetupMode = function(mode) {
        if (mode === bulkItemSetupMode) return;
        bulkItemSetupMode = mode;
        bulkItemSetupGroups = buildBulkItemGroups(bulkItemSetupMode);
        bulkItemSetupActiveKey = bulkItemSetupGroups[0] ? bulkItemSetupGroups[0].key : null;
        renderBulkItemSetupModeToggle();
        renderBulkItemSetupTabs();
        renderBulkItemSetupBody();
    };

    function renderBulkItemSetupTabs() {
        const tabsEl = document.getElementById('bulkItemSetupTabs');
        tabsEl.innerHTML = bulkItemSetupGroups.map((g, idx) => {
            const activeCount = g.items.filter(item => getEffectiveActive(item.품목명)).length;
            const color = BULK_ITEM_TAB_COLORS[idx % BULK_ITEM_TAB_COLORS.length];
            const isActive = g.key === bulkItemSetupActiveKey;
            const style = isActive
                ? `background:${color.text}; color:#fff; border-color:${color.text};`
                : `background:${color.bg}; color:${color.text}; border-color:${color.bg};`;
            const safeKey = g.key.replace(/'/g, "\\'");
            return `<button type="button" class="bulk-item-setup-tab" style="${style}" onclick="selectBulkItemSetupTab('${safeKey}')">${g.label} (${activeCount}/${g.items.length})</button>`;
        }).join('');
    }

    window.selectBulkItemSetupTab = function(key) {
        bulkItemSetupActiveKey = key;
        renderBulkItemSetupTabs();
        renderBulkItemSetupBody();
    };

    function renderBulkItemSetupBody() {
        const group = bulkItemSetupGroups.find(g => g.key === bulkItemSetupActiveKey);
        const bodyEl = document.getElementById('bulkItemSetupBody');
        if (!group) {
            bodyEl.innerHTML = '';
            return;
        }
        const tasks = currentDetailData.tasks || [];
        // 여기도 매트릭스와 똑같이 켜진 품목이 위로 모이게 정렬
        const sorted = [...group.items].sort((a, b) => {
            const aActive = getEffectiveActive(a.품목명);
            const bActive = getEffectiveActive(b.품목명);
            if (aActive !== bActive) return aActive ? -1 : 1;
            const pA = a.우선순위 !== undefined ? a.우선순위 : 999;
            const pB = b.우선순위 !== undefined ? b.우선순위 : 999;
            if (pA !== pB) return pA - pB;
            return (a.품목명 || '').localeCompare(b.품목명 || '');
        });
        const rowsHtml = sorted.map(item => {
            const itemName = item.품목명;
            const task = tasks.find(t => t.fields.시공품목 === itemName);
            const fields = task ? task.fields : {};
            const pending = zonePendingChanges.get(itemName) || {};
            const effectiveActive = getEffectiveActive(itemName);
            const 뒷정리 = item.작업방식 === '한번에';
            const effectivePrep = pending.밑작업 !== undefined ? pending.밑작업 : (fields.밑작업기사 || '');
            const effectiveWrap = pending.시공 !== undefined ? pending.시공 : (fields.시공기사 || '');
            const hasAnyAssignee = 뒷정리 ? !!effectiveWrap : !!(effectivePrep || effectiveWrap);
            const safeAttr = itemName.replace(/"/g, '&quot;');
            return `
                <label class="bulk-item-row${hasAnyAssignee ? ' locked' : ''}"${hasAnyAssignee ? ' title="기사가 배정된 품목은 여기서 끌 수 없습니다."' : ''}>
                    <input type="checkbox" class="bulk-item-checkbox" data-item="${safeAttr}" ${effectiveActive ? 'checked' : ''} ${hasAnyAssignee ? 'disabled' : ''}>
                    <span>${itemName}</span>
                </label>
            `;
        }).join('');

        bodyEl.innerHTML = `<div class="bulk-item-zone-rows">${rowsHtml}</div>`;
        bodyEl.querySelectorAll('.bulk-item-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const itemName = cb.dataset.item;
                const isActiveNow = (currentDetailData.activeItems || []).includes(itemName);
                setZonePending(itemName, 'active', cb.checked, isActiveNow);
                renderBulkItemSetupTabs();
                updateBulkItemSetupCount();
                updateZoneSaveToolbar();
            });
        });
    }

    function updateBulkItemSetupCount() {
        const countEl = document.getElementById('bulkItemSetupCount');
        if (!countEl) return;
        const n = zonePendingChanges.size;
        countEl.textContent = n > 0 ? `${n}개 품목 변경사항 대기 중` : '';
    }

    window.closeBulkItemSetupModal = function() {
        document.getElementById('bulkItemSetupModal').style.display = 'none';
    };

    window.saveBulkItemSetup = async function() {
        await window.saveZonePendingChanges();
        window.closeBulkItemSetupModal();
    };

    // 1열: 기사 리스트 그리기
    function renderBoardWorkers() {
        boardWorkerList.innerHTML = "";
        const workers = currentDetailData.workers || [];
        workerCountBadge.textContent = `${workers.length}명`;

        // 이전에 선택했던 기사님이 더 이상 목록에 없으면 선택 해제
        if (activeWorkerName && !workers.includes(activeWorkerName)) {
            activeWorkerName = null;
        }

        workers.forEach((worker, idx) => {
            const card = document.createElement('div');
            card.className = `worker-card ${worker === activeWorkerName ? 'active' : ''}`;
            card.innerHTML = `
                <span class="worker-card-name">${worker}</span>
                <div class="worker-card-toolbar">
                    <button type="button" class="worker-card-move-btn" data-dir="-1" title="위로 이동" ${idx === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" class="worker-card-move-btn" data-dir="1" title="아래로 이동" ${idx === workers.length - 1 ? 'disabled' : ''}>▼</button>
                    <button type="button" class="worker-card-edit-btn" title="이름 수정">✎</button>
                    <button type="button" class="worker-card-delete-btn" title="삭제">🗑</button>
                </div>
            `;

            const editBtn = card.querySelector('.worker-card-edit-btn');
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                renameWorkerPrompt(worker);
            });

            const deleteBtn = card.querySelector('.worker-card-delete-btn');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteWorkerPrompt(worker);
            });

            card.querySelectorAll('.worker-card-move-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (btn.disabled) return;
                    moveWorker(worker, parseInt(btn.dataset.dir, 10));
                });
            });

            // HTML5 드롭존(Drop Zone) 이벤트 연결
            card.addEventListener('dragover', (e) => {
                e.preventDefault();
                card.classList.add('dragover');
            });

            card.addEventListener('dragleave', () => {
                card.classList.remove('dragover');
            });

            card.addEventListener('drop', async (e) => {
                e.preventDefault();
                card.classList.remove('dragover');
                if (draggedData) {
                    await assignWorker(draggedData.recordId, worker, draggedData.stage);
                }
            });

            // 기사님 선택/해제. 선택 상태는 배정 후에도 유지되어 같은 기사님에게 연속 배정 가능
            card.addEventListener('click', () => {
                activeWorkerName = (activeWorkerName === worker) ? null : worker;
                renderBoardWorkers();
                renderBoardAssignments();
            });

            boardWorkerList.appendChild(card);
        });

        renderAssignmentWorkerFilter();
    }

    // 실시간 업무 배정표 제목 옆 기사님 필터 드롭다운 (기사님 카드 클릭과 상태 공유)
    function renderAssignmentWorkerFilter() {
        const select = document.getElementById('assignmentWorkerFilter');
        if (!select) return;
        const workers = currentDetailData.workers || [];

        select.innerHTML = `<option value="">전체보기</option>` +
            workers.map(w => `<option value="${w}">${w}</option>`).join('');
        select.value = activeWorkerName || "";
    }

    // 드롭다운에서 기사님을 선택하면 기사님 카드 선택 상태와 동기화하고 배정표를 필터링
    window.onAssignmentWorkerFilterChange = function() {
        const select = document.getElementById('assignmentWorkerFilter');
        activeWorkerName = select.value || null;
        renderBoardWorkers();
        renderBoardAssignments();
    };


    // 2열: 배정 완료 내역 그리기
    function renderBoardAssignments() {
        boardAssignmentList.innerHTML = "";
        const tasks = currentDetailData.tasks || [];
        
        // 기사명이 선택되면 실시간 업무 배정표를 자동으로 펼침
        const col = document.querySelector('.assignment-column');
        if (col && activeWorkerName) {
            col.classList.add('open');
        }

        // 1. 기사 필터 검사 (선택된 기사님이 있으면 그 기사님 배정 내역만 표시)
        const filterWorkerName = activeWorkerName;

        // 2. 임시 로컬 캐시를 이용한 순서 정렬 백업 (에어테이블 우선순위 적용 전 과도기 지원)
        const sortOrderKey = `task_sort_order_${activeProjectCode}`;
        const savedOrder = JSON.parse(localStorage.getItem(sortOrderKey) || "[]");
        // 서버에 아직 못 올린 순서가 있으면 그 순서로 보여준다 (저장 실패해도 화면이 되돌아가지 않게)
        const unsentOrder = readUnsentOrder(activeProjectCode);
        
        // 밑작업/시공을 완전히 독립된 카드로 나열 - 같은 품목이어도 각자의 우선순위 필드로 따로 정렬됨
        // (밑작업을 몰아서 하고 시공은 나중에 하는 경우가 많아서, 둘을 묶어서 같이 옮기지 않음)
        const cardEntries = [];
        tasks.forEach(task => {
            const fields = task.fields;

            if (fields.밑작업기사 && (!filterWorkerName || fields.밑작업기사 === filterWorkerName)) {
                const unsentP = unsentOrder[task.id + '|밑작업'];
                const priority = unsentP !== undefined ? unsentP : (fields.작업우선순위 !== undefined ? fields.작업우선순위 : (savedOrder.indexOf(task.id) !== -1 ? savedOrder.indexOf(task.id) : 999));
                cardEntries.push({ task, stage: '밑작업', assignee: fields.밑작업기사, isCompleted: !!fields.밑작업완료, priority });
            }

            if (fields.시공기사 && (!filterWorkerName || fields.시공기사 === filterWorkerName)) {
                const unsentP = unsentOrder[task.id + '|시공'];
                const priority = unsentP !== undefined ? unsentP : (fields.시공우선순위 !== undefined ? fields.시공우선순위 : (fields.작업우선순위 !== undefined ? fields.작업우선순위 : (savedOrder.indexOf(task.id) !== -1 ? savedOrder.indexOf(task.id) : 999)));
                const 뒷정리 = is뒷정리(fields.시공품목);
                const isCompleted = 뒷정리 ? 뒷정리완료(fields, fields.시공품목) : !!fields.시공완료;
                cardEntries.push({ task, stage: '시공', assignee: fields.시공기사, isCompleted, priority, 뒷정리 });
            }
        });

        cardEntries.sort((a, b) => a.priority - b.priority);
        // 현장정리 카드: '현장세팅' 처럼 하루 시작에 하는 일은 맨 앞, 나머지(현장마무리 등)는 하루 끝이라
        // 시공 카드들 아래로 모은다. 기사님 앱과 같은 규칙 (2026-10-08)
        const 정리자리 = (e) => !e.뒷정리 ? 1 : (/세팅/.test(e.task.fields.시공품목 || '') ? 0 : 2);
        cardEntries.sort((a, b) => 정리자리(a) - 정리자리(b));
        cardEntries.sort((a, b) => (a.isCompleted === b.isCompleted) ? 0 : (a.isCompleted ? 1 : -1));

        let count = 0;
        cardEntries.forEach(({ task, stage, assignee }) => {
            createAssignmentCard(task, stage, assignee);
            count++;
        });

        assignedCountBadge.textContent = `${count}개`;
        if (count > 0) scheduleOrderSync();
        if (count === 0) {
            boardAssignmentList.innerHTML = `<div class="drag-placeholder">우측의 품목 카드를 이곳이나 왼쪽 기사 카드 위로 드래그하여 배정하세요.</div>`;
        }
    }
    // 업무배정표 카드 / 품목배정 매트릭스 지침 모달 양쪽에서 공통으로 쓰는 지침 체크리스트+특이사항 본문 HTML.
    // "다른 카테고리 품목에 적용" 버튼과 특이사항 저장 버튼은 본인을 담고 있는 .assignment-card-body를
    // this.closest(...)로 직접 찾아서 넘기므로, 카드/모달 어느 쪽에 그려지든 동일하게 동작함.
    function buildGuidelineStageInnerHtml(task, stage) {
        const fields = task.fields;
        const recordId = task.id;
        const 뒷정리 = stage === '시공' && is뒷정리(fields.시공품목);
        const 매일 = 뒷정리 && is매일(fields.시공품목);

        const itemInfo = currentDetailData.items[fields.시공품목] || { 밑작업지침: "", 시공후점검지침: "" };
        const guidelinesText = stage === '밑작업' ? itemInfo.밑작업지침 : itemInfo.시공후점검지침;

        let bodyHtml = "";
        const excludedLines = (fields.제외된지침 || '').split('\n').map(s => s.trim()).filter(Boolean);
        const importantLines = (fields.중요지침 || '').split('\n').map(s => s.trim()).filter(Boolean);
        const siteNoteValue = fields.현장특이사항 || '';
        const siteNoteImportant = !!fields.특이사항중요;

        // 같은 카테고리(문+틀/샤시 등)의 다른 품목에 지침 체크 상태를 일괄 적용하는 버튼용 - 대상이 1개 이상 있을 때만 노출
        const masterItemInfo = (currentDetailData.masterItems || []).find(m => m.품목명 === fields.시공품목);
        const itemCategory = masterItemInfo ? masterItemInfo.카테고리 : '';
        // 인원배정 여부와 무관하게(밑작업만 배정되고 시공은 아직 미배정이어도) 같은 카테고리로 활성화된 품목이면 후보에 포함
        const bulkApplyCandidateCount = (!뒷정리 && itemCategory) ? (currentDetailData.tasks || []).filter(t => {
            if (t.id === recordId) return false;
            const tCat = ((currentDetailData.masterItems || []).find(m => m.품목명 === t.fields.시공품목) || {}).카테고리;
            return tCat === itemCategory;
        }).length : 0;
        const bulkApplyBtnHtml = bulkApplyCandidateCount > 0
            ? `<button type="button" class="bulk-apply-btn" onclick="event.stopPropagation(); openBulkApplyGuidelinesModal('${recordId}', '${stage}', this.closest('.assignment-card-body'))">📋 다른 ${itemCategory} 품목에 적용 (${bulkApplyCandidateCount})</button>`
            : '';

        if (guidelinesText) {
            // 체크박스로 포함/제외를 표시해야 하므로, 이미 제외된 줄도 목록에서 지우지 않고
            // 체크 해제된 상태로 그대로 보여줌 (예전 X버튼 방식은 제외되면 목록에서 사라졌음)
            const linesList = guidelinesText.split('\n').filter(l => l.trim() !== "");
            const existingResults = fields.점검결과 || "";

            bodyHtml += `
                <h4 style="font-size: 11px; margin-bottom: 8px; color: #666;">${뒷정리 ? '📋 할 일' : '💡 현장 품질 지침'} (오른쪽 체크 해제 시 이 현장에서만 제외 - 아래 저장 버튼 눌러야 반영됨)</h4>
                ${bulkApplyBtnHtml}
                <div class="assign-checkbox-list">
            `;

            const guidelineKind = stage === '밑작업' ? '밑작업지침' : '시공지침';
            linesList.forEach(line => {
                const cleanLine = line.trim();
                const isGuidelineActive = !existingResults || existingResults.includes(cleanLine);
                const isIncluded = !excludedLines.includes(cleanLine);
                const isImportant = importantLines.includes(cleanLine);
                const escapedLine = cleanLine.replace(/'/g, "\\'");
                const escapedLineAttr = cleanLine.replace(/"/g, '&quot;');
                const sampleUrl = getSamplePhotoUrl(currentDetailData.samplePhotos, guidelineKind, fields.시공품목, cleanLine);
                const sampleThumbHtml = sampleUrl ? `<img src="${sampleUrl}" class="sample-photo-thumb" title="샘플사진">` : '';

                bodyHtml += `
                    <div class="assign-toggle-item ${isGuidelineActive ? 'active' : ''}">
                        <span onclick="toggleGuidelineItem('${recordId}', '${stage}', '${escapedLine}', ${isGuidelineActive})" style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer;">
                            <span class="toggle-dot"></span>
                            <span class="toggle-text">${cleanLine}</span>
                        </span>
                        ${sampleThumbHtml}
                        <button type="button" class="guideline-star-btn${isImportant ? ' active' : ''}" data-line="${escapedLineAttr}" title="중요 표시 (기사님 화면에 빨간 글씨+반짝이는 별로 강조됨). 클릭 후 아래 저장 버튼을 눌러야 반영됨" onclick="event.stopPropagation(); this.classList.toggle('active');">⭐</button>
                        <input type="checkbox" class="guideline-include-input" data-line="${escapedLineAttr}" ${isIncluded ? 'checked' : ''} title="체크 해제 후 아래 저장 버튼을 누르면 이 현장에서만 이 지침 제외" onclick="event.stopPropagation();">
                    </div>
                `;
            });

            bodyHtml += `</div>`;
        }

        if (뒷정리) bodyHtml += 뒷정리기록Html(fields, 매일);

        bodyHtml += `
            <div class="site-note-box" style="margin-top: 14px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;">
                    <h4 style="font-size: 11px; color: #666; margin: 0;">📝 이 현장의 이 품목만의 특이사항 (작업자에게 체크 항목으로 노출됨)</h4>
                    <button type="button" class="guideline-star-btn site-note-star-btn${siteNoteImportant ? ' active' : ''}" title="중요 표시 (기사님 화면에 빨간 글씨+반짝이는 별로 강조됨). 클릭 후 아래 저장 버튼을 눌러야 반영됨" onclick="event.stopPropagation(); this.classList.toggle('active');">⭐</button>
                </div>
                <textarea class="site-note-textarea" rows="2" placeholder="예: 이 문틀은 이미 파손 이력 있음, 더 조심히 다뤄주세요" style="width: 100%; padding: 8px 10px; font-size: 13px; font-weight: 600; border: 1.5px solid var(--border-color); border-radius: 8px; resize: vertical; box-sizing: border-box;">${siteNoteValue}</textarea>
                <button type="button" onclick="saveSiteNote('${recordId}', '${stage}', this.closest('.assignment-card-body'))" style="margin-top: 6px; padding: 6px 14px; font-size: 12.5px; font-weight: 800; background: var(--primary-blue); color: white; border: none; border-radius: 8px; cursor: pointer;">지침/특이사항 저장</button>
            </div>
        `;

        return bodyHtml;
    }

    function createAssignmentCard(task, stage, assigneeName) {
        const fields = task.fields;
        const recordId = task.id;
        const 뒷정리 = stage === '시공' && is뒷정리(fields.시공품목);
        const 매일 = 뒷정리 && is매일(fields.시공품목);
        const isCompleted = 뒷정리 ? 뒷정리완료(fields, fields.시공품목) : !!(stage === '밑작업' ? fields.밑작업완료 : fields.시공완료);
        const stageLabel = 뒷정리 ? (매일 ? '🧹 현장정리·매일' : '🧹 현장정리') : stage;

        const card = document.createElement('div');
        card.className = `assignment-card${isCompleted ? ' completed' : ''} ${stage === '밑작업' ? 'stage-prep' : (뒷정리 ? 'stage-cleanup' : 'stage-construction')}`;
        card.dataset.recordId = recordId;
        card.dataset.stage = stage;

        // 상하 우선순위 정렬용 드래그앤드롭 이벤트 리스너 바인딩
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
        });

        // 1. 헤더 (배정 기사 이름, 작업이름, 완료 상태, 아코디언 ▼ 표시, 순서 이동 ▲▼, 배정 취소 x)
        // 특정 기사님으로 필터링된 상태면 카드마다 이름을 반복 표시할 필요가 없어 배지를 생략함
        const assigneeBadgeHtml = activeWorkerName ? '' : `<span class="assignee-badge">${assigneeName}</span>`;
        const statusText = 매일 ? (isCompleted ? '✅ 오늘 완료' : '오늘 아직') : (isCompleted ? '✅ 완료됨' : '진행중');
        const statusBadgeHtml = `<span class="assignment-status-badge${isCompleted ? ' completed' : ''}">${statusText}</span>`;
        let headerHtml = `
            <div class="assignment-card-header" onclick="toggleAssignmentCardBody(event, this)" style="cursor: pointer;">
                <div style="display: flex; align-items: center; gap: 6px; user-select: none;">
                    ${assigneeBadgeHtml}
                    <span class="assigned-item-name">${fields.시공품목} (${stageLabel})</span>
                    ${statusBadgeHtml}
                    <span class="toggle-arrow" style="font-size: 11px; color: #888;">▼</span>
                </div>
                <span class="drag-handle" title="여기를 잡고 위아래로 드래그해서 순서 이동">✋</span>
                <div style="display: flex; align-items: center; gap: 4px;">
                    <button class="btn-move-order" onclick="event.stopPropagation(); moveAssignmentCard('${recordId}', '${stage}', 'up')" title="위로 이동">▲</button>
                    <button class="btn-move-order" onclick="event.stopPropagation(); moveAssignmentCard('${recordId}', '${stage}', 'down')" title="아래로 이동">▼</button>
                    <button class="btn-unassign" onclick="event.stopPropagation(); unassignWorker('${recordId}', '${stage}')" title="배정 취소">×</button>
                </div>
            </div>
        `;

        // 2. 바디 (지침 목록 온오프 제어 - 기본적으로 숨김 처리 display: none;) - 모달과 공용인 buildGuidelineStageInnerHtml 재사용
        let bodyHtml = `<div class="assignment-card-body" style="display: none; padding-top: 10px;">`;
        bodyHtml += buildGuidelineStageInnerHtml(task, stage);
        bodyHtml += `</div>`;

        card.innerHTML = `${headerHtml}${bodyHtml}`;
        boardAssignmentList.appendChild(card);

        // 모바일 터치 드래그 (네이티브 HTML5 드래그앤드롭은 터치 기기에서 동작하지 않아 별도 구현)
        // ✋ 손잡이를 잡고 위아래로 밀면, 마우스 드래그와 동일한 방식으로 순서를 끼워넣음
        const dragHandle = card.querySelector('.drag-handle');
        let touchDragging = false;
        dragHandle.addEventListener('touchstart', () => {
            touchDragging = true;
            card.classList.add('dragging');
        }, { passive: true });

        dragHandle.addEventListener('touchmove', (e) => {
            if (!touchDragging) return;
            e.preventDefault();
            const touch = e.touches[0];
            const siblings = [...boardAssignmentList.querySelectorAll('.assignment-card:not(.dragging)')];
            const nextSibling = siblings.find(sibling => {
                const box = sibling.getBoundingClientRect();
                return touch.clientY <= box.top + box.height / 2;
            });
            boardAssignmentList.insertBefore(card, nextSibling);
        }, { passive: false });

        dragHandle.addEventListener('touchend', async () => {
            if (!touchDragging) return;
            touchDragging = false;
            card.classList.remove('dragging');
            await persistAssignmentOrder();
        });
    }

    // 뒷정리 카드 안의 완료 기록(누가 며칠에 했는지)과 올라온 사진
    function 뒷정리기록Html(fields, 매일) {
        const 기록 = 완료기록(fields);
        const 짧게 = (날짜) => { const m = 날짜.match(/^\d{4}-(\d{2})-(\d{2})$/); return m ? `${+m[1]}/${+m[2]}` : 날짜; };
        let 기록Html;
        if (매일) {
            기록Html = 기록.length
                ? 기록.slice(0, 14).map(r => `<span class="cleanup-record-chip${r.날짜 === 오늘날짜() ? ' today' : ''}">${짧게(r.날짜)} ${r.이름}</span>`).join('')
                : `<span class="cleanup-record-empty">아직 완료한 날이 없습니다.</span>`;
        } else {
            기록Html = fields.시공완료 ? `<span class="cleanup-record-chip today">완료됨</span>` : `<span class="cleanup-record-empty">아직 안 했습니다.</span>`;
        }
        const isValid = (p) => !!p && p.url && !p.url.includes('1x1.png') && !(p.filename && p.filename.includes('1x1.png'));
        const photos = (fields.시공후사진 || []).filter(isValid);
        const photosHtml = photos.length
            ? `<div class="cleanup-record-photos">${photos.slice(-12).map(p => `<a href="${p.url}" target="_blank" rel="noopener"><img src="${(p.thumbnails && p.thumbnails.small && p.thumbnails.small.url) || p.url}" alt="현장정리 사진" loading="lazy"></a>`).join('')}</div>`
            : '';
        return `
            <div class="cleanup-record">
                <h4>🧹 ${매일 ? '완료 기록 (최근순)' : '완료 여부'}</h4>
                <div class="cleanup-record-list">${기록Html}</div>
                ${photosHtml}
            </div>
        `;
    }

    // 아코디언 토글 제어 윈도우 글로벌 함수
    window.toggleAssignmentCardBody = function(event, element) {
        if (event.target.classList.contains('btn-unassign') || event.target.closest('.assign-toggle-item')) return;
        const card = element.closest('.assignment-card');
        const body = card.querySelector('.assignment-card-body');
        const arrow = card.querySelector('.toggle-arrow');
        if (body) {
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            arrow.textContent = isHidden ? '▲' : '▼';
        }
    };

    // 상하 정렬 드래그오버 시 순서 끼워넣기 리스너 추가
    boardAssignmentList.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingCard = document.querySelector('.assignment-card.dragging');
        if (!draggingCard) return;
        
        const siblings = [...boardAssignmentList.querySelectorAll('.assignment-card:not(.dragging)')];
        const nextSibling = siblings.find(sibling => {
            const box = sibling.getBoundingClientRect();
            return e.clientY <= box.top + box.height / 2;
        });
        
        boardAssignmentList.insertBefore(draggingCard, nextSibling);
    });

    // 현재 배정표 DOM 순서를 로컬스토리지 + 서버(우선순위 필드)에 저장
    // 밑작업/시공은 서로 독립된 카드라 각자 우선순위(작업우선순위/시공우선순위)를 가짐.
    //
    // (2026-10-08) 예전에는 서버 저장이 실패해도 화면 데이터에 '저장됨' 으로 먼저 적어버려서,
    // 다음 번에 바뀐 것만 보낼 때 실패했던 카드들이 영영 안 올라갔다 - 관리자 화면(이 폰의
    // 로컬 순서)은 맞는데 기사님 화면(서버 값)은 순서가 안 바뀌는 원인이었다.
    // 이제 서버가 받은 뒤에만 '저장됨' 으로 적고, 못 보낸 것은 폰에 모아뒀다가 다음에 같이 보낸다.
    const UNSENT_ORDER_PREFIX = 'task_order_unsent_';
    function readUnsentOrder(projectCode) {
        try { return JSON.parse(localStorage.getItem(UNSENT_ORDER_PREFIX + projectCode) || '{}') || {}; }
        catch (e) { return {}; }
    }
    function writeUnsentOrder(projectCode, map) {
        try {
            if (Object.keys(map).length) localStorage.setItem(UNSENT_ORDER_PREFIX + projectCode, JSON.stringify(map));
            else localStorage.removeItem(UNSENT_ORDER_PREFIX + projectCode);
        } catch (e) { /* 저장 공간 문제는 무시 - 다음 순서 변경 때 다시 보낸다 */ }
    }

    let orderSaving = false;
    async function persistAssignmentOrder(options = {}) {
        const { silent = false } = options;
        // 1. 배정표 내 카드 순서를 DOM 그대로 수집
        const cards = [...boardAssignmentList.querySelectorAll('.assignment-card')];
        const allEntries = cards.map((c, idx) => ({ id: c.dataset.recordId, stage: c.dataset.stage, priority: idx + 1 }));
        const projectCode = activeProjectCode;

        // 2. 서버 값과 다른 카드 + 지난번에 못 보낸 카드를 보낸다
        const unsent = readUnsentOrder(projectCode);
        const reorderTasks = allEntries.filter(({ id, stage, priority }) => {
            if (unsent[id + '|' + stage] !== undefined) return true;
            const task = currentDetailData.tasks.find(t => t.id === id);
            if (!task) return true;
            const currentVal = stage === '밑작업' ? task.fields.작업우선순위 : task.fields.시공우선순위;
            return currentVal !== priority;
        });

        // 3. 이 폰의 순서 캐시 (화면을 바로 그 순서로 보여주는 데 쓴다)
        const sortOrderKey = `task_sort_order_${projectCode}`;
        localStorage.setItem(sortOrderKey, JSON.stringify(allEntries.map(e => e.id)));

        if (reorderTasks.length === 0) {
            if (!silent) renderBoardAssignments();
            return true;
        }

        // 보내기 전에 '못 보낸 것' 으로 먼저 적어둔다 - 앱이 꺼지거나 통신이 끊겨도 다음에 다시 보낸다
        reorderTasks.forEach(({ id, stage, priority }) => { unsent[id + '|' + stage] = priority; });
        writeUnsentOrder(projectCode, unsent);

        if (!silent) showLoading("우선순위 순서 저장 중...");
        orderSaving = true;
        let ok = false;
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'reorder_tasks',
                    tasks: reorderTasks
                })
            });
            if (!response.ok) throw new Error("우선순위 순서 저장 실패");
            ok = true;
            // 서버가 받은 것만 '저장됨' 으로 적고, 못 보낸 목록에서 뺀다
            reorderTasks.forEach(({ id, stage, priority }) => {
                const task = currentDetailData.tasks.find(t => t.id === id);
                if (task) {
                    if (stage === '밑작업') task.fields.작업우선순위 = priority;
                    else task.fields.시공우선순위 = priority;
                }
            });
            const left = readUnsentOrder(projectCode);
            reorderTasks.forEach(({ id, stage, priority }) => {
                if (left[id + '|' + stage] === priority) delete left[id + '|' + stage];
            });
            writeUnsentOrder(projectCode, left);
            if (!silent) showToast("작업 우선순위 순서가 정상 저장되었습니다.");
        } catch (error) {
            console.warn(error);
            if (!silent) showToast("서버 저장에 실패했습니다. 이 폰에만 반영됐고, 다음에 화면을 열 때 다시 보냅니다.", "danger");
        } finally {
            orderSaving = false;
            if (!silent) hideLoading();
            if (activeProjectCode === projectCode) renderBoardAssignments();
        }
        return ok;
    }

    // 배정표를 그린 뒤, 이 폰에서 정한 순서가 서버에 다 안 올라가 있으면 조용히 올린다.
    // - 지난번에 못 보낸 순서가 남아 있을 때
    // - 이 폰의 순서 캐시에는 있는데 서버 우선순위가 비어 있는 카드가 있을 때
    //   (예전 버그로 서버에 안 올라간 순서 - 관리자 화면과 기사님 화면 순서가 달랐다)
    let orderSyncTimer = null;
    let orderSyncFailedAt = 0;   // 조용히 보내다 실패하면 1분은 다시 안 보낸다 (통신 끊긴 곳에서 계속 두드리지 않게)
    function scheduleOrderSync() {
        if (orderSaving || !activeProjectCode || !currentDetailData) return;
        if (Date.now() - orderSyncFailedAt < 60000) return;
        const projectCode = activeProjectCode;
        const unsent = readUnsentOrder(projectCode);
        const savedOrder = JSON.parse(localStorage.getItem(`task_sort_order_${projectCode}`) || "[]");
        const cards = [...boardAssignmentList.querySelectorAll('.assignment-card')];
        const needs = cards.some(c => {
            const id = c.dataset.recordId, stage = c.dataset.stage;
            if (unsent[id + '|' + stage] !== undefined) return true;
            const task = (currentDetailData.tasks || []).find(t => t.id === id);
            if (!task) return false;
            const val = stage === '밑작업' ? task.fields.작업우선순위 : task.fields.시공우선순위;
            return (val === undefined || val === null) && savedOrder.indexOf(id) !== -1;
        });
        if (!needs) return;
        clearTimeout(orderSyncTimer);
        orderSyncTimer = setTimeout(() => {
            if (activeProjectCode !== projectCode) return;
            persistAssignmentOrder({ silent: true }).then(ok => { if (!ok) orderSyncFailedAt = Date.now(); });
        }, 800);
    }

    // 순서 빠르게 정하기 모달 - 드래그가 번거로운 모바일에서, 원하는 순서대로 항목을 탭하면
    // 1,2,3...으로 번호가 매겨지고, 저장 시 그 순서대로 카드가 재배치됨 (탭 안 한 나머지는 기존 순서 유지)
    let orderPickSequence = [];

    window.openOrderPickModal = function() {
        orderPickSequence = [];
        renderOrderPickList();
        document.getElementById('orderPickModal').style.display = 'flex';
    };

    window.closeOrderPickModal = function() {
        document.getElementById('orderPickModal').style.display = 'none';
    };

    // 완료된 업무는 순서를 정할 필요가 없으니 목록에서 뺀다. 현장정리는 매일 하는 일이라 완료돼도 남긴다
    function orderPickCards() {
        return [...boardAssignmentList.querySelectorAll('.assignment-card')]
            .filter(c => !c.classList.contains('completed') || c.classList.contains('stage-cleanup'));
    }

    function renderOrderPickList() {
        const container = document.getElementById('orderPickBody');
        const statusEl = document.getElementById('orderPickStatus');
        const cards = orderPickCards();

        if (cards.length === 0) {
            container.innerHTML = `<div class="empty-state">배정된 작업이 없습니다.</div>`;
            statusEl.textContent = '';
            return;
        }

        container.innerHTML = cards.map(card => {
            const key = `${card.dataset.recordId}__${card.dataset.stage}`;
            const nameEl = card.querySelector('.assigned-item-name');
            const name = nameEl ? nameEl.textContent : '(이름없음)';
            const pickIdx = orderPickSequence.indexOf(key);
            const picked = pickIdx !== -1;
            return `
                <div class="order-pick-item${picked ? ' picked' : ''}" onclick="toggleOrderPick('${key}')">
                    <span class="order-pick-badge">${picked ? (pickIdx + 1) : ''}</span>
                    <span class="order-pick-name">${name}</span>
                </div>
            `;
        }).join('');

        statusEl.textContent = `${orderPickSequence.length} / ${cards.length}개 지정됨`;
    }

    window.toggleOrderPick = function(key) {
        const idx = orderPickSequence.indexOf(key);
        if (idx !== -1) {
            // 이미 찍은 항목을 다시 탭하면 그 항목만 순서 지정 취소 (뒷 번호들이 자동으로 하나씩 당겨짐)
            orderPickSequence.splice(idx, 1);
        } else {
            orderPickSequence.push(key);
        }
        renderOrderPickList();
    };

    window.resetOrderPick = function() {
        orderPickSequence = [];
        renderOrderPickList();
    };

    window.applyOrderPick = async function() {
        const cards = [...boardAssignmentList.querySelectorAll('.assignment-card')];
        const cardsByKey = new Map(cards.map(c => [`${c.dataset.recordId}__${c.dataset.stage}`, c]));

        // 탭한 순서대로 먼저 배치하고, 탭 안 한 나머지는 기존 화면 순서 그대로 뒤에 이어붙임
        // (목록에 안 나온 완료 업무는 맨 뒤)
        const orderedKeys = [...orderPickSequence];
        const shown = new Set(orderPickCards());
        [...cards.filter(c => shown.has(c)), ...cards.filter(c => !shown.has(c))].forEach(c => {
            const key = `${c.dataset.recordId}__${c.dataset.stage}`;
            if (!orderedKeys.includes(key)) orderedKeys.push(key);
        });

        orderedKeys.forEach(key => {
            const card = cardsByKey.get(key);
            if (card) boardAssignmentList.appendChild(card);
        });

        closeOrderPickModal();
        await persistAssignmentOrder();
    };

    // 드롭 정착 시 최종 순서 갱신 및 서버/로컬스토리지 저장
    boardAssignmentList.addEventListener('drop', async (e) => {
        e.preventDefault();
        const draggingCard = document.querySelector('.assignment-card.dragging');
        if (!draggingCard) return; // 미배정 카드 드롭 등은 건너뜀
        await persistAssignmentOrder();
    });

    // ▲▼ 버튼으로 바로 위/아래 카드와 순서 교체
    // 밑작업/시공은 완전히 독립적으로 움직임 (같은 품목이어도 서로 묶이지 않음)
    window.moveAssignmentCard = async function(recordId, stage, direction) {
        const myCard = boardAssignmentList.querySelector(`.assignment-card[data-record-id="${recordId}"][data-stage="${stage}"]`);
        if (!myCard) return;

        if (direction === 'up') {
            const prev = myCard.previousElementSibling;
            if (!prev) return;
            boardAssignmentList.insertBefore(myCard, prev);
        } else {
            const next = myCard.nextElementSibling;
            if (!next) return;
            boardAssignmentList.insertBefore(next, myCard);
        }

        await persistAssignmentOrder();
    };

    // 기사 배정 실행
    // 배정 요청 1건만 서버로 전송 (로딩/토스트/새로고침은 호출부에서 관리 - 단건/일괄 배정 공용)
    async function postAssignWorker(recordId, workerName, stage) {
        const response = await fetchWithTimeout(API_SAVE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'assign_worker',
                projectCode: activeProjectCode,
                recordId: recordId,
                workerName: workerName,
                stage: stage
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText || "배정 오류");
        }
    }

    // 드래그 앤 드롭으로 즉시 1건 배정 (기사님 선택 상태는 그대로 유지되어 연속 배정 가능)
    async function assignWorker(recordId, workerName, stage) {
        showLoading(`${workerName} 기사님 배정 중...`);
        try {
            await postAssignWorker(recordId, workerName, stage);
            showToast("업무 배정이 정상적으로 저장되었습니다.");
            // 캐시 데이터 리로드 및 갱신
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast(`기사 배정 실패: ${error.message}`, "danger");
        } finally {
            hideLoading();
        }
    }

    // 배정 취소 실행
    window.unassignWorker = async function(recordId, stage) {
        if (!confirm("업무 배정을 취소하고 품목 풀로 되돌리시겠습니까?")) return;

        showLoading("배정 취소 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'unassign_worker',
                    projectCode: activeProjectCode,
                    recordId: recordId,
                    stage: stage
                })
            });

            if (!response.ok) throw new Error("취소 실패");
            
            showToast("배정이 취소되었습니다.");
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("배정 취소 처리를 완료하지 못했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 개별 지침 온/오프 토글 저장
    window.toggleGuidelineItem = async function(recordId, stage, guidelineLine, currentActive) {
        // 기존 텍스트 저장 형태를 유지하기 위해,
        // 현재 켜져있는 지침과 꺼지는 지침 정보를 취합해서 점검결과 텍스트로 밀어넣어줌
        showLoading("지침 가이드 갱신 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'toggle_guideline',
                    projectCode: activeProjectCode,
                    recordId: recordId,
                    stage: stage,
                    guideline: guidelineLine,
                    active: !currentActive // 클릭했으므로 반대 상태 전송
                })
            });

            if (!response.ok) throw new Error("지침 업데이트 실패");
            
            showToast("품질 점검지침 가이드가 변경되었습니다.");
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("가이드 변경 저장에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 지침 체크박스(포함/제외) + 특이사항 텍스트를 한 번에 일괄 저장 - 체크박스 클릭마다 서버로 안 보내고
    // 이 버튼을 눌렀을 때만 통신해서 지침이 여러 개여도 지연 없이 빠르게 체크할 수 있게 함
    window.saveSiteNote = async function(recordId, stage, containerEl) {
        const cardBody = containerEl || document.querySelector(`.assignment-card[data-record-id="${recordId}"][data-stage="${stage}"] .assignment-card-body`);
        const textarea = cardBody ? cardBody.querySelector('.site-note-textarea') : null;
        const noteText = textarea ? textarea.value.trim() : "";
        const noteStarBtn = cardBody ? cardBody.querySelector('.site-note-star-btn') : null;
        const noteImportant = noteStarBtn ? noteStarBtn.classList.contains('active') : false;
        const excludedLines = [];
        const importantLines = [];
        if (cardBody) {
            cardBody.querySelectorAll('.guideline-include-input').forEach(input => {
                if (!input.checked) excludedLines.push(input.dataset.line);
            });
            // .site-note-star-btn도 시각적 재사용을 위해 guideline-star-btn 클래스를 같이 쓰지만
            // data-line이 없는 별개 토글(noteImportant)이므로 여기서는 제외
            cardBody.querySelectorAll('.guideline-star-btn.active:not(.site-note-star-btn)').forEach(btn => {
                importantLines.push(btn.dataset.line);
            });
        }
        const excludedText = excludedLines.join('\n');
        const importantText = importantLines.join('\n');

        showLoading("저장 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_site_note',
                    projectCode: activeProjectCode,
                    recordId: recordId,
                    noteText: noteText,
                    excludedText: excludedText,
                    importantText: importantText,
                    noteImportant: noteImportant
                })
            });

            if (!response.ok) throw new Error("저장 실패");

            showToast("저장되었습니다.");
            await showProjectDetail(activeProjectCode);
            if (containerEl) {
                window.closeItemGuidelineModal(); // 모달에서 저장한 경우: 새로고침으로 내용이 낡아지므로 닫아줌
            } else {
                reopenAssignmentCard(recordId, stage); // 카드에서 저장한 경우: 새로고침으로 접혀버리지 않고 보던 카드 그대로 열어둠
            }
        } catch (error) {
            console.error(error);
            showToast("저장에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // showProjectDetail()이 전체를 새로 그리면서 카드가 다시 접히므로, 저장 직후 방금 보던 카드를 다시 펼쳐줌
    function reopenAssignmentCard(recordId, stage) {
        const card = document.querySelector(`.assignment-card[data-record-id="${recordId}"][data-stage="${stage}"]`);
        if (!card) return;
        const body = card.querySelector('.assignment-card-body');
        const arrow = card.querySelector('.toggle-arrow');
        if (body) body.style.display = 'block';
        if (arrow) arrow.textContent = '▲';
    }

    // ===== 지침 체크 상태 일괄 적용 (같은 카테고리 품목들에게 한번에 복사) =====
    // 예: "방2문+틀" 밑작업 카드에서 지침 몇 개를 체크 해제한 뒤, 이 버튼으로 같은 "문+틀" 카테고리의
    // 방1문+틀/방3문+틀/... 등 다른 품목에도 그대로 적용 - 하나씩 들어가서 반복 체크할 필요 없게 함.
    let bulkApplySourceState = null; // { recordId, stage, excludedText, importantText }

    window.openBulkApplyGuidelinesModal = function(recordId, stage, sourceEl) {
        const task = currentDetailData.tasks.find(t => t.id === recordId);
        if (!task) return;
        const fields = task.fields;
        const masterItemInfo = (currentDetailData.masterItems || []).find(m => m.품목명 === fields.시공품목);
        const itemCategory = masterItemInfo ? masterItemInfo.카테고리 : '';

        // 지금 화면에 보이는(저장 전일 수도 있는) 체크 상태를 그대로 읽어서 소스로 삼음 (카드에서 열렸으면 DOM에서 찾고, 모달에서 열렸으면 sourceEl로 바로 받음)
        const cardBody = sourceEl || (() => {
            const card = document.querySelector(`.assignment-card[data-record-id="${recordId}"][data-stage="${stage}"]`);
            return card ? card.querySelector('.assignment-card-body') : null;
        })();
        const excludedLines = [];
        const importantLines = [];
        let noteText = fields.현장특이사항 || '';
        let noteImportant = !!fields.특이사항중요;
        if (cardBody) {
            cardBody.querySelectorAll('.guideline-include-input').forEach(input => {
                if (!input.checked) excludedLines.push(input.dataset.line);
            });
            // .site-note-star-btn도 시각적 재사용을 위해 guideline-star-btn 클래스를 같이 쓰지만
            // data-line이 없는 별개 토글(특이사항 중요표시)이므로 여기서는 제외
            cardBody.querySelectorAll('.guideline-star-btn.active:not(.site-note-star-btn)').forEach(btn => {
                importantLines.push(btn.dataset.line);
            });
            const noteTextarea = cardBody.querySelector('.site-note-textarea');
            if (noteTextarea) noteText = noteTextarea.value.trim();
            const noteStarBtn = cardBody.querySelector('.site-note-star-btn');
            if (noteStarBtn) noteImportant = noteStarBtn.classList.contains('active');
        }

        // 인원배정 여부와 무관하게(밑작업만 배정되고 시공은 아직 미배정이어도) 같은 카테고리로 활성화된 품목이면 후보에 포함
        const candidates = (currentDetailData.tasks || []).filter(t => {
            if (t.id === recordId) return false;
            const tCat = ((currentDetailData.masterItems || []).find(m => m.품목명 === t.fields.시공품목) || {}).카테고리;
            return tCat === itemCategory;
        });

        // 지침 체크 상태뿐 아니라 특이사항 텍스트/중요표시도 같이 넘겨서 다른 품목에 그대로 적용할 수 있게 함
        bulkApplySourceState = {
            recordId, stage,
            excludedText: excludedLines.join('\n'),
            importantText: importantLines.join('\n'),
            noteText, noteImportant
        };

        document.getElementById('bulkApplyModalTitle').textContent = `📋 "${fields.시공품목}" (${stage}) 지침을 다른 ${itemCategory} 품목에 적용`;

        const listEl = document.getElementById('bulkApplyItemList');
        if (candidates.length === 0) {
            listEl.innerHTML = `<div class="empty-state" style="padding:12px 0;">같은 카테고리(${itemCategory})의 다른 품목이 이 현장에 없습니다.</div>`;
        } else {
            listEl.innerHTML = candidates.map(t => `
                <label class="bulk-apply-item-row">
                    <input type="checkbox" class="bulk-apply-target-check" value="${t.id}">
                    <span>${t.fields.시공품목}</span>
                </label>
            `).join('');
        }

        document.getElementById('bulkApplyModal').style.display = 'flex';
    };

    window.toggleBulkApplyAll = function(checked) {
        document.querySelectorAll('.bulk-apply-target-check').forEach(cb => { cb.checked = checked; });
    };

    window.closeBulkApplyModal = function() {
        document.getElementById('bulkApplyModal').style.display = 'none';
        bulkApplySourceState = null;
    };

    window.confirmBulkApplyGuidelines = async function() {
        if (!bulkApplySourceState) return;
        const targetIds = [...document.querySelectorAll('.bulk-apply-target-check:checked')].map(cb => cb.value);
        if (targetIds.length === 0) {
            showToast('적용할 품목을 선택해 주세요.', 'danger');
            return;
        }
        const { recordId, stage, excludedText, importantText, noteText, noteImportant } = bulkApplySourceState;

        showLoading(`적용 중... (0/${targetIds.length})`);
        let done = 0;
        for (const targetId of targetIds) {
            try {
                const response = await fetchWithTimeout(API_SAVE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'update_site_note',
                        projectCode: activeProjectCode,
                        recordId: targetId,
                        noteText,
                        excludedText,
                        importantText,
                        noteImportant
                    })
                });
                if (!response.ok) throw new Error('실패');
            } catch (e) {
                console.error(e);
            }
            done++;
            showLoading(`적용 중... (${done}/${targetIds.length})`);
        }
        hideLoading();

        window.closeBulkApplyModal();
        showToast(`${done}개 품목에 지침을 적용했습니다.`);
        await showProjectDetail(activeProjectCode);
        const itemGuidelineModalOpen = document.getElementById('itemGuidelineModal').style.display === 'flex';
        if (itemGuidelineModalOpen) {
            window.closeItemGuidelineModal(); // 모달에서 시작한 일괄적용이면 내용이 낡아지므로 닫아줌
        } else {
            reopenAssignmentCard(recordId, stage);
        }
    };

    // 9. 블로그 발행 모달 (일차별 탭 UI)
    function createEmptyDayDraft(dayNumber) {
        const projectName = (currentDetailData && currentDetailData.project && currentDetailData.project.현장명) || "";
        return {
            dayNumber,
            journalId: null,
            published: false,
            title: `${projectName} ${dayNumber}일차`.trim(),
            weather: "",
            feature: "",
            episode: "",
            sceneSaved: [],      // {url, filename} - 이미 저장된 사진 (읽기 전용 표시)
            cleanupSaved: [],
            filmSaved: [],
            scenePending: [],    // File[] - 아직 업로드 안 된, 발행 시 업로드될 사진 (삭제 가능)
            cleanupPending: [],
            filmPending: []
        };
    }

    window.requestBlogPublish = async function() {
        // 발행 화면을 열 때마다 최신 완료 현황을 먼저 새로 불러옴 (새로고침을 깜빡해도 최신 상태 보장)
        await showProjectDetail(activeProjectCode);

        const tasks = currentDetailData.tasks || [];

        // 밑작업 + 시공이 모두 완료된 항목만 표시
        eligibleTasksCache = tasks.filter(t => t.fields.밑작업완료 && t.fields.시공완료);

        dayDrafts = [1, 2, 3, 4, 5].map(createEmptyDayDraft);
        taskAssignment = {};
        taskOrder = {};
        activeDayIndex = 0;

        // 기존에 저장된 (아직 발행 전이거나 이미 발행된) 일지가 있으면 해당 일차 슬롯에 병합
        try {
            const res = await fetchWithTimeout(`${API_JOURNAL_LIST_URL}?projectCode=${encodeURIComponent(activeProjectCode)}`);
            const data = await res.json();
            (Array.isArray(data) ? data : []).forEach(rec => {
                const f = rec.fields ? rec.fields : rec;
                const dayNum = f.일차;
                if (!dayNum) return;
                while (dayDrafts.length < dayNum) {
                    dayDrafts.push(createEmptyDayDraft(dayDrafts.length + 1));
                }
                const idx = dayNum - 1;
                dayDrafts[idx] = {
                    ...dayDrafts[idx],
                    journalId: rec.id,
                    title: f.일지제목 || dayDrafts[idx].title,
                    weather: f.오늘의날씨 || "",
                    feature: f.현장의특징 || "",
                    episode: f.오늘의에피소드 || "",
                    published: !!f.발행완료,
                    sceneSaved: (f.현장사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ id: a.id, url: a.url, filename: a.filename })),
                    cleanupSaved: (f.정리정돈사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ id: a.id, url: a.url, filename: a.filename })),
                    filmSaved: (f.필름사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ id: a.id, url: a.url, filename: a.filename }))
                };

                // 저장된 순서(포함작업목록)를 복원해서, 창을 닫았다 다시 열어도(다른 일차 작업 중에도)
                // "이미 다른 일차에 배정/발행됨" 표시와 글 순서가 그대로 유지되게 함
                (f.포함작업목록 || '').split(',').map(s => s.trim()).filter(Boolean).forEach((taskId, i) => {
                    taskAssignment[taskId] = dayNum;
                    taskOrder[taskId] = i + 1;
                });
            });
        } catch (e) {
            console.error(e);
        }

        renderJournalTabs();
        loadDayDraftIntoForm();
        renderTaskChecklist();

        publishModal.style.display = 'flex';
    };

    window.closePublishModal = function() {
        publishModal.style.display = 'none';
    };

    function renderJournalTabs() {
        journalTabs.innerHTML = "";
        dayDrafts.forEach((draft, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = `${draft.dayNumber}일차` + (draft.published ? ' ✓' : '');
            btn.style.cssText = `padding:6px 14px; font-size:13px; font-weight:800; border-radius:20px; cursor:pointer; border:1.5px solid var(--border-color); background:${idx === activeDayIndex ? 'var(--primary-blue)' : '#fff'}; color:${idx === activeDayIndex ? '#fff' : 'var(--text-main)'}; opacity:${draft.published ? '0.6' : '1'};`;
            btn.onclick = () => switchDayTab(idx);
            journalTabs.appendChild(btn);
        });
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.textContent = '+ 일차 추가';
        addBtn.style.cssText = 'padding:6px 14px; font-size:13px; font-weight:800; border-radius:20px; cursor:pointer; border:1.5px dashed var(--border-color); background:#fff; color:#94a3b8;';
        addBtn.onclick = () => {
            dayDrafts.push(createEmptyDayDraft(dayDrafts.length + 1));
            switchDayTab(dayDrafts.length - 1);
        };
        journalTabs.appendChild(addBtn);
    }

    function saveFormIntoCurrentDraft() {
        const d = dayDrafts[activeDayIndex];
        if (!d) return;
        d.title = document.getElementById('journalTitleInput').value;
        d.weather = document.getElementById('journalWeatherInput').value;
        d.feature = document.getElementById('journalFeatureInput').value;
        d.episode = document.getElementById('journalEpisodeInput').value;
    }

    // 현장일지 사진 타일 그리드 렌더링
    // 1) 이미 저장된 사진(삭제 가능, 서버 반영) 2) 아직 업로드 안 된 사진(삭제 가능, 로컬만) 3) "사진 추가" 타일
    function renderJournalPhotoGrid(gridId, kind) {
        const d = dayDrafts[activeDayIndex];
        const savedKey = { scene: 'sceneSaved', cleanup: 'cleanupSaved', film: 'filmSaved' }[kind];
        const pendingKey = { scene: 'scenePending', cleanup: 'cleanupPending', film: 'filmPending' }[kind];
        const saved = d[savedKey];
        const pending = d[pendingKey];
        const grid = document.getElementById(gridId);
        grid.innerHTML = "";

        saved.forEach((photo, idx) => {
            const tile = document.createElement('div');
            tile.className = 'journal-photo-tile has-image';
            tile.innerHTML = `<img src="${photo.url}" class="journal-photo-preview" alt="사진">`;
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'journal-photo-delete';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteSavedJournalPhoto(kind, gridId, idx);
            });
            tile.appendChild(delBtn);
            grid.appendChild(tile);
        });

        pending.forEach((file, idx) => {
            const tile = document.createElement('div');
            tile.className = 'journal-photo-tile has-image';
            const url = URL.createObjectURL(file);
            tile.innerHTML = `<img src="${url}" class="journal-photo-preview" alt="사진">`;
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'journal-photo-delete';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                pending.splice(idx, 1);
                renderJournalPhotoGrid(gridId, kind);
            });
            tile.appendChild(delBtn);
            grid.appendChild(tile);
        });

        const addTile = document.createElement('div');
        addTile.className = 'journal-photo-tile add-tile';
        addTile.innerHTML = `<div class="journal-photo-icon">📷</div><div class="journal-photo-label">사진 추가</div>`;
        addTile.addEventListener('click', () => triggerJournalPhotoPick(kind, gridId));
        grid.appendChild(addTile);
    }

    // 이미 서버(Airtable)에 저장된 현장일지 사진 삭제 - 낙관적으로 먼저 화면에서 지우고,
    // 실패하면 원래대로 복구 + 에러 토스트 (샘플사진 삭제와 동일한 UX 패턴)
    async function deleteSavedJournalPhoto(kind, gridId, idx) {
        if (!confirm('이 사진을 삭제할까요?')) return;
        const d = dayDrafts[activeDayIndex];
        const savedKey = { scene: 'sceneSaved', cleanup: 'cleanupSaved', film: 'filmSaved' }[kind];
        const fieldName = { scene: '현장사진', cleanup: '정리정돈사진', film: '필름사진' }[kind];
        const saved = d[savedKey];
        const removed = saved[idx];
        if (!d.journalId || !removed) return;

        // 남길 사진 중 하나라도 id가 없으면(예전 세션 데이터 등) 그대로 keepAttachmentIds에 넣으면
        // 서버에서 그 사진까지 함께 지워질 수 있어 - 안전하게 새로고침을 유도하고 중단
        const remainingAfterDelete = saved.filter((_, i) => i !== idx);
        if (remainingAfterDelete.some(p => !p.id)) {
            showToast('사진 정보를 다시 불러온 뒤 삭제해 주세요 (새로고침 필요).', 'danger');
            return;
        }

        const backup = saved.slice();
        saved.splice(idx, 1);
        renderJournalPhotoGrid(gridId, kind);

        showLoading('사진 삭제 중...');
        try {
            const res = await fetchWithTimeout(API_JOURNAL_PHOTO_DELETE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    journalId: d.journalId,
                    fieldName: fieldName,
                    keepAttachmentIds: saved.map(p => p.id)
                })
            });
            if (!res.ok) throw new Error("사진 삭제 실패");
            showToast('사진이 삭제되었습니다.');
        } catch (error) {
            console.error(error);
            d[savedKey] = backup;
            renderJournalPhotoGrid(gridId, kind);
            showToast('사진 삭제에 실패했습니다.', 'danger');
        } finally {
            hideLoading();
        }
    }

    function triggerJournalPhotoPick(kind, gridId) {
        showPhotoSourceSheet((useCamera) => {
            openJournalFileInput(kind, gridId, useCamera);
        });
    }

    // 촬영/앨범 선택 하단 시트 - 기기/안드로이드 버전에 따라 파일 선택창이 카메라 옵션 없이
    // 곧장 사진첩만 뜨는 경우가 있어, 항상 선택지를 명시적으로 보여줘서 모든 기기에서 촬영 가능하게 함
    function showPhotoSourceSheet(onChoice) {
        const old = document.getElementById('journalPhotoSourceSheetOverlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'journalPhotoSourceSheetOverlay';
        overlay.className = 'photo-source-sheet-overlay';
        overlay.innerHTML = `
            <div class="photo-source-sheet">
                <button type="button" class="photo-source-btn" data-source="camera">📷 사진 촬영</button>
                <button type="button" class="photo-source-btn" data-source="gallery">🖼️ 앨범에서 선택</button>
                <button type="button" class="photo-source-btn photo-source-cancel" data-source="cancel">취소</button>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                return;
            }
            const btn = e.target.closest('.photo-source-btn');
            if (!btn) return;
            const source = btn.dataset.source;
            overlay.remove();
            if (source === 'camera') onChoice(true);
            else if (source === 'gallery') onChoice(false);
        });

        document.body.appendChild(overlay);
    }

    function openJournalFileInput(kind, gridId, useCamera) {
        const oldInput = document.getElementById('tempJournalFileInput');
        if (oldInput) oldInput.remove();

        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'tempJournalFileInput';
        input.accept = 'image/*';
        if (useCamera) input.capture = 'environment';
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            const picked = Array.from(e.target.files);
            const d = dayDrafts[activeDayIndex];
            if (!d || picked.length === 0) { input.remove(); return; }
            const pendingKey = { scene: 'scenePending', cleanup: 'cleanupPending', film: 'filmPending' }[kind];
            d[pendingKey] = d[pendingKey].concat(picked);
            renderJournalPhotoGrid(gridId, kind);
            input.remove();
        });

        document.body.appendChild(input);
        input.click();
    }

    function loadDayDraftIntoForm() {
        const d = dayDrafts[activeDayIndex];
        document.getElementById('journalTitleInput').value = d.title;
        document.getElementById('journalWeatherInput').value = d.weather;
        document.getElementById('journalFeatureInput').value = d.feature;
        document.getElementById('journalEpisodeInput').value = d.episode;
        renderJournalPhotoGrid('journalFilmPhotoGrid', 'film');
        renderJournalPhotoGrid('journalScenePhotoGrid', 'scene');
        renderJournalPhotoGrid('journalCleanupPhotoGrid', 'cleanup');
    }

    function switchDayTab(idx) {
        saveFormIntoCurrentDraft();
        activeDayIndex = idx;
        renderJournalTabs();
        loadDayDraftIntoForm();
        renderTaskChecklist();
    }

    // 같은 일차 안에서 taskOrder 값을 1부터 연속되게 다시 매김 (삭제로 생긴 빈 번호 정리)
    function renumberDayOrder(dayNum) {
        const ids = Object.keys(taskAssignment)
            .filter(id => taskAssignment[id] === dayNum)
            .sort((a, b) => (taskOrder[a] || 0) - (taskOrder[b] || 0));
        ids.forEach((id, i) => { taskOrder[id] = i + 1; });
    }

    // 순서 목록에서 위/아래 버튼으로 인접한 항목과 순서를 맞바꿈
    function moveTaskOrder(taskId, dir, dayNum) {
        const ids = Object.keys(taskAssignment)
            .filter(id => taskAssignment[id] === dayNum)
            .sort((a, b) => (taskOrder[a] || 0) - (taskOrder[b] || 0));
        const idx = ids.indexOf(taskId);
        const swapIdx = idx + dir;
        if (idx === -1 || swapIdx < 0 || swapIdx >= ids.length) return;
        const otherId = ids[swapIdx];
        const tmp = taskOrder[taskId];
        taskOrder[taskId] = taskOrder[otherId];
        taskOrder[otherId] = tmp;
        renderTaskChecklist();
    }

    function renderTaskChecklist() {
        publishTaskList.innerHTML = "";
        const currentDay = dayDrafts[activeDayIndex].dayNumber;

        // 1. 글 작성 순서 요약 - 체크된 항목만 순서대로 나열, ▲▼로 순서 조정, ✕로 선택 해제
        const selectedIds = Object.keys(taskAssignment)
            .filter(id => taskAssignment[id] === currentDay)
            .sort((a, b) => (taskOrder[a] || 0) - (taskOrder[b] || 0));

        if (selectedIds.length > 0) {
            const orderBox = document.createElement('div');
            orderBox.className = 'publish-order-box';
            orderBox.innerHTML = `<div class="publish-order-title">📝 글 작성 순서 (${selectedIds.length}개) · ▲▼로 순서 변경</div>`;
            selectedIds.forEach((taskId, i) => {
                const task = eligibleTasksCache.find(t => t.id === taskId);
                if (!task) return;
                const row = document.createElement('div');
                row.className = 'publish-order-row';
                row.innerHTML = `
                    <span class="publish-order-num">${i + 1}</span>
                    <span class="publish-order-name">${task.fields.시공품목}</span>
                    <button type="button" class="publish-order-btn" data-action="up" ${i === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" class="publish-order-btn" data-action="down" ${i === selectedIds.length - 1 ? 'disabled' : ''}>▼</button>
                    <button type="button" class="publish-order-btn remove" data-action="remove">✕</button>
                `;
                row.querySelector('[data-action="up"]').addEventListener('click', () => moveTaskOrder(taskId, -1, currentDay));
                row.querySelector('[data-action="down"]').addEventListener('click', () => moveTaskOrder(taskId, 1, currentDay));
                row.querySelector('[data-action="remove"]').addEventListener('click', () => {
                    delete taskAssignment[taskId];
                    delete taskOrder[taskId];
                    renumberDayOrder(currentDay);
                    renderTaskChecklist();
                });
                orderBox.appendChild(row);
            });
            publishTaskList.appendChild(orderBox);
        }

        // 2. 전체 품목 체크리스트
        eligibleTasksCache.forEach(task => {
            const fields = task.fields;
            const assignedDay = taskAssignment[task.id];
            const item = document.createElement('div');
            item.className = 'publish-item';
            item.dataset.recordId = task.id;

            if (assignedDay && assignedDay !== currentDay) {
                item.style.opacity = '0.4';
                const otherDraft = dayDrafts.find(d => d.dayNumber === assignedDay);
                const statusText = (otherDraft && otherDraft.published) ? `${assignedDay}일차에 발행됨` : `${assignedDay}일차에 배정됨`;
                item.innerHTML = `
                    <input type="checkbox" disabled style="width: 16px; height: 16px; flex-shrink:0;">
                    <span style="font-size: 14px; font-weight:800; color:var(--text-main); margin-left: 8px;">
                        ${fields.시공품목} (${statusText})
                    </span>
                `;
                publishTaskList.appendChild(item);
                return;
            }

            const isChecked = assignedDay === currentDay;
            item.classList.toggle('checked', isChecked);
            item.innerHTML = `
                <input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation()" style="width: 16px; height: 16px; flex-shrink:0;">
                <span style="font-size: 14px; font-weight:800; color:var(--text-main); margin-left: 8px;">
                    ${fields.시공품목}
                </span>
                ${isChecked ? `<span class="publish-item-order-badge">${taskOrder[task.id] || ''}</span>` : ''}
            `;

            const chk = item.querySelector('input');
            const applyToggle = () => {
                if (chk.checked) {
                    taskAssignment[task.id] = currentDay;
                    const currentMax = Math.max(0, ...Object.keys(taskAssignment)
                        .filter(id => taskAssignment[id] === currentDay && id !== task.id)
                        .map(id => taskOrder[id] || 0));
                    taskOrder[task.id] = currentMax + 1;
                } else {
                    delete taskAssignment[task.id];
                    delete taskOrder[task.id];
                    renumberDayOrder(currentDay);
                }
                renderTaskChecklist(); // 순서 요약/배지 갱신을 위해 전체 다시 그림
            };
            chk.addEventListener('change', applyToggle);
            item.addEventListener('click', () => {
                chk.checked = !chk.checked;
                applyToggle();
            });

            publishTaskList.appendChild(item);
        });
    }

    // 휴대폰 원본 사진(보통 3~8MB)을 블로그에 쓰기 충분한 해상도로 줄여서 업로드 속도 개선
    // 긴 변 1920px, JPEG 85% 품질 - 화면/블로그에서는 원본과 차이 안 보이면서 용량은 크게 줄어듦
    function resizeImageFile(file, maxDimension = 1920, quality = 0.85) {
        return new Promise((resolve) => {
            const objectUrl = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                let { width, height } = img;
                if (width > maxDimension || height > maxDimension) {
                    if (width > height) {
                        height = Math.round(height * (maxDimension / width));
                        width = maxDimension;
                    } else {
                        width = Math.round(width * (maxDimension / height));
                        height = maxDimension;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (!blob) { resolve(file); return; }
                    resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
                }, 'image/jpeg', quality);
            };
            img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
            img.src = objectUrl;
        });
    }

    // "구분|품목명|텍스트" 키로 샘플사진 URL 조회 (없으면 undefined)
    function getSamplePhotoUrl(map, 구분, 품목명, 텍스트) {
        if (!map) return undefined;
        return map[`${구분}|${품목명 || ''}|${텍스트}`];
    }

    // 지침 한 줄 / 사진슬롯 / 공지 한 줄에 샘플사진을 첨부(신규 등록 또는 교체)
    async function uploadSamplePhoto(구분, 품목명, 텍스트, file) {
        const resizedFile = await resizeImageFile(file);
        const formData = new FormData();
        formData.append('image', resizedFile, resizedFile.name);
        formData.append('구분', 구분);
        formData.append('품목명', 품목명 || '');
        formData.append('텍스트', 텍스트);

        const res = await fetchWithTimeout(API_SAMPLE_PHOTO_URL, {
            method: 'POST',
            body: formData
        }, 40000);
        if (!res.ok) throw new Error("샘플사진 업로드 실패");
    }

    async function deleteSamplePhoto(구분, 품목명, 텍스트) {
        const res = await fetchWithTimeout(API_SAMPLE_PHOTO_DELETE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 구분, 품목명: 품목명 || '', 텍스트 })
        }, 25000);
        if (!res.ok) throw new Error("샘플사진 삭제 실패");
    }

    async function uploadSingleJournalPhoto(journalId, file, fieldName) {
        const resizedFile = await resizeImageFile(file);

        // Base64는 원본 대비 전송량이 약 33% 늘어나므로, 사진 업로드(app.js)와 동일하게 바이너리(FormData)로 전송
        const formData = new FormData();
        formData.append('image', resizedFile, resizedFile.name);
        formData.append('journalId', journalId);
        formData.append('fieldName', fieldName);
        formData.append('filename', resizedFile.name);
        formData.append('contentType', resizedFile.type || 'image/jpeg');

        const res = await fetchWithTimeout(API_JOURNAL_PHOTO_URL, {
            method: 'POST',
            body: formData
        }, 40000);
        if (!res.ok) throw new Error("사진 업로드 실패: " + file.name);
        // Airtable uploadAttachment 응답에 그 필드의 최신 첨부파일 전체 목록(각 id 포함)이 들어있음 -
        // 방금 올린 파일을 filename으로 찾아서 attachment id를 확보해둬야 나중에 삭제 시 정확히 지정 가능
        const data = await res.json();
        const attachments = (data.fields && data.fields[fieldName]) || [];
        const matches = attachments.filter(a => a.filename === resizedFile.name);
        const newAttachment = matches[matches.length - 1];
        return {
            id: newAttachment && newAttachment.id,
            url: (newAttachment && newAttachment.url) || undefined,
            filename: resizedFile.name
        };
    }

    // 일지제목/날씨/특징/에피소드를 Airtable에 저장하고, 아직 업로드 안 된 사진들을 업로드.
    // 임시저장과 실제 발행이 공통으로 쓰는 부분 - 이 함수가 끝나면 창을 닫고 다시 들어와도 내용/사진이 남아있음.
    async function persistJournalDayDraft(d) {
        // 이 일차에 체크된 작업들을 관리자가 지정한 순서 그대로 콤마 구분 텍스트로 저장
        // (Notion 발행 시 이 순서대로 품목이 나열됨)
        const orderedTaskIds = Object.keys(taskAssignment)
            .filter(id => taskAssignment[id] === d.dayNumber)
            .sort((a, b) => (taskOrder[a] || 0) - (taskOrder[b] || 0));

        const res = await fetchWithTimeout(API_JOURNAL_CREATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                journalId: d.journalId || undefined,
                projectCode: activeProjectCode,
                일지제목: d.title,
                일차: d.dayNumber,
                오늘의날씨: d.weather,
                현장의특징: d.feature,
                오늘의에피소드: d.episode,
                포함작업목록: orderedTaskIds.join(','),
                당일공지사항: (currentDetailData.project && currentDetailData.project.공지사항) || ''
            })
        });
        if (!res.ok) throw new Error("일지 저장 실패");
        if (!d.journalId) {
            const created = await res.json();
            const rec = Array.isArray(created) ? created[0] : created;
            d.journalId = rec.id;
        }
        const journalId = d.journalId;

        // 대기 중인 사진들을 카테고리 구분 없이 한꺼번에 병렬 업로드 (순차 업로드 대비 훨씬 빠름)
        // 실패한 파일은 pending에 그대로 남겨둬서 다음 저장 시도 때 다시 올릴 수 있게 함
        async function uploadPendingList(pendingList, fieldName, savedList) {
            const remaining = [];
            const results = await Promise.allSettled(
                pendingList.map(file => uploadSingleJournalPhoto(journalId, file, fieldName))
            );
            results.forEach((r, i) => {
                const file = pendingList[i];
                if (r.status === 'fulfilled') {
                    const uploaded = r.value || {};
                    savedList.push({
                        id: uploaded.id,
                        url: uploaded.url || URL.createObjectURL(file),
                        filename: uploaded.filename || file.name
                    });
                } else {
                    console.error(r.reason);
                    remaining.push(file);
                }
            });
            return remaining;
        }

        const [sceneRemaining, cleanupRemaining, filmRemaining] = await Promise.all([
            uploadPendingList(d.scenePending, '현장사진', d.sceneSaved),
            uploadPendingList(d.cleanupPending, '정리정돈사진', d.cleanupSaved),
            uploadPendingList(d.filmPending, '필름사진', d.filmSaved)
        ]);
        d.scenePending = sceneRemaining;
        d.cleanupPending = cleanupRemaining;
        d.filmPending = filmRemaining;

        const totalFailed = sceneRemaining.length + cleanupRemaining.length + filmRemaining.length;
        if (totalFailed > 0) {
            throw new Error(`사진 ${totalFailed}장 업로드 실패 (다시 저장을 눌러 재시도해 주세요)`);
        }

        return journalId;
    }

    // 발행 없이 지금까지 작성한 내용/사진만 저장 (창을 닫았다가 다시 열어도 남아있게)
    window.saveCurrentJournalDraft = async function() {
        saveFormIntoCurrentDraft();
        const d = dayDrafts[activeDayIndex];

        if (!d.title.trim()) {
            showToast("일지제목을 입력해주세요.", "danger");
            return;
        }

        showLoading(`${d.dayNumber}일차 임시 저장 중...`);
        try {
            await persistJournalDayDraft(d);
            showToast(`${d.dayNumber}일차 내용이 임시 저장되었습니다. 창을 닫았다 다시 열어도 남아있습니다.`, "success");
            renderJournalTabs();
            loadDayDraftIntoForm();
        } catch (error) {
            console.error(error);
            showToast("임시 저장 중 오류가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // n8n 최종 블로그 발행 트리거 호출 (현재 활성화된 일차 탭만 발행 - 이미 발행된 일차도 내용 추가 후 재발행 가능)
    window.submitCurrentJournalDay = async function() {
        saveFormIntoCurrentDraft();
        const d = dayDrafts[activeDayIndex];

        if (!d.title.trim()) {
            showToast("일지제목을 입력해주세요.", "danger");
            return;
        }

        const taskIds = Object.keys(taskAssignment)
            .filter(id => taskAssignment[id] === d.dayNumber)
            .sort((a, b) => (taskOrder[a] || 0) - (taskOrder[b] || 0));
        if (taskIds.length === 0) {
            showToast("포함할 시공 내역을 최소 1개 이상 선택해주세요.", "danger");
            return;
        }

        const wasAlreadyPublished = d.published;
        showLoading(wasAlreadyPublished ? `${d.dayNumber}일차 재발행 중...` : `${d.dayNumber}일차 자료 생성 중...`);
        try {
            const journalId = await persistJournalDayDraft(d);

            const pubRes = await fetchWithTimeout(API_PUBLISH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ journalId, taskIds })
            });
            if (!pubRes.ok) throw new Error("발행 트리거 실패");

            d.published = true;

            showToast(wasAlreadyPublished
                ? `${d.dayNumber}일차 재발행 요청이 접수되었습니다! 완료 시 텔레그램으로 새 문서 링크가 발송됩니다.`
                : `${d.dayNumber}일차 발행 요청이 접수되었습니다! 완료 시 텔레그램으로 문서 링크가 발송됩니다.`);
            renderJournalTabs();
            loadDayDraftIntoForm();
            renderTaskChecklist();
        } catch (error) {
            console.error(error);
            showToast("발행 처리 중 오류가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // =====================================================================
    // 시공품목 설정 모달 기능
    // =====================================================================

    window.openItemConfigModal = function() {
        document.getElementById('itemConfigModal').style.display = 'flex';
        renderItemConfigList();
    };

    window.closeItemConfigModal = function() {
        document.getElementById('itemConfigModal').style.display = 'none';
    };

    let itemConfigTab = ''; // 품목설정에서 지금 보고 있는 카테고리 탭

    // 카테고리 값 '뒷정리'는 저장 값이라 그대로 두고, 화면에서만 '현장정리'로 보여준다
    function itemCategoryLabel(cat) { return cat === '뒷정리' ? '현장정리' : cat; }

    window.selectItemConfigTab = function(cat) {
        itemConfigTab = cat;
        renderItemConfigList();
        document.getElementById('itemConfigBody').scrollTop = 0;
    };

    function renderItemConfigList() {
        const container = document.getElementById('itemConfigBody');
        const tabsEl = document.getElementById('itemConfigTabs');
        if (!globalMasterItems || globalMasterItems.length === 0) {
            tabsEl.innerHTML = '';
            container.innerHTML = `<div class="empty-state">등록된 시공품목이 없습니다. 아래에서 새 품목을 추가해 주세요.</div>`;
            return;
        }

        // 카테고리별로 원본 배열의 인덱스를 묶어서 그룹핑
        const categoryGroups = new Map();
        globalMasterItems.forEach((item, idx) => {
            const cat = item.카테고리 || "기타";
            if (!categoryGroups.has(cat)) categoryGroups.set(cat, []);
            categoryGroups.get(cat).push(idx);
        });

        // 각 카테고리 내에서 우선순위(숫자) 오름차순으로 정렬
        categoryGroups.forEach((indices) => {
            indices.sort((idxA, idxB) => {
                const pA = globalMasterItems[idxA].우선순위 !== undefined ? globalMasterItems[idxA].우선순위 : 999;
                const pB = globalMasterItems[idxB].우선순위 !== undefined ? globalMasterItems[idxB].우선순위 : 999;
                return pA - pB;
            });
        });

        // 카테고리 표시 순서 고정 (목록에 없는 카테고리는 맨 뒤로)
        const CATEGORY_ORDER = ['문+틀', '샤시', '가구', '몰딩', '뒷정리', '기타'];
        const sortedCategoryEntries = Array.from(categoryGroups.entries()).sort((a, b) => {
            const rankA = CATEGORY_ORDER.indexOf(a[0]) === -1 ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(a[0]);
            const rankB = CATEGORY_ORDER.indexOf(b[0]) === -1 ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(b[0]);
            return rankA - rankB;
        });

        // 보고 있던 탭이 없어졌으면(카테고리를 바꿔 비었을 때 등) 첫 탭으로
        if (!sortedCategoryEntries.some(([c]) => c === itemConfigTab)) itemConfigTab = sortedCategoryEntries[0][0];

        tabsEl.innerHTML = sortedCategoryEntries.map(([category, indices]) =>
            `<button type="button" class="gallery-zone-tab${category === itemConfigTab ? ' active' : ''}" data-cat="${category.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" onclick="selectItemConfigTab(this.dataset.cat)">${itemCategoryLabel(category)} (${indices.length})</button>`
        ).join('');
        const activeTab = tabsEl.querySelector('.active');
        if (activeTab) tabsEl.scrollLeft = activeTab.offsetLeft - (tabsEl.clientWidth - activeTab.offsetWidth) / 2;

        let html = "";
        sortedCategoryEntries.filter(([category]) => category === itemConfigTab).forEach(([category, indices]) => {
            indices.forEach(idx => {
                const item = globalMasterItems[idx];
                html += `
                    <div class="item-config-card" data-item-idx="${idx}">
                        <div class="item-config-card-header" onclick="openItemEditModal(${idx})">
                            <h4>${item.작업방식 === '한번에'
                                ? `🧹 ${item.품목명} <span class="item-mode-badge">${item.반복 === '매일' ? '매일' : '한 번'}${item.사진필수 ? ' · 사진필수' : ''}</span>`
                                : `📦 ${item.품목명}`}</h4>
                            <span class="accordion-icon">✏️</span>
                        </div>
                    </div>
                `;
            });
        });
        container.innerHTML = html;

        // Chrome/Windows에서 스크롤 컨테이너에 대량 innerHTML 주입 시
        // 텍스트가 페인트되지 않는 렌더링 버그 방지용 강제 리페인트
        container.style.display = 'none';
        void container.offsetHeight;
        container.style.display = '';
    }

    let editingItemIdx = null; // 편집 중인 globalMasterItems 인덱스, 신규 등록 중이면 null
    let editingItemSlots = []; // 현재 열린 팝업의 사진 슬롯 작업용 배열

    // 사진 선택 → 리사이즈 → 업로드까지 처리하고, 끝나면 onDone 콜백으로 화면 갱신
    function triggerSamplePhotoPick(구분, 품목명, 텍스트, onDone) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            showLoading('샘플사진 저장 중...');
            try {
                await uploadSamplePhoto(구분, 품목명, 텍스트, file);
                const objectUrl = URL.createObjectURL(file);
                const key = `${구분}|${품목명 || ''}|${텍스트}`;
                globalSamplePhotos[key] = objectUrl;
                if (currentDetailData && currentDetailData.samplePhotos) {
                    currentDetailData.samplePhotos[key] = objectUrl;
                }
                showToast('샘플사진이 저장되었습니다.');
                if (onDone) onDone();
            } catch (error) {
                console.error(error);
                showToast('샘플사진 저장에 실패했습니다.', 'danger');
            } finally {
                hideLoading();
            }
        });
        input.click();
    }

    // 지침 줄/사진슬롯 목록을 받아서, 줄마다 [텍스트 + (핸들) + 샘플사진 썸네일 or 추가버튼] 행을 만들어줌
    // onReorder(newLines)가 주어지면 ✋ 핸들을 잡고 드래그해서 순서변경도 가능해짐 (현재는 공지사항에만 사용)
    function buildSampleLineRows(구분, 품목명, lines, map, onDone, onReorder) {
        const wrap = document.createElement('div');
        wrap.className = 'sample-photo-line-list';

        const cleanLines = (lines || []).map(l => l.trim()).filter(l => l !== '');
        if (cleanLines.length === 0) {
            wrap.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">등록된 항목이 없습니다.</span>';
            return wrap;
        }

        cleanLines.forEach((line) => {
            const row = document.createElement('div');
            row.className = 'sample-photo-line-row';

            const textSpan = document.createElement('span');
            textSpan.className = 'sample-photo-line-text';
            textSpan.textContent = line;
            row.appendChild(textSpan);

            if (onReorder) {
                row.draggable = true;
                row.addEventListener('dragstart', () => {
                    row.classList.add('dragging');
                });
                row.addEventListener('dragend', () => {
                    row.classList.remove('dragging');
                    const newLines = Array.from(wrap.querySelectorAll('.sample-photo-line-row'))
                        .map(r => r.querySelector('.sample-photo-line-text').textContent);
                    onReorder(newLines);
                });

                const handle = document.createElement('span');
                handle.className = 'sample-photo-line-handle';
                handle.title = '여기를 잡고 위아래로 드래그해서 순서 이동';
                handle.textContent = '✋';
                row.appendChild(handle);
            }

            const existingUrl = getSamplePhotoUrl(map, 구분, 품목명, line);
            if (existingUrl) {
                const img = document.createElement('img');
                img.src = existingUrl;
                img.className = 'sample-photo-thumb';
                img.title = '클릭해서 교체';
                img.addEventListener('click', () => triggerSamplePhotoPick(구분, 품목명, line, onDone));
                row.appendChild(img);

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'btn-sample-photo-delete';
                delBtn.title = '샘플사진 삭제';
                delBtn.textContent = '×';
                delBtn.addEventListener('click', async () => {
                    if (!confirm('이 샘플사진을 삭제할까요?')) return;
                    showLoading('샘플사진 삭제 중...');
                    try {
                        await deleteSamplePhoto(구분, 품목명, line);
                        const key = `${구분}|${품목명 || ''}|${line}`;
                        delete globalSamplePhotos[key];
                        if (currentDetailData && currentDetailData.samplePhotos) {
                            delete currentDetailData.samplePhotos[key];
                        }
                        showToast('샘플사진이 삭제되었습니다.');
                        if (onDone) onDone();
                    } catch (error) {
                        console.error(error);
                        showToast('샘플사진 삭제에 실패했습니다.', 'danger');
                    } finally {
                        hideLoading();
                    }
                });
                row.appendChild(delBtn);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-sample-photo-add';
                btn.textContent = '📷 사진';
                btn.addEventListener('click', () => triggerSamplePhotoPick(구분, 품목명, line, onDone));
                row.appendChild(btn);
            }

            wrap.appendChild(row);
        });

        if (onReorder) {
            wrap.addEventListener('dragover', (e) => {
                e.preventDefault();
                const draggingRow = wrap.querySelector('.sample-photo-line-row.dragging');
                if (!draggingRow) return;
                const siblings = [...wrap.querySelectorAll('.sample-photo-line-row:not(.dragging)')];
                const nextSibling = siblings.find(sibling => {
                    const box = sibling.getBoundingClientRect();
                    return e.clientY <= box.top + box.height / 2;
                });
                wrap.insertBefore(draggingRow, nextSibling);
            });
        }

        return wrap;
    }

    // 품목 편집 모달의 지침/사진슬롯 목록 옆에 샘플사진 관리 UI를 그려줌 (신규 등록 중일 땐 표시 안 함)
    function renderItemEditSamplePhotos() {
        const container = document.getElementById('itemEditSamplePhotos');
        if (!container) return;
        if (editingItemIdx === null) {
            container.innerHTML = '';
            return;
        }

        const 품목명 = document.getElementById('itemEditNameInput').value.trim();
        const prepLines = document.getElementById('itemEditPrepInput').value.split('\n');
        const inspLines = document.getElementById('itemEditInspInput').value.split('\n');

        container.innerHTML = '';

        const prepSection = document.createElement('div');
        prepSection.innerHTML = '<h4 class="sample-photo-section-title">📷 밑작업 지침 샘플사진</h4>';
        prepSection.appendChild(buildSampleLineRows('밑작업지침', 품목명, prepLines, globalSamplePhotos, renderItemEditSamplePhotos));
        container.appendChild(prepSection);

        const inspSection = document.createElement('div');
        inspSection.innerHTML = '<h4 class="sample-photo-section-title" style="margin-top:14px;">📷 시공 지침 샘플사진</h4>';
        inspSection.appendChild(buildSampleLineRows('시공지침', 품목명, inspLines, globalSamplePhotos, renderItemEditSamplePhotos));
        container.appendChild(inspSection);

        const slotSection = document.createElement('div');
        slotSection.innerHTML = '<h4 class="sample-photo-section-title" style="margin-top:14px;">📷 필수 사진 슬롯 샘플사진</h4>';
        slotSection.appendChild(buildSampleLineRows('사진슬롯', 품목명, editingItemSlots, globalSamplePhotos, renderItemEditSamplePhotos));
        container.appendChild(slotSection);
    }

    // 공지사항 줄마다 샘플사진 관리 UI를 그려줌 (현장 공지는 품목명 없이 텍스트만으로 매칭)
    function renderNoticeSamplePhotos() {
        const container = document.getElementById('noticeSamplePhotos');
        if (!container) return;
        const noticeEl = document.getElementById('detailProjectNotice');
        const lines = noticeEl ? noticeEl.value.split('\n') : [];
        const map = (currentDetailData && currentDetailData.samplePhotos) || {};
        container.innerHTML = '';
        container.appendChild(buildSampleLineRows('공지사항', '', lines, map, renderNoticeSamplePhotos, (newLines) => {
            // 순서만 화면(텍스트박스)에 바로 반영 - 실제 저장은 기존 "공지사항 저장" 버튼을 눌러야 함(기존 수정 방식과 동일)
            if (noticeEl) noticeEl.value = newLines.join('\n');
            renderNoticeSamplePhotos();
        }));
    }

    const detailProjectNoticeEl = document.getElementById('detailProjectNotice');
    if (detailProjectNoticeEl) detailProjectNoticeEl.addEventListener('input', renderNoticeSamplePhotos);

    // 지침 텍스트를 고치는 도중에도 샘플사진 목록이 실시간으로 따라가도록 연결
    const itemEditPrepInputEl = document.getElementById('itemEditPrepInput');
    const itemEditInspInputEl = document.getElementById('itemEditInspInput');
    if (itemEditPrepInputEl) itemEditPrepInputEl.addEventListener('input', renderItemEditSamplePhotos);
    if (itemEditInspInputEl) itemEditInspInputEl.addEventListener('input', renderItemEditSamplePhotos);

    window.openItemEditModal = function(idx) {
        editingItemIdx = idx;
        const item = globalMasterItems[idx];
        document.getElementById('itemEditModalTitle').textContent = '📦 시공품목 편집';
        document.getElementById('itemEditNameInput').value = item.품목명 || '';
        document.getElementById('itemEditCategoryInput').value = item.카테고리 || '문+틀';
        const parsedZone = parseZoneFloor(item.구역);
        document.getElementById('itemEditFloorInput').value = String(parsedZone.floor);
        document.getElementById('itemEditRoomInput').value = ROOM_ORDER.includes(parsedZone.room) ? parsedZone.room : '기타';
        document.getElementById('itemEditPrepInput').value = item.밑작업지침 || '';
        document.getElementById('itemEditInspInput').value = item.시공후점검지침 || '';
        document.getElementById('itemEditModeInput').value = item.작업방식 === '한번에' ? '한번에' : '';
        document.getElementById('itemEditRepeatInput').value = item.반복 === '매일' ? '매일' : '';
        document.getElementById('itemEditPhotoReqInput').checked = !!item.사진필수;
        applyItemEditModeUI();
        editingItemSlots = (item.필수사진슬롯 || '').split(',').map(s => s.trim()).filter(s => s !== '');
        renderItemEditSlotTags();
        document.getElementById('itemEditModal').style.display = 'flex';
    };

    window.openNewItemModal = function() {
        editingItemIdx = null;
        document.getElementById('itemEditModalTitle').textContent = '➕ 새 시공품목 추가';
        document.getElementById('itemEditNameInput').value = '';
        document.getElementById('itemEditCategoryInput').value = '문+틀';
        document.getElementById('itemEditFloorInput').value = '1';
        document.getElementById('itemEditRoomInput').value = '기타';
        document.getElementById('itemEditPrepInput').value = '';
        document.getElementById('itemEditInspInput').value = '';
        document.getElementById('itemEditModeInput').value = '';
        document.getElementById('itemEditRepeatInput').value = '매일';
        document.getElementById('itemEditPhotoReqInput').checked = false;
        applyItemEditModeUI();
        editingItemSlots = [];
        renderItemEditSlotTags();
        document.getElementById('itemEditModal').style.display = 'flex';
    };

    // 작업 방식이 '한 번에'(뒷정리) 이면 구역·밑작업 지침·사진 슬롯을 숨기고 반복·사진필수를 보인다.
    // 시공 후 점검 지침 칸은 '할 일' 목록으로 이름만 바꿔 그대로 쓴다 (기사님 화면의 체크 항목이 된다).
    window.applyItemEditModeUI = function() {
        const 뒷정리 = document.getElementById('itemEditModeInput').value === '한번에';
        document.getElementById('itemEditCleanupWrap').style.display = 뒷정리 ? 'block' : 'none';
        document.getElementById('itemEditZoneWrap').style.display = 뒷정리 ? 'none' : '';
        document.getElementById('itemEditPrepWrap').style.display = 뒷정리 ? 'none' : '';
        document.getElementById('itemEditSlotWrap').style.display = 뒷정리 ? 'none' : '';
        document.getElementById('itemEditInspLabel').textContent = 뒷정리
            ? '할 일 (엔터로 줄 구분 · 기사님 화면에 체크 항목으로 나옴)'
            : '시공 후 점검 지침 (엔터로 줄 구분)';
    };

    // 카테고리를 '뒷정리' 로 고르면 작업 방식도 '한 번에' 로 맞춰준다 (대부분 그렇게 쓰므로)
    window.onItemEditCategoryChange = function() {
        if (document.getElementById('itemEditCategoryInput').value === '뒷정리') {
            document.getElementById('itemEditModeInput').value = '한번에';
            applyItemEditModeUI();
        }
    };

    window.closeItemEditModal = function() {
        document.getElementById('itemEditModal').style.display = 'none';
        editingItemIdx = null;
        editingItemSlots = [];
    };

    function renderItemEditSlotTags() {
        const slotTagsHtml = editingItemSlots.map(slot =>
            `<span class="photo-slot-tag">${slot}<span class="tag-delete" onclick="removePhotoSlotModal('${slot.replace(/'/g, "\\'")}')">×</span></span>`
        ).join('');
        document.getElementById('itemEditSlotTags').innerHTML =
            slotTagsHtml || '<span style="font-size:12px;color:var(--text-muted);">등록된 사진 슬롯이 없습니다.</span>';
        renderItemEditSamplePhotos();
    }

    window.addPhotoSlotModal = function() {
        const input = document.getElementById('itemEditSlotInput');
        const slotName = input.value.trim();
        if (!slotName) return;

        if (editingItemSlots.includes(slotName)) {
            showToast('이미 등록된 슬롯명입니다.', 'warning');
            return;
        }
        editingItemSlots.push(slotName);
        input.value = '';
        renderItemEditSlotTags();
    };

    window.removePhotoSlotModal = function(slotName) {
        editingItemSlots = editingItemSlots.filter(s => s !== slotName);
        renderItemEditSlotTags();
    };

    window.saveItemEditModal = async function() {
        const idx = editingItemIdx;
        const isCreate = (idx === null);
        const nameText = document.getElementById('itemEditNameInput').value.trim();
        const categoryText = document.getElementById('itemEditCategoryInput').value;
        const zoneText = composeZone(document.getElementById('itemEditFloorInput').value, document.getElementById('itemEditRoomInput').value);
        const prepText = document.getElementById('itemEditPrepInput').value;
        const inspText = document.getElementById('itemEditInspInput').value;
        const slotsText = editingItemSlots.join(',');
        const modeText = document.getElementById('itemEditModeInput').value === '한번에' ? '한번에' : '';
        // 반복·사진필수는 '한 번에' 품목에서만 뜻이 있다. 기본 품목으로 되돌리면 같이 비운다
        const repeatText = modeText ? (document.getElementById('itemEditRepeatInput').value === '매일' ? '매일' : '') : '';
        const photoRequired = modeText ? document.getElementById('itemEditPhotoReqInput').checked : false;

        if (!nameText) {
            showToast('품목명을 입력해 주세요.', 'warning');
            return;
        }
        if (isCreate && globalMasterItems.some(item => item.품목명 === nameText)) {
            showToast('이미 존재하는 품목명입니다.', 'warning');
            return;
        }

        showLoading(`${nameText} 품목 저장 중...`);
        try {
            const requestBody = isCreate
                ? {
                    type: 'create_item',
                    품목명: nameText,
                    카테고리: categoryText,
                    구역: zoneText,
                    밑작업지침: prepText,
                    시공후점검지침: inspText,
                    필수사진슬롯: slotsText,
                    작업방식: modeText,
                    반복: repeatText,
                    사진필수: photoRequired
                }
                : {
                    type: 'update_item',
                    recordId: globalMasterItems[idx].id,
                    품목명: nameText,
                    카테고리: categoryText,
                    구역: zoneText,
                    밑작업지침: prepText,
                    시공후점검지침: inspText,
                    필수사진슬롯: slotsText,
                    작업방식: modeText,
                    반복: repeatText,
                    사진필수: photoRequired
                };

            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) throw new Error('저장 실패');

            if (isCreate) {
                showToast(`${nameText} 품목이 성공적으로 등록되었습니다!`);
                await loadProjectList(true); // 방금 새로 생겼으니 캐시 말고 무조건 새로 조회
            } else {
                const item = globalMasterItems[idx];
                item.품목명 = nameText;
                item.카테고리 = categoryText;
                item.구역 = zoneText;
                item.밑작업지침 = prepText;
                item.시공후점검지침 = inspText;
                item.필수사진슬롯 = slotsText;
                item.작업방식 = modeText;
                item.반복 = repeatText;
                item.사진필수 = photoRequired;
                showToast(`${nameText} 품목 설정이 저장되었습니다!`);
            }

            closeItemEditModal();
            itemConfigTab = categoryText || '기타'; // 저장한 품목이 있는 탭으로 이동 (카테고리를 바꿨어도 바로 보이게)
            renderItemConfigList();
        } catch (error) {
            console.error(error);
            showToast('품목 저장에 실패했습니다.', 'danger');
        } finally {
            hideLoading();
        }
    };

    // 공지 및 주의사항 저장
    window.saveProjectNotice = async function() {
        if (!activeProjectCode) return;
        const noticeText = document.getElementById('detailProjectNotice').value;

        showLoading("공지사항 업데이트 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_notice',
                    projectCode: activeProjectCode,
                    noticeText: noticeText
                })
            });

            if (!response.ok) throw new Error("업데이트 오류");
            
            showToast("현장 공지 및 주의사항이 성공적으로 저장되었습니다!");
            // 데이터 재조회 및 화면 갱신
            await showProjectDetail(activeProjectCode);
            // 재조회로 전체가 다시 그려지면서 기본값(접힘)으로 돌아가므로, 저장 직후에는 다시 펼쳐서 보여줌
            const noticeBody = document.getElementById('noticeSectionBody');
            const noticeArrow = document.getElementById('noticeSectionToggleArrow');
            if (noticeBody) noticeBody.style.display = 'flex';
            if (noticeArrow) noticeArrow.textContent = '▼ 접기';
        } catch (error) {
            console.error(error);
            showToast("공지사항 저장 중 문제가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // ===== 중점체크사항 (사장님이 관리자 화면에서 직접 체크하는 개인 점검 메모장 - 공지사항과 달리 노션 발행에는 안 들어감) =====
    let globalCheckpointQuickList = [];

    // 자주 쓰는 중점체크 템플릿 칩 렌더링 (누르면 현재 현장의 체크리스트에 미체크 상태로 추가됨)
    function renderCheckpointQuickTags(list) {
        globalCheckpointQuickList = list || globalCheckpointQuickList || [];
        const container = document.getElementById('checkpointQuickTags');
        if (!container) return;
        container.innerHTML = "";

        if (globalCheckpointQuickList.length === 0) {
            container.innerHTML = `<span style="font-size: 12px; color: var(--text-muted); padding: 4px;">에어테이블에 등록된 중점체크 템플릿이 없습니다. 아래에서 새로 등록해 보세요!</span>`;
            return;
        }

        globalCheckpointQuickList.forEach(text => {
            const span = document.createElement('span');
            span.className = 'notice-tag';
            span.textContent = text;
            span.onclick = function() {
                addCheckpointItem(text);
            };
            container.appendChild(span);
        });
    }

    // "[✓] 텍스트" / "[ ] 텍스트" 한 줄씩으로 저장된 텍스트를 {checked, text} 배열로 파싱
    // (점검결과 필드 등 이 프로젝트 다른 곳에서도 쓰는 것과 같은 체크박스 표기 방식)
    function parseCheckpointLines(raw) {
        return (raw || "").split('\n').map(l => l.trim()).filter(l => l !== "").map(line => {
            const checked = line.startsWith('[✓]');
            const text = line.replace(/^\[[✓ ]\]\s*/, '');
            return { checked, text };
        });
    }

    function serializeCheckpointLines(lines) {
        return lines.map(l => `[${l.checked ? '✓' : ' '}] ${l.text}`).join('\n');
    }

    // 템플릿 칩을 눌러 새 항목(미체크 상태)을 현재 현장 체크리스트에 추가
    function addCheckpointItem(text) {
        const lines = parseCheckpointLines((currentDetailData.project && currentDetailData.project.중점체크사항) || "");
        if (lines.some(l => l.text === text)) {
            showToast("이미 등록된 항목입니다.", "warning");
            return;
        }
        lines.push({ checked: false, text });
        persistCheckpointLines(lines);
    }

    // 현재 현장의 중점체크사항 목록을 체크박스 행으로 렌더링
    function renderCheckpointChecklist() {
        const container = document.getElementById('checkpointChecklist');
        if (!container) return;
        const lines = parseCheckpointLines((currentDetailData.project && currentDetailData.project.중점체크사항) || "");
        container.innerHTML = "";

        // 섹션이 접혀있어도 미체크 개수가 바로 보이도록, 제목 옆에 배지로 표시
        const badge = document.getElementById('checkpointUncheckedBadge');
        if (badge) {
            const uncheckedCount = lines.filter(l => !l.checked).length;
            if (uncheckedCount > 0) {
                badge.textContent = `⚠️ 미완료 ${uncheckedCount}`;
                badge.className = 'checkpoint-unchecked-badge';
            } else {
                badge.textContent = '';
                badge.className = '';
            }
        }

        if (lines.length === 0) {
            container.innerHTML = `<span style="font-size:12px;color:var(--text-muted);padding:4px;">등록된 중점체크사항이 없습니다. 위 템플릿을 누르거나 새로 등록해 보세요.</span>`;
            return;
        }

        lines.forEach((line, idx) => {
            const row = document.createElement('div');
            row.className = `checkpoint-item-row ${line.checked ? 'checked' : ''}`;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkpoint-item-checkbox';
            checkbox.checked = line.checked;
            checkbox.addEventListener('change', () => {
                const current = parseCheckpointLines((currentDetailData.project && currentDetailData.project.중점체크사항) || "");
                current[idx].checked = checkbox.checked;
                persistCheckpointLines(current);
            });

            const textSpan = document.createElement('span');
            textSpan.className = 'checkpoint-item-text';
            textSpan.textContent = line.text;

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'checkpoint-item-delete';
            delBtn.title = '삭제';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', () => {
                const current = parseCheckpointLines((currentDetailData.project && currentDetailData.project.중점체크사항) || "");
                current.splice(idx, 1);
                persistCheckpointLines(current);
            });

            row.appendChild(checkbox);
            row.appendChild(textSpan);
            row.appendChild(delBtn);
            container.appendChild(row);
        });
    }

    // 체크/추가/삭제 즉시 자동 저장 (실제 체크리스트처럼 바로바로 반영되게 함 - 별도 저장 버튼 없음)
    async function persistCheckpointLines(lines) {
        const newText = serializeCheckpointLines(lines);
        if (currentDetailData.project) currentDetailData.project.중점체크사항 = newText;
        renderCheckpointChecklist();

        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_checkpoint',
                    projectCode: activeProjectCode,
                    checklistText: newText
                })
            });
            if (!response.ok) throw new Error("저장 실패");
        } catch (error) {
            console.error(error);
            showToast("중점체크사항 저장에 실패했습니다.", "danger");
        }
    }

    // 자주 쓰는 중점체크 템플릿을 에어테이블에 실시간 등록 (자주쓰는공지 등록과 동일한 패턴)
    window.addNewCheckpointTemplateTag = async function() {
        const input = document.getElementById('detailCustomCheckpointTagInput');
        const text = input.value.trim();
        if (!text) return;

        if (globalCheckpointQuickList.includes(text)) {
            showToast("이미 등록된 중점체크 템플릿입니다.", "warning");
            input.value = "";
            return;
        }

        showLoading("새 중점체크 템플릿을 등록하는 중...");
        try {
            const response = await fetchWithTimeout("https://primary-production-a6fa.up.railway.app/webhook/film-checkpoint-template-create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ checkText: text })
            });

            if (!response.ok) throw new Error("등록 실패");

            globalCheckpointQuickList.push(text);
            renderCheckpointQuickTags(globalCheckpointQuickList);
            // 새로 등록한 템플릿은 지금 보고 있는 현장의 체크리스트에도 바로 추가
            addCheckpointItem(text);

            input.value = "";
            showToast("중점체크 템플릿이 에어테이블에 실시간 등록되었습니다.", "success");
        } catch (error) {
            console.error(error);
            showToast("중점체크 템플릿 등록에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    window.addWorkerPrompt = async function() {
        if (!activeProjectCode) return;
        const name = prompt("추가할 기사님 성함을 입력해 주세요:");
        if (!name || !name.trim()) return;
        const newName = name.trim();

        const existingWorkers = currentDetailData.workers || [];
        if (existingWorkers.includes(newName)) {
            showToast("이미 등록된 기사님입니다.", "warning");
            return;
        }
        const updatedWorkers = [...existingWorkers, newName];

        showLoading(`${newName} 기사님 추가 중...`);
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_workers',
                    projectCode: activeProjectCode,
                    workersText: updatedWorkers.join(',')
                })
            });

            if (!response.ok) throw new Error("추가 오류");

            showToast(`${newName} 기사님이 추가되었습니다!`);
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("기사님 추가 중 문제가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 기사님 이름 수정 (오타 수정 등). 현장 기사 명단뿐 아니라, 이미 이 기사님으로 배정된
    // 작업 레코드들의 밑작업기사/시공기사 필드도 함께 새 이름으로 갱신해서 배정이 끊기지 않게 함
    window.renameWorkerPrompt = async function(oldName) {
        if (!activeProjectCode) return;
        const name = prompt(`"${oldName}" 기사님의 새 이름을 입력해 주세요:`, oldName);
        if (!name || !name.trim()) return;
        const newName = name.trim();
        if (newName === oldName) return;

        const existingWorkers = currentDetailData.workers || [];
        if (existingWorkers.includes(newName)) {
            showToast("이미 등록된 기사님 이름입니다.", "warning");
            return;
        }
        const updatedWorkers = existingWorkers.map(w => w === oldName ? newName : w);

        // 이 기사님으로 이미 배정된 작업들의 담당자 필드도 함께 갱신 대상으로 수집
        const affectedTasks = (currentDetailData.tasks || [])
            .filter(t => t.fields.밑작업기사 === oldName || t.fields.시공기사 === oldName)
            .map(t => {
                const upd = { id: t.id };
                if (t.fields.밑작업기사 === oldName) upd.밑작업기사 = newName;
                if (t.fields.시공기사 === oldName) upd.시공기사 = newName;
                return upd;
            });

        showLoading(`${oldName} → ${newName} 이름 수정 중...`);
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_workers',
                    projectCode: activeProjectCode,
                    workersText: updatedWorkers.join(',')
                })
            });
            if (!response.ok) throw new Error("이름 수정 오류");

            if (affectedTasks.length > 0) {
                const response2 = await fetchWithTimeout(API_SAVE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'rename_worker',
                        affectedTasks: affectedTasks
                    })
                });
                if (!response2.ok) throw new Error("배정된 작업 갱신 오류");
            }

            if (activeWorkerName === oldName) activeWorkerName = newName;

            showToast(`"${oldName}" → "${newName}"(으)로 이름이 수정되었습니다!`);
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("이름 수정 중 문제가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 기사님 삭제. 이미 배정된 작업이 있으면 먼저 알리고, 삭제 시 그 배정도 함께 해제
    window.deleteWorkerPrompt = async function(name) {
        if (!activeProjectCode) return;
        const existingWorkers = currentDetailData.workers || [];
        const affectedTasks = (currentDetailData.tasks || [])
            .filter(t => t.fields.밑작업기사 === name || t.fields.시공기사 === name);

        const confirmMsg = affectedTasks.length > 0
            ? `"${name}" 기사님으로 배정된 작업이 ${affectedTasks.length}건 있습니다.\n삭제하면 이 배정도 함께 해제됩니다. 계속할까요?`
            : `"${name}" 기사님을 목록에서 삭제할까요?`;
        if (!confirm(confirmMsg)) return;

        const updatedWorkers = existingWorkers.filter(w => w !== name);

        showLoading(`${name} 기사님 삭제 중...`);
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_workers',
                    projectCode: activeProjectCode,
                    workersText: updatedWorkers.join(',')
                })
            });
            if (!response.ok) throw new Error("삭제 오류");

            if (affectedTasks.length > 0) {
                const clearedTasks = affectedTasks.map(t => {
                    const upd = { id: t.id };
                    if (t.fields.밑작업기사 === name) upd.밑작업기사 = '';
                    if (t.fields.시공기사 === name) upd.시공기사 = '';
                    return upd;
                });
                const response2 = await fetchWithTimeout(API_SAVE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'rename_worker',
                        affectedTasks: clearedTasks
                    })
                });
                if (!response2.ok) throw new Error("배정 해제 오류");
            }

            if (activeWorkerName === name) activeWorkerName = null;

            showToast(`"${name}" 기사님이 삭제되었습니다.`);
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("삭제 중 문제가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 기사님 순서 변경 (목록 내에서 앞/뒤로 한 칸씩 이동)
    window.moveWorker = async function(name, dir) {
        if (!activeProjectCode) return;
        const existingWorkers = currentDetailData.workers || [];
        const idx = existingWorkers.indexOf(name);
        const newIdx = idx + dir;
        if (idx === -1 || newIdx < 0 || newIdx >= existingWorkers.length) return;

        const updatedWorkers = [...existingWorkers];
        [updatedWorkers[idx], updatedWorkers[newIdx]] = [updatedWorkers[newIdx], updatedWorkers[idx]];

        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_workers',
                    projectCode: activeProjectCode,
                    workersText: updatedWorkers.join(',')
                })
            });
            if (!response.ok) throw new Error("순서 변경 오류");

            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("순서 변경 중 문제가 발생했습니다.", "danger");
        }
    };
});
