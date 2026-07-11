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


    let activeProjectCode = "";
    let currentDetailData = null; // 상세 현장 데이터 캐시
    let draggedData = null; // HTML5 드래그 중 임시 저장 공간
    let activeItemCategory = null; // 현장 시공품목 설정 탭에서 현재 선택된 카테고리
    let pendingItemToggles = new Map(); // 품목명 -> true(추가예정)/false(제외예정), 일괄 적용 전 임시 상태
    let activeWorkerName = null; // 배정 보드에서 현재 선택된(활성화된) 기사님 이름, 새로고침에도 유지됨
    let selectedItemIds = new Set(); // 미배정 작업 일괄 배정을 위해 선택된 `${recordId}|${stage}` 키 목록

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
    const itemCheckboxGroup = document.getElementById('itemCheckboxGroup');
    const itemCategoryTabs = document.getElementById('itemCategoryTabs');
    const boardWorkerList = document.getElementById('boardWorkerList');
    const boardAssignmentList = document.getElementById('boardAssignmentList');
    const boardAvailableItems = document.getElementById('boardAvailableItems');
    const workerCountBadge = document.getElementById('workerCountBadge');
    const assignedCountBadge = document.getElementById('assignedCountBadge');
    const availableCountBadge = document.getElementById('availableCountBadge');
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
        
        // 자주 쓰는 공지 칩 active 상태 초기화
        document.querySelectorAll('.notice-tag').forEach(tag => tag.classList.remove('active'));
    };

    window.closeNewProjectModal = function() {
        newProjectModal.style.display = 'none';
    };

    // 자주 쓰는 공지사항 태그 토글 핸들러
    window.toggleNoticeTag = function(element, text) {
        const textarea = document.getElementById('newProjectNotice');
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

    // 자주쓰는공지 칩 동적 렌더링
    function renderNoticeQuickTags(notices) {
        globalQuickNotices = notices || [];
        const container = document.getElementById('noticeQuickTags');
        container.innerHTML = "";
        
        if (globalQuickNotices.length === 0) {
            container.innerHTML = `<span style="font-size: 12px; color: var(--text-muted); padding: 4px;">에어테이블에 등록된 공지 템플릿이 없습니다. 아래에서 새로 등록해 보세요!</span>`;
            return;
        }
        
        // 현재 textarea에 입력된 텍스트 수집해서 칩 active 상태 복원용 비교군 생성
        const textarea = document.getElementById('newProjectNotice');
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
                toggleNoticeTag(this, text);
            };
            container.appendChild(span);
        });
    }

    // 실시간 공지 템플릿 에어테이블 저장 및 웹 등록
    window.addNewNoticeTemplateTag = async function() {
        const input = document.getElementById('customNoticeTagInput');
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
            
            // 성공 시 캐시 반영 및 칩 즉각 재생성
            globalQuickNotices.push(text);
            renderNoticeQuickTags(globalQuickNotices);
            
            // 새로 생성된 칩을 자동으로 클릭/활성화 처리하여 텍스트 영역에 바로 꽂아주기
            const container = document.getElementById('noticeQuickTags');
            const newChip = Array.from(container.children).find(el => el.textContent === text);
            if (newChip) {
                toggleNoticeTag(newChip, text);
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
                    <div class="card-address" style="margin-top: 6px; font-size:12.5px;">👷 기사: ${workersText}</div>
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
            selectedItemIds.clear();
            pendingItemToggles.clear();
        }
        activeProjectCode = recordId;
        showLoading("현장 상세 정보를 불러오는 중...");
        try {
            const response = await fetch(`${API_DETAIL_URL}?code=${recordId}`);
            if (!response.ok) throw new Error("상세조회 실패");
            
            const result = await response.json();
            // n8n은 데이터를 리턴할 때 항상 배열 [ { ... } ] 형태로 감싸서 주므로, 첫 번째 원소를 꺼내줍니다.
            currentDetailData = Array.isArray(result) ? result[0] : result;
            
            renderDetailSection();
            showSection('projectDetailSection');
        } catch (error) {
            console.error(error);
            showToast("현장 데이터를 불러오지 못했습니다.", "danger");
        } finally {
            hideLoading();
        }
    }


    function renderDetailSection() {
        const p = currentDetailData.project;
        detailProjectTitle.textContent = p.현장명;
        detailProjectDate.textContent = `시공일: ${p.시공일자 || '미정'}`;

        // 공지 및 주의사항 표시
        const noticeEl = document.getElementById('detailProjectNotice');
        if (noticeEl) {
            noticeEl.value = p.공지사항 || "";
        }

        // 1. 현장 품목 설정 칩 바 렌더링
        renderItemConfigChips();

        // 2. 3분할 보드 - 1열 (시공기사 목록) 렌더링
        renderBoardWorkers();

        // 3. 3분할 보드 - 3열 (미배정 품목 풀) 렌더링
        renderBoardAvailableItems();

        // 4. 3분할 보드 - 2열 (배정 내역 리스트) 렌더링
        renderBoardAssignments();
    }

    // 품목 설정 칩들 (카테고리 탭 + 활성 탭의 품목만 표시)
    function renderItemConfigChips() {
        const allItems = currentDetailData.masterItems || [];
        const activeItems = currentDetailData.activeItems || []; // 이미 현장에 개설 완료된 품목들

        const categoryMap = new Map();
        allItems.forEach(item => {
            const cat = item.카테고리 || "기타";
            if (!categoryMap.has(cat)) categoryMap.set(cat, []);
            categoryMap.get(cat).push(item);
        });

        // 항상 고정된 순서로 노출 (목록에 없는 새 카테고리는 뒤에 붙음)
        const CATEGORY_ORDER = ['문+틀', '샤시', '가구', '몰딩', '기타'];
        const categoryNames = [...categoryMap.keys()].sort((a, b) => {
            const idxA = CATEGORY_ORDER.indexOf(a);
            const idxB = CATEGORY_ORDER.indexOf(b);
            return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
        });

        if (!activeItemCategory || !categoryMap.has(activeItemCategory)) {
            activeItemCategory = categoryNames[0] || null;
        }

        itemCategoryTabs.innerHTML = "";
        categoryNames.forEach(category => {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = `item-category-tab ${category === activeItemCategory ? 'active' : ''}`;
            tab.textContent = category;
            tab.addEventListener('click', () => {
                activeItemCategory = category;
                renderItemConfigChips();
            });
            itemCategoryTabs.appendChild(tab);
        });

        itemCheckboxGroup.innerHTML = "";
        const itemsInTab = categoryMap.get(activeItemCategory) || [];
        itemsInTab.forEach(item => {
            const chip = document.createElement('div');
            const serverActive = activeItems.includes(item.품목명);
            const pendingState = pendingItemToggles.has(item.품목명) ? pendingItemToggles.get(item.품목명) : null;

            let chipClass = 'item-chip';
            let prefix = '+ ';
            if (pendingState !== null) {
                chipClass += pendingState ? ' pending-add' : ' pending-remove';
                prefix = pendingState ? '+ ' : '− ';
            } else if (serverActive) {
                chipClass += ' active';
                prefix = '✓ ';
            }

            chip.className = chipClass;
            chip.innerHTML = `${prefix}${item.품목명}`;
            chip.addEventListener('click', () => {
                const effectiveActive = pendingState !== null ? pendingState : serverActive;
                const target = !effectiveActive;
                if (target === serverActive) {
                    pendingItemToggles.delete(item.품목명);
                } else {
                    pendingItemToggles.set(item.품목명, target);
                }
                renderItemConfigChips();
            });
            itemCheckboxGroup.appendChild(chip);
        });

        updateItemBatchToolbar();
    }

    function updateItemBatchToolbar() {
        const toolbar = document.getElementById('itemBatchToolbar');
        const countEl = document.getElementById('itemBatchCount');
        if (!toolbar || !countEl) return;
        const n = pendingItemToggles.size;
        if (n > 0) {
            toolbar.style.display = 'flex';
            countEl.textContent = `${n}개 선택됨`;
        } else {
            toolbar.style.display = 'none';
        }
    }

    window.applyPendingItemToggles = async function() {
        if (pendingItemToggles.size === 0) return;
        const entries = [...pendingItemToggles.entries()];

        showLoading(`${entries.length}개 품목 일괄 적용 중...`);
        try {
            await Promise.all(entries.map(([itemName, enable]) =>
                fetch(API_SAVE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: enable ? 'toggle_item_create' : 'toggle_item_delete',
                        projectCode: activeProjectCode,
                        itemName: itemName
                    })
                }).then(res => { if (!res.ok) throw new Error(`${itemName} 처리 실패`); })
            ));

            showToast(`${entries.length}개 품목이 일괄 적용되었습니다!`);
            pendingItemToggles.clear();
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("일괄 적용 중 일부 품목 처리에 실패했습니다.", "danger");
            pendingItemToggles.clear();
            await showProjectDetail(activeProjectCode);
        } finally {
            hideLoading();
        }
    };

    window.cancelPendingItemToggles = function() {
        pendingItemToggles.clear();
        renderItemConfigChips();
    };

    // 품목 켜고 끄기 요청 (즉시 실행 - 배정 보드의 × 삭제 버튼에서 사용)
    async function toggleProjectItem(itemName, enable) {
        showLoading(`${itemName} 품목 상태 업데이트 중...`);
        try {
            const response = await fetch(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: enable ? 'toggle_item_create' : 'toggle_item_delete',
                    projectCode: activeProjectCode,
                    itemName: itemName
                })
            });

            if (!response.ok) throw new Error("업데이트 오류");
            
            showToast(`${itemName} 품목이 ${enable ? '추가' : '제외'}되었습니다.`);
            // 데이터 재조회 및 화면 갱신
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast("품목 변경 중 문제가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    }


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
            card.textContent = `${worker} 기사님`;

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
            workers.map(w => `<option value="${w}">${w} 기사님</option>`).join('');
        select.value = activeWorkerName || "";
    }

    // 드롭다운에서 기사님을 선택하면 기사님 카드 선택 상태와 동기화하고 배정표를 필터링
    window.onAssignmentWorkerFilterChange = function() {
        const select = document.getElementById('assignmentWorkerFilter');
        activeWorkerName = select.value || null;
        renderBoardWorkers();
        renderBoardAssignments();
    };

    // 3열: 미배정 품목 풀 그리기 (밑작업/시공 구분)
    function renderBoardAvailableItems() {
        boardAvailableItems.innerHTML = "";
        const tasks = currentDetailData.tasks || [];
        let count = 0;
        const assignedHistory = [];
        const validKeys = new Set();

        tasks.forEach((task, taskIdx) => {
            const fields = task.fields;
            const groupCards = [];

            // 1. 밑작업 기사가 아직 배정되지 않은 경우
            if (!fields.밑작업기사) {
                validKeys.add(`${task.id}|밑작업`);
                groupCards.push(createDragItemCard(task, '밑작업'));
                count++;
            } else {
                assignedHistory.push(`${fields.시공품목} (밑작업) ${fields.밑작업기사} 배정완료`);
            }

            // 2. 시공 기사가 아직 배정되지 않은 경우
            if (!fields.시공기사) {
                validKeys.add(`${task.id}|시공`);
                groupCards.push(createDragItemCard(task, '시공'));
                count++;
            } else {
                assignedHistory.push(`${fields.시공품목} (시공) ${fields.시공기사} 배정완료`);
            }

            // 같은 품목(태스크)의 카드들을 하나의 그룹으로 묶어서 시각적으로 구분
            if (groupCards.length > 0) {
                const groupWrap = document.createElement('div');
                groupWrap.className = `item-task-group ${taskIdx % 2 === 0 ? 'even' : 'odd'}`;
                groupCards.forEach(card => groupWrap.appendChild(card));
                boardAvailableItems.appendChild(groupWrap);
            }
        });

        // 이미 배정되었거나 삭제되어 더 이상 유효하지 않은 선택 항목 정리
        [...selectedItemIds].forEach(key => {
            if (!validKeys.has(key)) selectedItemIds.delete(key);
        });
        updateItemAssignBatchToolbar();

        availableCountBadge.textContent = `${count}개`;
        if (count === 0) {
            boardAvailableItems.innerHTML = `<div class="empty-state" style="padding: 20px;">모든 품목의 기사 배정이 완료되었습니다.</div>`;
        }

        // 배정 완료 내역 하단 렌더링
        if (assignedHistory.length > 0) {
            const historyBox = document.createElement('div');
            historyBox.className = 'assigned-history-box';
            historyBox.style.marginTop = '20px';
            historyBox.style.borderTop = '1px dashed #ddd';
            historyBox.style.paddingTop = '15px';
            
            let historyHtml = `<h4 style="font-size: 13px; color: #666; margin-bottom: 8px; font-weight: 800;">📋 기사 배정 완료 내역</h4>`;
            assignedHistory.forEach(item => {
                historyHtml += `
                    <div style="font-size: 12px; color: #555; padding: 4px 8px; margin-bottom: 4px; background: #f9f9f9; border-radius: 4px; border-left: 3px solid #888; font-weight: 600;">
                        ${item}
                    </div>
                `;
            });
            historyBox.innerHTML = historyHtml;
            boardAvailableItems.appendChild(historyBox);
        }
    }


    function createDragItemCard(task, stage) {
        const fields = task.fields;
        const card = document.createElement('div');
        const key = `${task.id}|${stage}`;
        const isSelected = selectedItemIds.has(key);
        card.className = `draggable-item-card ${isSelected ? 'selected' : ''}`;
        card.draggable = true;
        card.dataset.recordId = task.id;
        card.dataset.stage = stage;

        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="card-select-check">${isSelected ? '✅' : '☐'}</span>
                    <span class="card-item-name">${fields.시공품목}</span>
                    <span class="card-item-stage-badge ${stage === '밑작업' ? 'prep' : 'wrap'}">${stage}</span>
                </div>
                <button class="btn-item-delete" title="이 품목 삭제 (시공 안 함)" style="padding: 3px 8px; font-size: 11px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 700;">×</button>
            </div>
        `;

        card.querySelector('.btn-item-delete').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`'${fields.시공품목}' 품목을 이 현장에서 삭제할까요?\n(밑작업/시공 내역이 모두 삭제되며 되돌릴 수 없습니다)`)) return;
            await toggleProjectItem(fields.시공품목, false);
        });

        // HTML5 드래그 소스(Drag Source) 이벤트 연결 - 워커 카드로 바로 드래그하면 즉시 1건 배정됨
        card.addEventListener('dragstart', () => {
            draggedData = {
                recordId: task.id,
                stage: stage
            };
            card.style.opacity = '0.4';
        });

        card.addEventListener('dragend', () => {
            draggedData = null;
            card.style.opacity = '1';
        });

        // 클릭 시 즉시 배정하지 않고, 일괄 배정을 위한 선택/해제만 수행
        card.addEventListener('click', () => {
            const nowSelected = !selectedItemIds.has(key);
            if (nowSelected) {
                selectedItemIds.add(key);
                card.classList.add('selected');
            } else {
                selectedItemIds.delete(key);
                card.classList.remove('selected');
            }
            card.querySelector('.card-select-check').textContent = nowSelected ? '✅' : '☐';
            updateItemAssignBatchToolbar();
        });

        return card;
    }

    function updateItemAssignBatchToolbar() {
        const toolbar = document.getElementById('itemAssignBatchToolbar');
        const countEl = document.getElementById('itemAssignBatchCount');
        if (!toolbar || !countEl) return;
        const n = selectedItemIds.size;
        if (n > 0) {
            toolbar.style.display = 'flex';
            countEl.textContent = `${n}개 선택됨`;
        } else {
            toolbar.style.display = 'none';
        }
    }

    window.assignSelectedItemsBatch = async function() {
        if (!activeWorkerName) {
            showToast("먼저 왼쪽에서 배정할 기사님을 선택해 주세요!", "warning");
            return;
        }
        if (selectedItemIds.size === 0) return;

        const items = [...selectedItemIds].map(key => {
            const [recordId, stage] = key.split('|');
            return { recordId, stage };
        });
        const workerName = activeWorkerName;

        showLoading(`${workerName} 기사님에게 ${items.length}개 항목 일괄 배정 중...`);
        try {
            await Promise.all(items.map(it => postAssignWorker(it.recordId, workerName, it.stage)));
            showToast(`${items.length}개 항목이 ${workerName} 기사님에게 일괄 배정되었습니다!`);
            selectedItemIds.clear();
            await showProjectDetail(activeProjectCode);
        } catch (error) {
            console.error(error);
            showToast(`일괄 배정 중 문제가 발생했습니다: ${error.message}`, "danger");
            selectedItemIds.clear();
            await showProjectDetail(activeProjectCode);
        } finally {
            hideLoading();
        }
    };

    window.clearSelectedItemsBatch = function() {
        selectedItemIds.clear();
        renderBoardAvailableItems();
    };

    // 2열: 배정 완료 내역 그리기
    function renderBoardAssignments() {
        boardAssignmentList.innerHTML = "";
        const tasks = currentDetailData.tasks || [];
        
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

        let count = 0;
        tasks.forEach(task => {
            const fields = task.fields;

            // 밑작업 기사 배정 완료 카드 그리기
            if (fields.밑작업기사 && (!filterWorkerName || fields.밑작업기사 === filterWorkerName)) {
                createAssignmentCard(task, '밑작업', fields.밑작업기사);
                count++;
            }

            // 시공 기사 배정 완료 카드 그리기
            if (fields.시공기사 && (!filterWorkerName || fields.시공기사 === filterWorkerName)) {
                createAssignmentCard(task, '시공', fields.시공기사);
                count++;
            }
        });

        assignedCountBadge.textContent = `${count}개`;
        if (count === 0) {
            boardAssignmentList.innerHTML = `<div class="drag-placeholder">우측의 품목 카드를 이곳이나 왼쪽 기사 카드 위로 드래그하여 배정하세요.</div>`;
        }
    }
    function createAssignmentCard(task, stage, assigneeName) {
        const fields = task.fields;
        const recordId = task.id;
        
        const card = document.createElement('div');
        card.className = 'assignment-card';
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

        // 1. 헤더 (배정 기사 이름, 작업이름, 아코디언 ▼ 표시, 순서 이동 ▲▼, 배정 취소 x)
        // 특정 기사님으로 필터링된 상태면 카드마다 이름을 반복 표시할 필요가 없어 배지를 생략함
        const assigneeBadgeHtml = activeWorkerName ? '' : `<span class="assignee-badge">${assigneeName}</span>`;
        let headerHtml = `
            <div class="assignment-card-header" onclick="toggleAssignmentCardBody(event, this)" style="cursor: pointer;">
                <div style="display: flex; align-items: center; gap: 6px; user-select: none;">
                    ${assigneeBadgeHtml}
                    <span class="assigned-item-name">${fields.시공품목} (${stage})</span>
                    <span class="toggle-arrow" style="font-size: 11px; color: #888;">▼</span>
                </div>
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
        if (guidelinesText) {
            const linesList = guidelinesText.split('\n').filter(l => l.trim() !== "");
            const existingResults = fields.점검결과 || "";

            bodyHtml = `
                <div class="assignment-card-body" style="display: none; padding-top: 10px;">
                    <h4 style="font-size: 11px; margin-bottom: 8px; color: #666;">💡 현장 품질 지침 토글 (체크된 사항만 기사에게 노출됨)</h4>
                    <div class="assign-checkbox-list">
            `;

            linesList.forEach(line => {
                const cleanLine = line.trim();
                const isGuidelineActive = !existingResults || existingResults.includes(cleanLine);

                bodyHtml += `
                    <div class="assign-toggle-item ${isGuidelineActive ? 'active' : ''}" 
                          onclick="toggleGuidelineItem('${recordId}', '${stage}', '${cleanLine.replace(/'/g, "\\'")}', ${isGuidelineActive})">
                        <span class="toggle-dot"></span>
                        <span class="toggle-text">${cleanLine}</span>
                    </div>
                `;
            });

            bodyHtml += `</div></div>`;
        }

        card.innerHTML = `${headerHtml}${bodyHtml}`;
        boardAssignmentList.appendChild(card);
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
    async function persistAssignmentOrder() {
        // 1. 배정표 내에 정렬된 카드들 순서 수집
        const cards = [...boardAssignmentList.querySelectorAll('.assignment-card')];
        const orderIds = cards.map(c => c.dataset.recordId);

        // 2. 임시 로컬 캐시에 정렬 순서 보관 (즉시 반영용)
        const sortOrderKey = `task_sort_order_${activeProjectCode}`;
        localStorage.setItem(sortOrderKey, JSON.stringify(orderIds));

        // 3. 우선순위 번호 맵핑
        const reorderTasks = cards.map((c, index) => ({
            id: c.dataset.recordId,
            priority: index + 1
        }));

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
    window.moveAssignmentCard = async function(recordId, stage, direction) {
        const card = boardAssignmentList.querySelector(`.assignment-card[data-record-id="${recordId}"][data-stage="${stage}"]`);
        if (!card) return;

        if (direction === 'up') {
            const prev = card.previousElementSibling;
            if (!prev || !prev.classList.contains('assignment-card')) return;
            boardAssignmentList.insertBefore(card, prev);
        } else {
            const next = card.nextElementSibling;
            if (!next || !next.classList.contains('assignment-card')) return;
            boardAssignmentList.insertBefore(next, card);
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
            scenePending: [],    // File[] - 아직 업로드 안 된, 발행 시 업로드될 사진 (삭제 가능)
            cleanupPending: []
        };
    }

    window.requestBlogPublish = async function() {
        const tasks = currentDetailData.tasks || [];

        // 밑작업 + 시공이 모두 완료된 항목만 표시
        eligibleTasksCache = tasks.filter(t => t.fields.밑작업완료 && t.fields.시공완료);

        if (eligibleTasksCache.length === 0) {
            showToast("밑작업과 시공이 모두 완료된 항목이 없습니다.", "danger");
            return;
        }

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
                    cleanupSaved: (f.정리정돈사진 || []).filter(a => a.url && !a.url.includes('1x1.png')).map(a => ({ url: a.url, filename: a.filename }))
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
        const saved = kind === 'scene' ? d.sceneSaved : d.cleanupSaved;
        const pending = kind === 'scene' ? d.scenePending : d.cleanupPending;
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
        input.multiple = true;
        input.style.display = 'none';

        input.addEventListener('change', (e) => {
            const picked = Array.from(e.target.files);
            const d = dayDrafts[activeDayIndex];
            if (!d || picked.length === 0) { input.remove(); return; }
            if (kind === 'scene') {
                d.scenePending = d.scenePending.concat(picked);
            } else {
                d.cleanupPending = d.cleanupPending.concat(picked);
            }
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
                    ${fields.시공품목} (밑작업완료, 시공완료)
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

    async function uploadSingleJournalPhoto(journalId, file, fieldName) {
        const base64 = await fileToBase64(file);
        const res = await fetch(API_JOURNAL_PHOTO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                journalId,
                fieldName,
                filename: file.name,
                contentType: file.type || 'image/jpeg',
                fileBase64: base64
            })
        });
        if (!res.ok) throw new Error("사진 업로드 실패: " + file.name);
    }

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

        let html = "";
        categoryGroups.forEach((indices, category) => {
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
                    밑작업지침: prepText,
                    시공후점검지침: inspText,
                    필수사진슬롯: slotsText
                }
                : {
                    type: 'update_item',
                    recordId: globalMasterItems[idx].id,
                    품목명: nameText,
                    카테고리: categoryText,
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
