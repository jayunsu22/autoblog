window.onerror = function(message, source, lineno, colno, error) {
    alert("브라우저 자바스크립트 오류 발생!\n내용: " + message + "\n위치: " + source + " (줄번호: " + lineno + ")");
    return false;
};

document.addEventListener('DOMContentLoaded', async () => {

    // 1. 설정 및 글로벌 변수
    const n8nBase = "https://primary-production-a6fa.up.railway.app";
    const API_ADMIN_GET_URL = `${n8nBase}/webhook/film-admin-get`;
    const API_DETAIL_URL = `${n8nBase}/webhook/film-quality-get`;
    const API_SAVE_URL = `${n8nBase}/webhook/film-quality-save`;
    const API_PUBLISH_URL = `${n8nBase}/webhook/film-blog-publish`;
    const API_JOURNAL_CREATE_URL = `${n8nBase}/webhook/film-journal-create`;
    const API_JOURNAL_LIST_URL = `${n8nBase}/webhook/film-journal-list`;
    const API_JOURNAL_PHOTO_URL = `${n8nBase}/webhook/film-journal-photo-upload`;
    const WORKER_APP_BASE_URL = "https://jayunsu22.github.io/autoblog/index.html"; // 기사님용 워커 앱 배포 주소
    const ZONE_ORDER = ['방1', '방2', '방3', '방4', '방5', '거실', '주방', '현관', '기타']; // 구역은 이 9개로 고정


    let activeProjectCode = "";
    let currentDetailData = null; // 상세 현장 데이터 캐시
    let draggedData = null; // HTML5 드래그 중 임시 저장 공간
    let activeZoneTab = null; // 품목 배정 매트릭스에서 현재 선택된 구역 탭
    let zonePendingChanges = new Map(); // 매트릭스에서 저장 버튼을 누르기 전까지 쌓아두는 변경사항: 품목명 -> { active?, 밑작업?, 시공? }
    let activeWorkerName = null; // 배정 보드에서 현재 선택된(활성화된) 기사님 이름, 새로고침에도 유지됨

    // 현장일지 탭 상태
    let dayDrafts = []; // { dayNumber, journalId, published, title, feature, episode, sceneFiles[], cleanupFiles[] }
    let activeDayIndex = 0;
    let taskAssignment = {}; // taskId -> dayNumber
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

    function showToast(message, type = 'success') {
        toast.textContent = message;
        toast.className = `toast show ${type}`;
        setTimeout(() => { toast.className = 'toast'; }, 3000);
    }

    // 전역 함수 노출
    window.goHome = function() {
        activeProjectCode = "";
        currentDetailData = null;
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

    // 4. 초기화 실행: 현장 리스트 로딩
    loadProjectList();


    // 5. 현장 목록 및 자주쓰는공지 불러오기
    let globalQuickNotices = [];
    let globalMasterItems = [];

    async function loadProjectList() {
        showLoading("현장 목록을 조회하는 중...");
        try {
            const response = await fetch(`${API_ADMIN_GET_URL}?_t=${Date.now()}`, {
                cache: "no-store"
            });
            if (!response.ok) throw new Error("서버에서 목록 로드 실패");

            let data = await response.json();
            if (Array.isArray(data)) {
                data = data[0] || {};
            }

            // 프로젝트 카드 그리드 렌더링
            renderProjectGrid(data.projects);
            
            // 자주 쓰는 공지사항 칩 렌더링
            renderNoticeQuickTags(data.quickNotices);

            // 시공품목 마스터 데이터 캐싱
            globalMasterItems = data.masterItems || [];

        } catch (error) {
            console.error(error);
            showToast("현장 목록을 불러오지 못했습니다.", "danger");
        } finally {
            hideLoading();
        }
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
            const response = await fetch("https://primary-production-a6fa.up.railway.app/webhook/film-notice-create", {
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


    function renderProjectGrid(projects) {
        projectGrid.innerHTML = "";

        if (!projects || projects.length === 0) {
            projectGrid.innerHTML = `<div class="empty-state">진행 중인 현장이 없습니다. 새 현장을 개설해 주세요.</div>`;
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

            card.innerHTML = `
                <div class="card-header-info">
                    <span class="card-date-badge">🗓️ ${fields.시공일자 || '미지정'}</span>
                    <h3 class="card-title">${fields.현장명 || '이름 없는 현장'}</h3>
                    <div class="card-address">📍 ${fields.주소 || '주소 미지정'}</div>
                     <div class="card-workers">👷 기사: ${workersText}</div>
                </div>
                <div class="card-footer-btns">
                    <button class="card-btn secondary" onclick="event.stopPropagation(); copyLink('${WORKER_APP_BASE_URL}?code=${recordId}')">🔗 기사 링크 복사</button>
                    <button class="card-btn primary">업무배정 ▶</button>
                </div>
            `;
            projectGrid.appendChild(card);
        });
    }

    // 링크 복사 클립보드 기능
    window.copyLink = function(url) {
        if (!url) {
            showToast("링크 주소가 존재하지 않습니다.", "danger");
            return;
        }
        navigator.clipboard.writeText(url).then(() => {
            showToast("기사님 접속 링크가 클립보드에 복사되었습니다!");
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
            const response = await fetch(API_SAVE_URL, {
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
            loadProjectList(); // 목록 리로드
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
            const response = await fetch(`${API_DETAIL_URL}?code=${recordId}`);
            if (!response.ok) throw new Error("상세조회 실패");
            
            const result = await response.json();
            // n8n은 데이터를 리턴할 때 항상 배열 [ { ... } ] 형태로 감싸서 주므로, 첫 번째 원소를 꺼내줍니다.
            currentDetailData = Array.isArray(result) ? result[0] : result;
            
            // 상세 화면 첫 진입 시 첫 번째 기사님을 자동으로 선택하여 배정표가 바로 열리도록 설정
            if (!activeWorkerName && currentDetailData.workers && currentDetailData.workers.length > 0) {
                activeWorkerName = currentDetailData.workers[0];
            }
            
            renderDetailSection();
            showSection('projectDetailSection');
        } catch (error) {
            console.error(error);
            showToast("현장 데이터를 불러오지 못했습니다.", "danger");
        } finally {
            hideLoading();
        }
    }

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

        // 1. 3분할 보드 - 1열 (시공기사 목록) 렌더링
        renderBoardWorkers();

        // 2. 3분할 보드 - 3열 (구역별 품목 활성화 + 기사 배정 매트릭스) 렌더링
        renderZoneAssignBoard();

        // 3. 3분할 보드 - 2열 (배정 내역 리스트) 렌더링
        renderBoardAssignments();
    }

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

        if (!activeZoneTab || !zoneMap.has(activeZoneTab)) {
            activeZoneTab = zoneNames[0] || null;
        }

        zoneAssignTabs.innerHTML = "";
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

        const itemsInZone = [...(zoneMap.get(activeZoneTab) || [])];
        itemsInZone.sort((a, b) => {
            const pA = a.우선순위 !== undefined ? a.우선순위 : 999;
            const pB = b.우선순위 !== undefined ? b.우선순위 : 999;
            if (pA !== pB) return pA - pB;
            return (a.품목명 || "").localeCompare(b.품목명 || "");
        });

        zoneItemCountBadge.textContent = `${itemsInZone.length}개`;

        zoneAssignItemList.innerHTML = "";
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

    function createZoneItemRow(item, isActive, task, workers) {
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
        nameSpan.textContent = itemName;

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
                    const res = await fetch(API_SAVE_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'toggle_item_create', projectCode: activeProjectCode, itemName: itemName })
                    });
                    if (!res.ok) throw new Error(`${itemName} 활성화 실패`);
                    const data = await res.json().catch(() => null);
                    const rec = Array.isArray(data) ? data[0] : data;
                    if (rec && rec.id) newRecordIds[itemName] = rec.id;
                } else {
                    const res = await fetch(API_SAVE_URL, {
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
                        fetch(API_SAVE_URL, {
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

        workers.forEach(worker => {
            const card = document.createElement('div');
            card.className = `worker-card ${worker === activeWorkerName ? 'active' : ''}`;
            card.textContent = worker;

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
        
        // 태스크들을 우선순위(또는 로컬 정렬 인덱스) 기준 정렬
        tasks.sort((a, b) => {
            const pA = a.fields.우선순위 !== undefined ? a.fields.우선순위 : (savedOrder.indexOf(a.id) !== -1 ? savedOrder.indexOf(a.id) : 999);
            const pB = b.fields.우선순위 !== undefined ? b.fields.우선순위 : (savedOrder.indexOf(b.id) !== -1 ? savedOrder.indexOf(b.id) : 999);
            return pA - pB;
        });

        // 우선순위 순서는 유지하되, 밑작업/시공을 독립된 카드로 나열한 뒤
        // 완료된 카드를 맨 아래로 내려서 다음에 배정할 작업을 한눈에 보이게 함
        const cardEntries = [];
        tasks.forEach(task => {
            const fields = task.fields;

            if (fields.밑작업기사 && (!filterWorkerName || fields.밑작업기사 === filterWorkerName)) {
                cardEntries.push({ task, stage: '밑작업', assignee: fields.밑작업기사, isCompleted: !!fields.밑작업완료 });
            }

            if (fields.시공기사 && (!filterWorkerName || fields.시공기사 === filterWorkerName)) {
                cardEntries.push({ task, stage: '시공', assignee: fields.시공기사, isCompleted: !!fields.시공완료 });
            }
        });

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
        card.className = `assignment-card${isCompleted ? ' completed' : ''}`;
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

            linesList.forEach(line => {
                const cleanLine = line.trim();
                const isGuidelineActive = !existingResults || existingResults.includes(cleanLine);
                const escapedLine = cleanLine.replace(/'/g, "\\'");

                bodyHtml += `
                    <div class="assign-toggle-item ${isGuidelineActive ? 'active' : ''}">
                        <span onclick="toggleGuidelineItem('${recordId}', '${stage}', '${escapedLine}', ${isGuidelineActive})" style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer;">
                            <span class="toggle-dot"></span>
                            <span class="toggle-text">${cleanLine}</span>
                        </span>
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
        // 1. 배정표 내에 정렬된 카드들 순서 수집, 레코드 ID별로 첫 등장 위치만 채택
        const cards = [...boardAssignmentList.querySelectorAll('.assignment-card')];
        const priorityByRecordId = new Map();
        cards.forEach((c) => {
            const id = c.dataset.recordId;
            if (!priorityByRecordId.has(id)) {
                priorityByRecordId.set(id, priorityByRecordId.size + 1);
            }
        });
        const orderIds = Array.from(priorityByRecordId.keys());
        const reorderTasks = orderIds.map(id => ({ id, priority: priorityByRecordId.get(id) }));

        // 2. 임시 로컬 캐시에 정렬 순서 보관 (즉시 반영용)
        const sortOrderKey = `task_sort_order_${activeProjectCode}`;
        localStorage.setItem(sortOrderKey, JSON.stringify(orderIds));

        // 3. 로컬 데이터에도 바로 반영해서, 같은 품목의 두 카드가 화면에서 즉시 붙어 보이게 함
        reorderTasks.forEach(({ id, priority }) => {
            const task = currentDetailData.tasks.find(t => t.id === id);
            if (task) task.fields.우선순위 = priority;
        });

        showLoading("우선순위 순서 저장 중...");
        try {
            const response = await fetch(API_SAVE_URL, {
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
            showToast("순서 저장 성공 (에어테이블 '우선순위' 숫자 필드를 개설하시면 서버에 완벽 저장됩니다!)", "warning");
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

    // ▲▼ 버튼으로 바로 위/아래 "품목 그룹"과 순서 교체
    // 같은 품목의 밑작업/시공 카드는 항상 붙어 다녀야 하므로(작업자 화면과 순서를 맞추기 위해),
    // 클릭한 카드 하나만 옮기지 않고 그 품목의 카드 전체를 한 덩어리로 이웃 품목과 맞바꿈
    window.moveAssignmentCard = async function(recordId, stage, direction) {
        const allCards = Array.from(boardAssignmentList.querySelectorAll('.assignment-card'));
        const myCards = allCards.filter(c => c.dataset.recordId === recordId);
        if (myCards.length === 0) return;

        if (direction === 'up') {
            const firstIdx = allCards.indexOf(myCards[0]);
            let neighbor = null;
            for (let i = firstIdx - 1; i >= 0; i--) {
                if (allCards[i].dataset.recordId !== recordId) { neighbor = allCards[i]; break; }
            }
            if (!neighbor) return;
            const neighborGroup = allCards.filter(c => c.dataset.recordId === neighbor.dataset.recordId);
            myCards.forEach(c => boardAssignmentList.insertBefore(c, neighborGroup[0]));
        } else {
            const lastIdx = allCards.lastIndexOf(myCards[myCards.length - 1]);
            let neighbor = null;
            for (let i = lastIdx + 1; i < allCards.length; i++) {
                if (allCards[i].dataset.recordId !== recordId) { neighbor = allCards[i]; break; }
            }
            if (!neighbor) return;
            const neighborGroup = allCards.filter(c => c.dataset.recordId === neighbor.dataset.recordId);
            const anchorAfter = neighborGroup[neighborGroup.length - 1].nextElementSibling;
            myCards.forEach(c => boardAssignmentList.insertBefore(c, anchorAfter));
        }

        await persistAssignmentOrder();
    };

    // 기사 배정 실행
    // 배정 요청 1건만 서버로 전송 (로딩/토스트/새로고침은 호출부에서 관리 - 단건/일괄 배정 공용)
    async function postAssignWorker(recordId, workerName, stage) {
        const response = await fetch(API_SAVE_URL, {
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
            const response = await fetch(API_SAVE_URL, {
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
            const response = await fetch(API_SAVE_URL, {
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

            const response = await fetch(API_SAVE_URL, {
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
            const response = await fetch(API_SAVE_URL, {
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
        activeDayIndex = 0;

        // 기존에 저장된 (아직 발행 전이거나 이미 발행된) 일지가 있으면 해당 일차 슬롯에 병합
        try {
            const res = await fetch(`${API_JOURNAL_LIST_URL}?projectCode=${encodeURIComponent(activeProjectCode)}`);
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

    function renderTaskChecklist() {
        publishTaskList.innerHTML = "";
        const currentDay = dayDrafts[activeDayIndex].dayNumber;

        eligibleTasksCache.forEach(task => {
            const fields = task.fields;
            const assignedDay = taskAssignment[task.id];
            const item = document.createElement('div');
            item.className = 'publish-item';
            item.dataset.recordId = task.id;

            if (assignedDay && assignedDay !== currentDay) {
                item.style.opacity = '0.4';
                item.innerHTML = `
                    <input type="checkbox" disabled style="width: 16px; height: 16px; flex-shrink:0;">
                    <span style="font-size: 14px; font-weight:800; color:var(--text-main); margin-left: 8px;">
                        ${fields.시공품목} (${assignedDay}일차에 배정됨)
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
            `;

            const chk = item.querySelector('input');
            const applyToggle = () => {
                if (chk.checked) {
                    taskAssignment[task.id] = currentDay;
                } else {
                    delete taskAssignment[task.id];
                }
                item.classList.toggle('checked', chk.checked);
            };
            chk.addEventListener('change', applyToggle);
            item.addEventListener('click', () => {
                chk.checked = !chk.checked;
                applyToggle();
            });

            publishTaskList.appendChild(item);
        });
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
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

    async function uploadSingleJournalPhoto(journalId, file, fieldName) {
        const resizedFile = await resizeImageFile(file);
        const base64 = await fileToBase64(resizedFile);
        const res = await fetch(API_JOURNAL_PHOTO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                journalId,
                fieldName,
                filename: resizedFile.name,
                contentType: resizedFile.type || 'image/jpeg',
                fileBase64: base64
            })
        });
        if (!res.ok) throw new Error("사진 업로드 실패: " + file.name);
    }

    // 일지제목/날씨/특징/에피소드를 Airtable에 저장하고, 아직 업로드 안 된 사진들을 업로드.
    // 임시저장과 실제 발행이 공통으로 쓰는 부분 - 이 함수가 끝나면 창을 닫고 다시 들어와도 내용/사진이 남아있음.
    async function persistJournalDayDraft(d) {
        const res = await fetch(API_JOURNAL_CREATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                journalId: d.journalId || undefined,
                projectCode: activeProjectCode,
                일지제목: d.title,
                일차: d.dayNumber,
                오늘의날씨: d.weather,
                현장의특징: d.feature,
                오늘의에피소드: d.episode
            })
        });
        if (!res.ok) throw new Error("일지 저장 실패");
        if (!d.journalId) {
            const created = await res.json();
            const rec = Array.isArray(created) ? created[0] : created;
            d.journalId = rec.id;
        }
        const journalId = d.journalId;

        for (const file of d.scenePending) {
            await uploadSingleJournalPhoto(journalId, file, '현장사진');
            d.sceneSaved.push({ url: URL.createObjectURL(file), filename: file.name });
        }
        d.scenePending = [];
        for (const file of d.cleanupPending) {
            await uploadSingleJournalPhoto(journalId, file, '정리정돈사진');
            d.cleanupSaved.push({ url: URL.createObjectURL(file), filename: file.name });
        }
        d.cleanupPending = [];
        for (const file of d.filmPending) {
            await uploadSingleJournalPhoto(journalId, file, '필름사진');
            d.filmSaved.push({ url: URL.createObjectURL(file), filename: file.name });
        }
        d.filmPending = [];

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

        const taskIds = Object.keys(taskAssignment).filter(id => taskAssignment[id] === d.dayNumber);
        if (taskIds.length === 0) {
            showToast("포함할 시공 내역을 최소 1개 이상 선택해주세요.", "danger");
            return;
        }

        const wasAlreadyPublished = d.published;
        showLoading(wasAlreadyPublished ? `${d.dayNumber}일차 재발행 중...` : `${d.dayNumber}일차 자료 생성 중...`);
        try {
            const journalId = await persistJournalDayDraft(d);

            const pubRes = await fetch(API_PUBLISH_URL, {
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

            const response = await fetch(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) throw new Error('저장 실패');

            if (isCreate) {
                showToast(`${nameText} 품목이 성공적으로 등록되었습니다!`);
                await loadProjectList();
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
            const response = await fetch(API_SAVE_URL, {
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
            const response = await fetch(API_SAVE_URL, {
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
});
