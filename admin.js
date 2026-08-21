window.onerror = function(message, source, lineno, colno, error) {
    alert("브라우저 자바스크립트 오류 발생!\n내용: " + message + "\n위치: " + source + " (줄번호: " + lineno + ")");
    return false;
};

document.addEventListener('DOMContentLoaded', async () => {

    // 0. 관리자 암호 잠금 (간단한 접근 차단용 - 강력한 보안은 아니고, 평문 대신 해시로만 비교)
    const ADMIN_PIN_HASH = '7e25b45addda2b4082938558981200dfe5a3cfb20ee4a81092510d26715c2049';
    const ADMIN_UNLOCK_KEY = 'adminUnlocked';

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
                localStorage.setItem(ADMIN_UNLOCK_KEY, '1');
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
        window.location.href = window.location.pathname + '?_r=' + Date.now();
    };

    // 1. 설정 및 글로벌 변수
    const n8nBase = "https://primary-production-a6fa.up.railway.app";
    const API_ADMIN_GET_URL = `${n8nBase}/webhook/film-admin-get`;
    const API_DETAIL_URL = `${n8nBase}/webhook/film-quality-get`;
    const API_SAVE_URL = `${n8nBase}/webhook/film-quality-save`;
    const API_PUBLISH_URL = `${n8nBase}/webhook/film-blog-publish`;
    const API_JOURNAL_CREATE_URL = `${n8nBase}/webhook/film-journal-create`;
    const API_JOURNAL_LIST_URL = `${n8nBase}/webhook/film-journal-list`;
    const API_JOURNAL_PHOTO_URL = `${n8nBase}/webhook/film-journal-photo-upload`;
    const API_SAMPLE_PHOTO_URL = `${n8nBase}/webhook/film-sample-photo-upload`;
    const API_SAMPLE_PHOTO_DELETE_URL = `${n8nBase}/webhook/film-sample-photo-delete`;
    const WORKER_APP_BASE_URL = "https://jayunsu22.github.io/autoblog/index.html"; // 기사님용 워커 앱 배포 주소
    const GALLERY_APP_BASE_URL = "https://jayunsu22.github.io/autoblog/gallery.html"; // 외부 공유용 사진 갤러리(읽기 전용) 배포 주소
    const ZONE_ORDER = ['방1', '방2', '방3', '방4', '방5', '거실', '주방', '현관', '기타']; // 구역은 이 9개로 고정


    let activeProjectCode = "";
    let currentDetailData = null; // 상세 현장 데이터 캐시
    let draggedData = null; // HTML5 드래그 중 임시 저장 공간
    let activeZoneTab = null; // 품목 배정 매트릭스에서 현재 선택된 구역 탭
    let zonePendingChanges = new Map(); // 매트릭스에서 저장 버튼을 누르기 전까지 쌓아두는 변경사항: 품목명 -> { active?, 밑작업?, 시공? }
    let activeWorkerName = null; // 배정 보드에서 현재 선택된(활성화된) 기사님 이름, 새로고침에도 유지됨
    let globalProjectList = []; // 현장 목록 전체 캐시 (보관함 보기 토글 시 재요청 없이 필터링)
    const projectProgressCache = new Map(); // recordId -> {done, total} | 'loading' | 'error' (카드별 진행률, 중복 조회 방지용 캐시)
    let showArchivedProjects = false; // false: 활성 현장만 표시, true: 보관된 현장만 표시
    let galleryAllPhotos = []; // 사진 갤러리 모달에 로드된 전체 사진 [{url, 구역, 품목명}]
    let galleryActiveZone = '전체'; // 사진 갤러리에서 현재 선택된 구역 탭
    let galleryFilteredPhotos = []; // 현재 탭 필터링된 사진 목록 (라이트박스 이전/다음 탐색 기준)
    let galleryLightboxIndex = -1; // 라이트박스에서 현재 보고 있는 사진의 인덱스
    let galleryTouchStartX = null; // 스와이프 제스처 시작 X좌표
    let galleryWasSwipe = false; // 방금 제스처가 스와이프였는지 (탭-닫기와 구분용)
    let galleryActiveRecordId = null; // 현재 갤러리 모달에 열려 있는 현장의 레코드ID (공유 링크 생성용)

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
        loadProjectList().then(() => {
            const lastProjectCode = localStorage.getItem('lastActiveProjectCode');
            if (lastProjectCode) {
                showProjectDetail(lastProjectCode);
            }
        });
    }

    // 암호로 이미 인증된 상태면 바로 시작, 아니면 암호 입력창을 띄우고 성공 시 시작
    if (localStorage.getItem(ADMIN_UNLOCK_KEY) === '1') {
        runAdminInit();
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

        // 최신(나중에 등록된) 현장이 위로 오도록 시공일자 내림차순 정렬
        const sortedProjects = [...projects].sort((a, b) => {
            const fieldsA = a.fields ? a.fields : a;
            const fieldsB = b.fields ? b.fields : b;
            const dateA = fieldsA.시공일자 || "";
            const dateB = fieldsB.시공일자 || "";
            return dateB.localeCompare(dateA);
        });

        sortedProjects.forEach(project => {
            // Airtable 노드 버전에 따라 fields 주머니가 있을 수도, 없을 수도 있으므로 유연하게 자동 감지합니다.
            const fields = project.fields ? project.fields : project;
            const recordId = project.id;


            const card = document.createElement('div');
            card.className = 'project-card';
            card.addEventListener('click', () => showProjectDetail(recordId));

            const workersText = fields.시공기사 || "미정";
            const archiveBtnHtml = showArchivedProjects
                ? `<button class="card-btn secondary" onclick="event.stopPropagation(); toggleProjectArchive('${recordId}', false)">📤 보관 해제</button>`
                : `<button class="card-btn secondary" onclick="event.stopPropagation(); toggleProjectArchive('${recordId}', true)">📦 보관</button>`;

            card.innerHTML = `
                <div class="card-header-info">
                    <span class="card-date-badge">🗓️ ${fields.시공일자 || '미지정'}</span>
                    <h3 class="card-title">${fields.현장명 || '이름 없는 현장'}</h3>
                    <div class="card-address">📍 ${fields.주소 || '주소 미지정'}</div>
                     <div class="card-workers">👷 기사: ${workersText}</div>
                    <div class="card-progress" id="progress-${recordId}"></div>
                </div>
                <div class="card-footer-btns">
                    <button class="card-btn secondary" onclick="event.stopPropagation(); openProjectPhotoGallery('${recordId}', '${(fields.현장명 || '').replace(/'/g, "\\'")}')">📷 사진</button>
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

    // 현장 사진 갤러리: 시공 완료된 사진만 모아서 구역별로 훑어볼 수 있게 보여줌 (예전 현장 기억 안 날 때 용도)
    window.openProjectPhotoGallery = async function(recordId, projectName) {
        galleryActiveRecordId = recordId;
        document.getElementById('galleryModalTitle').textContent = `📷 ${projectName || '현장'} 사진`;
        document.getElementById('photoGalleryModal').style.display = 'flex';
        document.getElementById('galleryZoneTabs').innerHTML = '';
        document.getElementById('galleryPhotoGrid').innerHTML = `<div class="empty-state">사진을 불러오는 중...</div>`;

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

            const photos = [];
            (data.tasks || []).forEach(task => {
                const fields = task.fields || {};
                if (!fields.시공완료) return; // 시공이 완료된 작업의 사진만 모음 (밑작업 사진은 제외)
                const zone = zoneByItem[fields.시공품목] || '기타';
                (fields.시공후사진 || []).forEach(photo => {
                    if (isValidPhoto(photo)) {
                        photos.push({ url: photo.url, 구역: zone, 품목명: fields.시공품목 || '' });
                    }
                });
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
    };

    // 편집 기능 없이 사진만 보이는 외부 공유용 갤러리 링크 복사 (인테리어 업자 등에게 전달용)
    window.copyGalleryShareLink = function() {
        if (!galleryActiveRecordId) return;
        copyLink(`${GALLERY_APP_BASE_URL}?code=${galleryActiveRecordId}`);
    };

    // 사진에 찍힌 구역들만, ZONE_ORDER 순서대로 탭으로 노출 ("전체" 탭이 항상 맨 앞)
    function renderGalleryZoneTabs() {
        const container = document.getElementById('galleryZoneTabs');
        const zonesPresent = ZONE_ORDER.filter(zone => galleryAllPhotos.some(p => p.구역 === zone));
        const tabs = ['전체', ...zonesPresent];

        container.innerHTML = tabs.map(zone => {
            const count = zone === '전체' ? galleryAllPhotos.length : galleryAllPhotos.filter(p => p.구역 === zone).length;
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
        const photos = galleryActiveZone === '전체'
            ? galleryAllPhotos
            : galleryAllPhotos.filter(p => p.구역 === galleryActiveZone);

        galleryFilteredPhotos = photos; // 라이트박스 이전/다음 탐색은 지금 보이는(필터링된) 목록 기준

        if (photos.length === 0) {
            grid.innerHTML = `<div class="empty-state">시공 완료된 사진이 아직 없습니다.</div>`;
            return;
        }

        // 사진마다 어느 구역/품목인지 캡션으로 함께 표시 ("전체" 탭에서도 구분 가능하게)
        grid.innerHTML = photos.map((p, idx) => `
            <div class="gallery-photo-tile" onclick="openGalleryLightbox(${idx})">
                <img src="${p.url}" alt="${p.품목명}" loading="lazy">
                <div class="gallery-photo-caption">${p.구역} · ${p.품목명}</div>
            </div>
        `).join('');
    }

    window.openGalleryLightbox = function(index) {
        galleryLightboxIndex = index;
        showGalleryLightboxPhoto();
        document.getElementById('galleryLightbox').style.display = 'flex';
    };

    function showGalleryLightboxPhoto() {
        const photo = galleryFilteredPhotos[galleryLightboxIndex];
        if (!photo) return;
        document.getElementById('galleryLightboxImg').src = photo.url;
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

    window.copyWorkerLink = function() {
        if (activeProjectCode) {
            copyLink(`${WORKER_APP_BASE_URL}?code=${activeProjectCode}`);
        }
    };

    window.openWorkerLink = function() {
        if (activeProjectCode) {
            window.open(`${WORKER_APP_BASE_URL}?code=${activeProjectCode}`, '_blank');
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
    async function showProjectDetail(recordId) {
        if (recordId !== activeProjectCode) {
            // 다른 현장으로 이동하는 경우에만 이전 현장의 선택/배정 상태를 초기화
            activeWorkerName = null;
            activeZoneTab = null;
            zonePendingChanges.clear();
        }
        activeProjectCode = recordId;
        showLoading("현장 상세 정보를 불러오는 중...");
        try {
            const response = await fetchWithTimeout(`${API_DETAIL_URL}?code=${recordId}`);
            if (!response.ok) throw new Error("상세조회 실패");
            
            const result = await response.json();
            // n8n은 데이터를 리턴할 때 항상 배열 [ { ... } ] 형태로 감싸서 주므로, 첫 번째 원소를 꺼내줍니다.
            currentDetailData = Array.isArray(result) ? result[0] : result;

            // 방금 받아온 최신 작업 현황으로 현장 목록 카드의 진행률 캐시도 같이 갱신
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
            
            renderDetailSection();
            showSection('projectDetailSection');
            // 마지막으로 보던 현장을 기억해뒀다가, 앱을 다시 열면 이 현장 화면으로 바로 복귀
            localStorage.setItem('lastActiveProjectCode', recordId);
        } catch (error) {
            console.error(error);
            showToast("현장 데이터를 불러오지 못했습니다.", "danger");
            localStorage.removeItem('lastActiveProjectCode');
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
        detailProjectTitle.textContent = p.현장명;
        detailProjectDate.textContent = `시공일: ${p.시공일자 || '미정'}`;

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

        const zoneMap = new Map();
        ZONE_ORDER.forEach(zone => zoneMap.set(zone, []));
        allItems.forEach(item => {
            const zone = ZONE_ORDER.includes(item.구역) ? item.구역 : "기타";
            zoneMap.get(zone).push(item);
        });

        const zoneNames = ZONE_ORDER;

        // 구역 상관없이 활성화됐지만 밑작업+시공이 둘 다 안 끝난 품목만 모음 - "미완료" 탭용
        const incompleteEntries = [];
        allItems.forEach(item => {
            const zone = ZONE_ORDER.includes(item.구역) ? item.구역 : "기타";
            const isActive = activeItems.includes(item.품목명);
            if (!isActive) return;
            const task = tasks.find(t => t.fields.시공품목 === item.품목명);
            if (!task) return;
            const isFullyCompleted = !!(task.fields.밑작업완료 && task.fields.시공완료);
            if (!isFullyCompleted) incompleteEntries.push({ item, task, zone });
        });

        if (!activeZoneTab || (activeZoneTab !== INCOMPLETE_TAB && !zoneMap.has(activeZoneTab))) {
            activeZoneTab = zoneNames[0] || null;
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

        const itemsInZone = [...(zoneMap.get(activeZoneTab) || [])];
        itemsInZone.sort((a, b) => {
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
        const pending = zonePendingChanges.get(itemName) || {};
        const effectiveActive = pending.active !== undefined ? pending.active : isActive;
        const effectivePrep = pending.밑작업 !== undefined ? pending.밑작업 : (fields.밑작업기사 || "");
        const effectiveWrap = pending.시공 !== undefined ? pending.시공 : (fields.시공기사 || "");
        const hasAnyAssignee = !!(effectivePrep || effectiveWrap);
        const isFullyCompleted = !!(fields.밑작업완료 && fields.시공완료);

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

        const assignWrap = document.createElement('div');
        assignWrap.className = 'zone-item-assign';
        assignWrap.appendChild(createZoneAssignSelect(itemName, '밑작업', effectivePrep, effectiveActive, fields, workers, isActive));
        assignWrap.appendChild(createZoneAssignSelect(itemName, '시공', effectiveWrap, effectiveActive, fields, workers, isActive));

        row.appendChild(toggleLabel);
        row.appendChild(nameSpan);
        row.appendChild(assignWrap);

        if (isFullyCompleted) {
            const badge = document.createElement('span');
            badge.className = 'zone-item-done-badge';
            badge.textContent = '✅';
            row.appendChild(badge);
        }

        return row;
    }

    function createZoneAssignSelect(itemName, stage, effectiveValue, effectiveActive, fields, workers, isActive) {
        const select = document.createElement('select');
        select.className = 'zone-assign-select';
        const isDone = isActive && !!(stage === '밑작업' ? fields.밑작업완료 : fields.시공완료);
        select.disabled = !effectiveActive || isDone;
        if (isDone) select.classList.add('done');

        let optionsHtml = `<option value="">${stage}</option>`;
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

    function updateZoneSaveToolbar() {
        const toolbar = document.getElementById('zoneSaveToolbar');
        const countEl = document.getElementById('zoneSaveCount');
        if (!toolbar || !countEl) return;
        const n = zonePendingChanges.size;
        if (n > 0) {
            toolbar.style.display = 'flex';
            countEl.textContent = `${n}개 품목 변경사항 대기 중`;
        } else {
            toolbar.style.display = 'none';
        }
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
            const assignPromises = [];
            entries.forEach(([itemName, change]) => {
                const task = tasks.find(t => t.fields.시공품목 === itemName);
                const recordId = newRecordIds[itemName] || (task && task.id);
                if (!recordId) return;

                ['밑작업', '시공'].forEach(stage => {
                    if (change[stage] === undefined) return;
                    const serverValue = task ? (task.fields[stage + '기사'] || "") : "";
                    if (change[stage] === serverValue) return;

                    const body = change[stage]
                        ? { type: 'assign_worker', projectCode: activeProjectCode, recordId: recordId, workerName: change[stage], stage: stage }
                        : { type: 'unassign_worker', projectCode: activeProjectCode, recordId: recordId, stage: stage };
                    assignPromises.push(
                        fetchWithTimeout(API_SAVE_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body)
                        }).then(res => { if (!res.ok) throw new Error(`${itemName} ${stage} 배정 실패`); })
                    );
                });
            });
            await Promise.all(assignPromises);

            showToast(`${entries.length}개 품목의 변경사항이 저장되었습니다!`);
            zonePendingChanges.clear();
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("일부 변경사항 저장에 실패했습니다. 다시 확인해 주세요.", "danger");
            zonePendingChanges.clear();
            await showProjectDetail(activeProjectCode);
        } finally {
            hideLoading();
        }
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
        
        // 밑작업/시공을 완전히 독립된 카드로 나열 - 같은 품목이어도 각자의 우선순위 필드로 따로 정렬됨
        // (밑작업을 몰아서 하고 시공은 나중에 하는 경우가 많아서, 둘을 묶어서 같이 옮기지 않음)
        const cardEntries = [];
        tasks.forEach(task => {
            const fields = task.fields;

            if (fields.밑작업기사 && (!filterWorkerName || fields.밑작업기사 === filterWorkerName)) {
                const priority = fields.작업우선순위 !== undefined ? fields.작업우선순위 : (savedOrder.indexOf(task.id) !== -1 ? savedOrder.indexOf(task.id) : 999);
                cardEntries.push({ task, stage: '밑작업', assignee: fields.밑작업기사, isCompleted: !!fields.밑작업완료, priority });
            }

            if (fields.시공기사 && (!filterWorkerName || fields.시공기사 === filterWorkerName)) {
                const priority = fields.시공우선순위 !== undefined ? fields.시공우선순위 : (fields.작업우선순위 !== undefined ? fields.작업우선순위 : (savedOrder.indexOf(task.id) !== -1 ? savedOrder.indexOf(task.id) : 999));
                cardEntries.push({ task, stage: '시공', assignee: fields.시공기사, isCompleted: !!fields.시공완료, priority });
            }
        });

        cardEntries.sort((a, b) => a.priority - b.priority);
        cardEntries.sort((a, b) => (a.isCompleted === b.isCompleted) ? 0 : (a.isCompleted ? 1 : -1));

        let count = 0;
        cardEntries.forEach(({ task, stage, assignee }) => {
            createAssignmentCard(task, stage, assignee);
            count++;
        });

        assignedCountBadge.textContent = `${count}개`;
        if (count === 0) {
            boardAssignmentList.innerHTML = `<div class="drag-placeholder">우측의 품목 카드를 이곳이나 왼쪽 기사 카드 위로 드래그하여 배정하세요.</div>`;
        }
    }
    function createAssignmentCard(task, stage, assigneeName) {
        const fields = task.fields;
        const recordId = task.id;
        const isCompleted = !!(stage === '밑작업' ? fields.밑작업완료 : fields.시공완료);

        const card = document.createElement('div');
        card.className = `assignment-card${isCompleted ? ' completed' : ''} ${stage === '밑작업' ? 'stage-prep' : 'stage-construction'}`;
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
        const statusBadgeHtml = `<span class="assignment-status-badge${isCompleted ? ' completed' : ''}">${isCompleted ? '✅ 완료됨' : '진행중'}</span>`;
        let headerHtml = `
            <div class="assignment-card-header" onclick="toggleAssignmentCardBody(event, this)" style="cursor: pointer;">
                <div style="display: flex; align-items: center; gap: 6px; user-select: none;">
                    ${assigneeBadgeHtml}
                    <span class="assigned-item-name">${fields.시공품목} (${stage})</span>
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

        // 2. 바디 (지침 목록 온오프 제어 - 기본적으로 숨김 처리 display: none;)
        const itemInfo = currentDetailData.items[fields.시공품목] || { 밑작업지침: "", 시공후점검지침: "" };
        const guidelinesText = stage === '밑작업' ? itemInfo.밑작업지침 : itemInfo.시공후점검지침;
        
        let bodyHtml = "";
        const excludedLines = (fields.제외된지침 || '').split('\n').map(s => s.trim()).filter(Boolean);
        const siteNoteValue = fields.현장특이사항 || '';

        bodyHtml += `<div class="assignment-card-body" style="display: none; padding-top: 10px;">`;

        if (guidelinesText) {
            const linesList = guidelinesText.split('\n').filter(l => l.trim() !== "" && !excludedLines.includes(l.trim()));
            const existingResults = fields.점검결과 || "";

            bodyHtml += `
                <h4 style="font-size: 11px; margin-bottom: 8px; color: #666;">💡 현장 품질 지침 토글 (체크된 사항만 기사에게 노출됨)</h4>
                <div class="assign-checkbox-list">
            `;

            const guidelineKind = stage === '밑작업' ? '밑작업지침' : '시공지침';
            linesList.forEach(line => {
                const cleanLine = line.trim();
                const isGuidelineActive = !existingResults || existingResults.includes(cleanLine);
                const escapedLine = cleanLine.replace(/'/g, "\\'");
                const sampleUrl = getSamplePhotoUrl(currentDetailData.samplePhotos, guidelineKind, fields.시공품목, cleanLine);
                const sampleThumbHtml = sampleUrl ? `<img src="${sampleUrl}" class="sample-photo-thumb" title="샘플사진">` : '';

                bodyHtml += `
                    <div class="assign-toggle-item ${isGuidelineActive ? 'active' : ''}">
                        <span onclick="toggleGuidelineItem('${recordId}', '${stage}', '${escapedLine}', ${isGuidelineActive})" style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer;">
                            <span class="toggle-dot"></span>
                            <span class="toggle-text">${cleanLine}</span>
                        </span>
                        ${sampleThumbHtml}
                        <button type="button" class="btn-exclude-guideline" title="이 현장에서만 이 지침 제외" onclick="event.stopPropagation(); excludeGuidelineLine('${recordId}', '${escapedLine}')">×</button>
                    </div>
                `;
            });

            bodyHtml += `</div>`;
        }

        bodyHtml += `
            <div class="site-note-box" style="margin-top: 14px;">
                <h4 style="font-size: 11px; margin-bottom: 8px; color: #666;">📝 이 현장의 이 품목만의 특이사항 (작업자에게 체크 항목으로 노출됨)</h4>
                <textarea id="siteNoteInput-${recordId}" rows="2" placeholder="예: 이 문틀은 이미 파손 이력 있음, 더 조심히 다뤄주세요" style="width: 100%; padding: 8px 10px; font-size: 13px; font-weight: 600; border: 1.5px solid var(--border-color); border-radius: 8px; resize: vertical; box-sizing: border-box;">${siteNoteValue}</textarea>
                <button type="button" onclick="saveSiteNote('${recordId}')" style="margin-top: 6px; padding: 6px 14px; font-size: 12.5px; font-weight: 800; background: var(--primary-blue); color: white; border: none; border-radius: 8px; cursor: pointer;">특이사항 저장</button>
            </div>
        `;

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
    // 같은 품목의 밑작업/시공 카드는 (동일 기사에게 배정된 경우) 작업자 화면에서 항상 붙어서
    // 나오므로, 레코드당 우선순위를 하나로 통일해서 저장 - 먼저 나오는 카드의 위치를 기준으로 함
    async function persistAssignmentOrder() {
        // 1. 배정표 내 카드 순서를 DOM 그대로 수집 - 밑작업/시공은 서로 독립된 카드라 각자 우선순위를 가짐
        const cards = [...boardAssignmentList.querySelectorAll('.assignment-card')];
        const allEntries = cards.map((c, idx) => ({ id: c.dataset.recordId, stage: c.dataset.stage, priority: idx + 1 }));

        // 실제로 순위가 바뀐 작업만 서버로 전송 (전체를 매번 다시 보내면 목록이 길 때 느리고 실패하기 쉬움)
        const reorderTasks = allEntries.filter(({ id, stage, priority }) => {
            const task = currentDetailData.tasks.find(t => t.id === id);
            if (!task) return true;
            const currentVal = stage === '밑작업' ? task.fields.작업우선순위 : task.fields.시공우선순위;
            return currentVal !== priority;
        });

        // 2. 임시 로컬 캐시에 정렬 순서 보관 (즉시 반영용)
        const sortOrderKey = `task_sort_order_${activeProjectCode}`;
        localStorage.setItem(sortOrderKey, JSON.stringify(allEntries.map(e => e.id)));

        // 3. 로컬 데이터에도 바로 반영해서 즉시 화면에 순서가 보이게 함
        allEntries.forEach(({ id, stage, priority }) => {
            const task = currentDetailData.tasks.find(t => t.id === id);
            if (!task) return;
            if (stage === '밑작업') task.fields.작업우선순위 = priority;
            else task.fields.시공우선순위 = priority;
        });

        if (reorderTasks.length === 0) {
            renderBoardAssignments();
            return;
        }

        showLoading("우선순위 순서 저장 중...");
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
            showToast("작업 우선순위 순서가 정상 저장되었습니다.");
        } catch (error) {
            console.warn(error);
            showToast("이 폰에는 순서가 반영됐지만, 서버 저장에 실패해서 다른 기기에는 안 보일 수 있습니다.", "danger");
        } finally {
            hideLoading();
            renderBoardAssignments();
        }
    }

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

    window.excludeGuidelineLine = async function(recordId, guidelineLine) {
        if (!confirm("이 지침을 이 현장의 이 작업에서만 제외할까요? (공통 지침 원본은 그대로 유지됩니다)")) return;
        showLoading("지침 제외 처리 중...");
        try {
            const task = (currentDetailData.tasks || []).find(t => t.id === recordId);
            const existingExcluded = (task && task.fields.제외된지침 || '').split('\n').map(s => s.trim()).filter(Boolean);
            if (!existingExcluded.includes(guidelineLine)) existingExcluded.push(guidelineLine);
            const excludedText = existingExcluded.join('\n');

            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'exclude_guideline_line',
                    projectCode: activeProjectCode,
                    recordId: recordId,
                    excludedText: excludedText
                })
            });

            if (!response.ok) throw new Error("지침 제외 실패");

            showToast("이 현장에서 해당 지침을 제외했습니다.");
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("지침 제외에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    window.saveSiteNote = async function(recordId) {
        const textarea = document.getElementById(`siteNoteInput-${recordId}`);
        const noteText = textarea ? textarea.value.trim() : "";
        showLoading("현장 특이사항 저장 중...");
        try {
            const response = await fetchWithTimeout(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'update_site_note',
                    projectCode: activeProjectCode,
                    recordId: recordId,
                    noteText: noteText
                })
            });

            if (!response.ok) throw new Error("특이사항 저장 실패");

            showToast("현장 특이사항이 저장되었습니다.");
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("특이사항 저장에 실패했습니다.", "danger");
        } finally {
            hideLoading();
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
                    sceneSaved: (f.현장사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ url: a.url, filename: a.filename })),
                    cleanupSaved: (f.정리정돈사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ url: a.url, filename: a.filename })),
                    filmSaved: (f.필름사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ url: a.url, filename: a.filename }))
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
    // 1) 이미 저장된 사진(읽기 전용) 2) 아직 업로드 안 된 사진(삭제 가능) 3) "사진 추가" 타일
    function renderJournalPhotoGrid(gridId, kind) {
        const d = dayDrafts[activeDayIndex];
        const savedKey = { scene: 'sceneSaved', cleanup: 'cleanupSaved', film: 'filmSaved' }[kind];
        const pendingKey = { scene: 'scenePending', cleanup: 'cleanupPending', film: 'filmPending' }[kind];
        const saved = d[savedKey];
        const pending = d[pendingKey];
        const grid = document.getElementById(gridId);
        grid.innerHTML = "";

        saved.forEach(photo => {
            const tile = document.createElement('div');
            tile.className = 'journal-photo-tile has-image';
            tile.innerHTML = `<img src="${photo.url}" class="journal-photo-preview" alt="사진">`;
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

    function triggerJournalPhotoPick(kind, gridId) {
        const oldInput = document.getElementById('tempJournalFileInput');
        if (oldInput) oldInput.remove();

        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'tempJournalFileInput';
        input.accept = 'image/*';
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
                    savedList.push({ url: URL.createObjectURL(file), filename: file.name });
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

    function renderItemConfigList() {
        const container = document.getElementById('itemConfigBody');
        if (!globalMasterItems || globalMasterItems.length === 0) {
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
        const CATEGORY_ORDER = ['문+틀', '샤시', '가구', '몰딩', '기타'];
        const sortedCategoryEntries = Array.from(categoryGroups.entries()).sort((a, b) => {
            const rankA = CATEGORY_ORDER.indexOf(a[0]) === -1 ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(a[0]);
            const rankB = CATEGORY_ORDER.indexOf(b[0]) === -1 ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(b[0]);
            return rankA - rankB;
        });

        let html = "";
        sortedCategoryEntries.forEach(([category, indices]) => {
            html += `<h3 class="item-config-category-heading">${category} (${indices.length})</h3>`;
            indices.forEach(idx => {
                const item = globalMasterItems[idx];
                html += `
                    <div class="item-config-card" data-item-idx="${idx}">
                        <div class="item-config-card-header" onclick="openItemEditModal(${idx})">
                            <h4>📦 ${item.품목명}</h4>
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
        document.getElementById('itemEditZoneInput').value = ZONE_ORDER.includes(item.구역) ? item.구역 : '기타';
        document.getElementById('itemEditPrepInput').value = item.밑작업지침 || '';
        document.getElementById('itemEditInspInput').value = item.시공후점검지침 || '';
        editingItemSlots = (item.필수사진슬롯 || '').split(',').map(s => s.trim()).filter(s => s !== '');
        renderItemEditSlotTags();
        document.getElementById('itemEditModal').style.display = 'flex';
    };

    window.openNewItemModal = function() {
        editingItemIdx = null;
        document.getElementById('itemEditModalTitle').textContent = '➕ 새 시공품목 추가';
        document.getElementById('itemEditNameInput').value = '';
        document.getElementById('itemEditCategoryInput').value = '문+틀';
        document.getElementById('itemEditZoneInput').value = '기타';
        document.getElementById('itemEditPrepInput').value = '';
        document.getElementById('itemEditInspInput').value = '';
        editingItemSlots = [];
        renderItemEditSlotTags();
        document.getElementById('itemEditModal').style.display = 'flex';
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
        const zoneText = document.getElementById('itemEditZoneInput').value.trim();
        const prepText = document.getElementById('itemEditPrepInput').value;
        const inspText = document.getElementById('itemEditInspInput').value;
        const slotsText = editingItemSlots.join(',');

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
                    필수사진슬롯: slotsText
                }
                : {
                    type: 'update_item',
                    recordId: globalMasterItems[idx].id,
                    품목명: nameText,
                    카테고리: categoryText,
                    구역: zoneText,
                    밑작업지침: prepText,
                    시공후점검지침: inspText,
                    필수사진슬롯: slotsText
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
                showToast(`${nameText} 품목 설정이 저장되었습니다!`);
            }

            closeItemEditModal();
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
