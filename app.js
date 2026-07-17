document.addEventListener('DOMContentLoaded', async () => {
    // 1. 설정 및 글로벌 변수
    const n8nBase = "https://primary-production-a6fa.up.railway.app";
    const API_GET_URL = `${n8nBase}/webhook/film-quality-get`;
    const API_SAVE_URL = `${n8nBase}/webhook/film-quality-save`;
    const API_UPLOAD_URL = `${n8nBase}/webhook/film-image-upload`;

    let projectData = null;
    let currentWorker = "";
    let activeUploadSlot = null; // 현재 업로드 중인 슬롯 엘리먼트 보관용
    const expandedCardIds = new Set(); // 아코디언이 열려 있는 카드의 ID를 추적하기 위한 Set
    
    // UI Elements
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const toast = document.getElementById('toast');
    const projectTitle = document.getElementById('projectTitle');
    const projectDate = document.getElementById('projectDate');
    const projectAddress = document.getElementById('projectAddress');
    const workerTabs = document.getElementById('workerTabs');
    const noticeList = document.getElementById('noticeList');
    const taskListContainer = document.getElementById('taskListContainer');
    const modalOverlay = document.getElementById('modalOverlay');
    const modalConfirmBtn = document.getElementById('modalConfirmBtn');

    // 2. 유틸리티 함수
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

    // 아코디언 토글 (전역 범위로 제공하기 위해 window객체에 바인딩)
    window.toggleAccordion = function(bodyId) {
        const body = document.getElementById(bodyId);
        const card = body.closest('.accordion-card');
        if (body.style.display === 'none') {
            body.style.display = 'block';
            card.classList.add('open');
        } else {
            body.style.display = 'none';
            card.classList.remove('open');
        }
    };

    // 모달 관리
    let modalCallback = null;
    window.openModal = function(message, callback) {
        document.getElementById('modalMessage').textContent = message;
        modalOverlay.style.display = 'flex';
        modalCallback = callback;
    };

    window.closeModal = function(confirm) {
        modalOverlay.style.display = 'none';
        if (confirm && modalCallback) {
            modalCallback();
        }
        modalCallback = null;
    };

    modalConfirmBtn.addEventListener('click', () => closeModal(true));

    // 3. URL 파라미터 분석 및 초기화 데이터 로드
    const urlParams = new URLSearchParams(window.location.search);
    const projectRecordId = urlParams.get('code');

    if (!projectRecordId) {
        showToast("현장 코드가 잘못되었거나 존재하지 않습니다.", "danger");
        projectTitle.textContent = "잘못된 현장 접근";
        projectDate.textContent = "에러";
        projectAddress.textContent = "주소창의 code 파라미터가 비어 있습니다.";
        document.getElementById('taskListContainer').innerHTML = `
            <div class="empty-state" style="color: var(--danger); font-weight: 800;">
                ⚠ 접속 링크가 올바르지 않습니다.<br>사장님이 보내주신 카카오톡 링크를 다시 확인해 주세요.
            </div>`;
        return;
    }

    // 데이터 로딩 실행
    await loadProjectData(projectRecordId);

    // 4. API 통신: 데이터 불러오기
    async function loadProjectData(recordId) {
        showLoading("현장 데이터를 불러오는 중...");
        try {
            const response = await fetch(`${API_GET_URL}?code=${recordId}&_t=${Date.now()}`, {
                cache: "no-store"
            });
            if (!response.ok) throw new Error("서버 연동 실패");
            
            const result = await response.json();
            // n8n은 데이터를 리턴할 때 항상 배열 [ { ... } ] 형태로 감싸서 주므로, 첫 번째 원소를 꺼내줍니다.
            projectData = Array.isArray(result) ? result[0] : result;
            
            if (!projectData || !projectData.project) {
                throw new Error("현장 데이터가 존재하지 않습니다.");
            }

            renderHeader();
            renderWorkerSelect();
            renderAnnouncements();

            if (!projectData.workers || projectData.workers.length === 0) {
                taskListContainer.innerHTML = '<div class="empty-state">배정된 시공기사가 없습니다.</div>';
            }

        } catch (error) {
            console.error(error);
            showToast("데이터를 불러오는 도중 에러가 발생했습니다.", "danger");
            projectTitle.textContent = "데이터 연동 오류";
            taskListContainer.innerHTML = `<div class="empty-state" style="color: var(--danger);">서버와 연결할 수 없습니다.<br>${error.message}</div>`;
        } finally {
            hideLoading();
        }
    }

    // 5. 화면 렌더링 함수들
    function renderHeader() {
        const p = projectData.project;
        projectTitle.textContent = p.현장명 || "알 수 없는 현장";
        projectDate.textContent = p.시공일자 ? `시공일: ${p.시공일자}` : "일자 미지정";
        projectAddress.textContent = p.주소 || "등록된 주소가 없습니다.";
    }

    function renderWorkerSelect() {
        workerTabs.innerHTML = "";
        const workers = projectData.workers || [];

        if (workers.length === 0) {
            workerTabs.innerHTML = `<option value="">지정된 기사 없음</option>`;
            workerTabs.disabled = true;
            return;
        }
        workerTabs.disabled = false;

        workers.forEach(worker => {
            const option = document.createElement('option');
            option.value = worker;
            // '기사님' 대신 '님'을 붙이며, 이미 '님'으로 끝나면 그대로 출력합니다.
            option.textContent = worker.endsWith('님') ? worker : `${worker}님`;
            workerTabs.appendChild(option);
        });

        workerTabs.addEventListener('change', () => {
            selectWorker(workerTabs.value);
        });

        // 이 현장에서 마지막으로 선택했던 기사님을 복원 (없거나 더 이상 유효하지 않으면 첫 번째 기사님)
        const savedWorkerKey = `selected_worker_${projectRecordId}`;
        const savedWorker = localStorage.getItem(savedWorkerKey);
        const initialWorker = (savedWorker && workers.includes(savedWorker)) ? savedWorker : workers[0];
        workerTabs.value = initialWorker;
        selectWorker(initialWorker);
    }


    function renderAnnouncements() {
        noticeList.innerHTML = "";
        const p = projectData.project;
        const noticeText = p.공지사항 || "";
        const btn = document.getElementById('noticeReportBtn');

        if (!noticeText.trim()) {
            noticeList.innerHTML = `<div style="font-size: 13.5px; color: var(--text-muted); text-align: center; padding: 10px;">현장 공지사항이 비어 있습니다.</div>`;
            if (btn) btn.style.display = 'none';
            return;
        }

        const lines = noticeText.split('\n').filter(l => l.trim() !== "");
        const todayStr = new Date().toISOString().split('T')[0];

        lines.forEach((line, index) => {
            const item = document.createElement('div');
            item.className = 'check-item';
            
            // 날짜별로 체크 상태 키를 분리 -> 매일 새롭게 체크해서 보고할 수 있음
            const storageKey = `notice_${projectRecordId}_${currentWorker || 'default'}_${todayStr}_${index}`;
            const isChecked = localStorage.getItem(storageKey) === 'true';
            
            if (isChecked) {
                item.classList.add('checked');
            }

            item.innerHTML = `
                <div class="custom-checkbox"></div>
                <div class="check-text">${line}</div>
            `;

            item.addEventListener('click', () => {
                const nowChecked = !item.classList.contains('checked');
                item.classList.toggle('checked', nowChecked);
                localStorage.setItem(storageKey, nowChecked ? 'true' : 'false');
                // 체크박스 클릭 시 실시간으로 전송 버튼 활성/비활성 제어 기동
                updateNoticeReportButtonState(lines.length);
            });

            noticeList.appendChild(item);
        });

        // 공지 전송 버튼 노출 및 활성 상태 체크
        if (btn) {
            btn.style.display = 'block';
        }

        // 초기 로딩 시 버튼 상태 갱신
        updateNoticeReportButtonState(lines.length);
    }

    // [알잘딱깔센] 공지사항 전송 버튼의 활성/비활성화 상태 실시간 제어 함수
    function updateNoticeReportButtonState(totalNoticeCount) {
        const btn = document.getElementById('noticeReportBtn');
        if (!btn) return;

        if (!currentWorker) {
            btn.disabled = true;
            btn.textContent = "📢 기사님을 선택해 주세요";
            return;
        }

        // 1단계: 오늘 날짜 기준 보고 완료 여부 체크
        const todayStr = new Date().toISOString().split('T')[0];
        const reportKey = `notice_reported_${projectRecordId}_${currentWorker}_${todayStr}`;
        const reportedCountVal = localStorage.getItem(reportKey);

        if (reportedCountVal && parseInt(reportedCountVal, 10) === totalNoticeCount) {
            btn.disabled = true;
            btn.textContent = "📢 오늘 공지 확인 완료 (보고됨)";
            return;
        }

        // 2단계: 현재 체크된 공지사항 개수 카운트
        const checkedCount = document.querySelectorAll('#noticeList .check-item.checked').length;

        // 공지가 4개인데 체크가 2개밖에 없으면 -> 잠금 및 안내 문구 노출
        if (checkedCount < totalNoticeCount) {
            btn.disabled = true;
            btn.textContent = "📢 모든 공지사항을 확인해 주세요";
        } else {
            // 전부 체크 완료했을 때만 버튼이 초록색(활성)으로 풀림
            btn.disabled = false;
            btn.textContent = "📢 오늘 공지 확인 완료 보고";
        }
    }

    // 공지 완료 보고 텔레그램 발송 요청
    window.submitNoticeConfirmation = async function() {
        if (!currentWorker) {
            showToast("기사 탭을 선택해 주세요.", "danger");
            return;
        }

        // 체크된 공지 문구들 수집
        const checkedItems = Array.from(document.querySelectorAll('#noticeList .check-item.checked'));
        const checkedLines = checkedItems.map(item => item.querySelector('.check-text').textContent.trim());

        // 전체 공지 개수 확보
        const noticeText = projectData.project.공지사항 || "";
        const totalNoticeLines = noticeText.split('\n').filter(l => l.trim() !== "").length;

        if (checkedLines.length < totalNoticeLines) {
            showToast("모든 공지사항을 확인하셔야 보고할 수 있습니다.", "warning");
            return;
        }

        showLoading("공지 확인 보고를 전송하는 중...");
        try {
            const response = await fetch("https://primary-production-a6fa.up.railway.app/webhook/film-notice-confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    projectName: projectData.project.현장명 || "알 수 없는 현장",
                    workerName: currentWorker,
                    checkedLines: checkedLines
                })
            });

            if (!response.ok) throw new Error("전송 실패");

            // reportKey를 이 함수 안에서 직접 생성 (스코프 버그 수정)
            const todayStr = new Date().toISOString().split('T')[0];
            const reportKey = `notice_reported_${projectRecordId}_${currentWorker}_${todayStr}`;
            localStorage.setItem(reportKey, totalNoticeLines.toString());

            // 버튼 비활성화
            const btn = document.getElementById('noticeReportBtn');
            if (btn) {
                btn.disabled = true;
                btn.textContent = "📢 오늘 공지 확인 완료 (보고됨)";
            }

            showToast("오늘 공지 확인 완료 알림을 텔레그램으로 보냈습니다!", "success");
        } catch (error) {
            console.error(error);
            showToast("보고 전송에 실패했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };


    function selectWorker(workerName) {
        currentWorker = workerName;
        localStorage.setItem(`selected_worker_${projectRecordId}`, workerName);
        renderAnnouncements();
        renderTasks();
    }


    function renderTasks() {
        taskListContainer.innerHTML = "";
        const tasks = projectData.tasks || [];
        
        // 현재 선택된 기사님이 밑작업기사 혹은 시공기사로 들어있는 작업들을 필터링
        const filteredTasks = tasks.filter(t => t.fields.밑작업기사 === currentWorker || t.fields.시공기사 === currentWorker);

        // 우선순위 정렬 적용 (Airtable 우선순위 컬럼 및 로컬 순서 캐시 백업)
        const sortOrderKey = `task_sort_order_${projectRecordId}`;
        const savedOrder = JSON.parse(localStorage.getItem(sortOrderKey) || "[]");
        
        filteredTasks.sort((a, b) => {
            const pA = a.fields.우선순위 !== undefined ? a.fields.우선순위 : (savedOrder.indexOf(a.id) !== -1 ? savedOrder.indexOf(a.id) : 999);
            const pB = b.fields.우선순위 !== undefined ? b.fields.우선순위 : (savedOrder.indexOf(b.id) !== -1 ? savedOrder.indexOf(b.id) : 999);
            return pA - pB;
        });


        if (filteredTasks.length === 0) {
            taskListContainer.innerHTML = `<div class="empty-state">이 현장에 배정받으신 작업 내역이 없습니다.</div>`;
            return;
        }

        // 품목 우선순위 순서는 유지하되, 밑작업/시공 각 단계를 독립된 카드로 나열
        const cardEntries = [];
        filteredTasks.forEach(task => {
            const fields = task.fields;
            if (fields.밑작업기사 === currentWorker) {
                cardEntries.push({ task, stage: '밑작업', isCompleted: !!fields.밑작업완료 });
            }
            if (fields.시공기사 === currentWorker) {
                cardEntries.push({ task, stage: '시공', isCompleted: !!fields.시공완료 });
            }
        });

        // 완료된 카드를 맨 아래로 - 완료 여부로만 재배치하고, 그 안에서는 원래 순서(우선순위) 유지
        cardEntries.sort((a, b) => (a.isCompleted === b.isCompleted) ? 0 : (a.isCompleted ? 1 : -1));

        cardEntries.forEach(({ task, stage }) => {
            const fields = task.fields;
            const item = projectData.items[fields.시공품목] || { 밑작업지침: "", 시공후점검지침: "", 필수사진슬롯: "" };

            if (stage === '밑작업') {
                renderTaskCard(task, '밑작업', item.밑작업지침, "시공전사진");
            } else {
                renderTaskCard(task, '시공', item.시공후점검지침, "시공후사진", item.필수사진슬롯);
            }
        });
    }

    function renderTaskCard(task, stage, guidelinesText, photoField, optionalSlotsText = "") {
        const fields = task.fields;
        const recordId = task.id;
        const isCompleted = stage === '밑작업' ? fields.밑작업완료 : fields.시공완료;
        
        const card = document.createElement('div');
        card.className = `task-card ${isCompleted ? 'completed' : ''}`;
        card.dataset.id = recordId;
        card.dataset.stage = stage;

        const cardKey = `${recordId}-${stage}`;
        const isExpanded = expandedCardIds.has(cardKey);

        // 헤더: 클릭하면 바디 토글 (아코디언)
        const cardBodyId = `task-body-${recordId}-${stage}`;
        let headerHtml = `
            <div class="task-card-header task-card-toggle" data-target="${cardBodyId}">
                <div class="task-badge-container">
                    <span class="task-title">${fields.시공품목}</span>
                    <span class="task-badge ${stage === '밑작업' ? 'prep' : 'wrap'}">${stage}</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="task-status-badge ${isCompleted ? 'completed' : ''}">
                        ${isCompleted ? '✅ 완료됨' : '진행중'}
                    </span>
                    <span class="task-accordion-icon">${isExpanded ? '▲' : '▼'}</span>
                </div>
            </div>
        `;

        // 가이드라인 체크리스트 파싱
        const lines = (guidelinesText || "").split('\n').filter(l => l.trim() !== "");
        let checklistHtml = "";
        
        // Airtable 점검결과 텍스트 읽어서 이전에 체크했던 값 파싱
        const existingResults = fields.점검결과 || "";
        
        if (lines.length > 0) {
            checklistHtml = `
                <div class="checklist-box">
                    <h3>📋 품질 준수사항 점검</h3>
                    <div class="checklist-list">
            `;
            
            lines.forEach((line, idx) => {
                const isItemChecked = isCompleted || existingResults.includes(`[✓] ${line.trim()}`);
                
                checklistHtml += `
                    <div class="check-item ${isItemChecked ? 'checked' : ''} ${isCompleted ? 'disabled' : ''}" data-index="${idx}">
                        <div class="custom-checkbox"></div>
                        <div class="check-text">${line}</div>
                    </div>
                `;
            });
            
            checklistHtml += `</div></div>`;
        }

        // 사진 슬롯 파싱
        let photoHtml = "";
        let slots = [];
        
        if (stage === '밑작업') {
            slots = ["시공전 원본사진"];
        } else {
            slots = (optionalSlotsText || "시공 완료사진").split(',').map(s => s.trim()).filter(s => s !== "");
        }

        const existingPhotos = fields[photoField] || [];
        const validPhotosCount = existingPhotos.filter(p => p && p.url && !p.url.includes('1x1.png') && !(p.filename && p.filename.includes('1x1.png'))).length;

        if (slots.length > 0) {
            photoHtml = `
                <div class="photo-slots-box">
                    <h3>📸 필수 품질 사진 촬영 (${validPhotosCount}/${slots.length})</h3>
                    <div class="photo-slots-grid">
            `;

            slots.forEach((slotName, slotIdx) => {
                const photoData = existingPhotos[slotIdx];
                const hasImage = !!photoData && photoData.url && !photoData.url.includes('1x1.png') && !(photoData.filename && photoData.filename.includes('1x1.png'));

                photoHtml += `
                    <div class="photo-slot ${hasImage ? 'has-image' : ''} ${isCompleted ? 'disabled' : ''}" 
                         data-slot-index="${slotIdx}" 
                         data-slot-name="${slotName}"
                         data-record-id="${recordId}"
                         data-field-name="${photoField}">
                        ${hasImage ? `
                            <img src="${photoData.url}" class="photo-slot-preview" alt="시공사진">
                            ${!isCompleted ? `<button class="photo-slot-delete" onclick="event.stopPropagation(); deletePhoto('${recordId}', '${photoField}', ${slotIdx})">×</button>` : ''}
                        ` : `
                            <div class="photo-slot-icon">📷</div>
                            <div class="photo-slot-label">${slotName}</div>
                        `}
                    </div>
                `;
            });

            photoHtml += `</div></div>`;
        }

        // 제출 버튼 영역 (우측에 창닫기 버튼 배치)
        let buttonHtml = `
            <div class="submit-btn-area" style="margin-top: 24px;">
                <button class="task-submit-btn ${isCompleted ? 'completed' : ''}" 
                        ${isCompleted ? 'disabled' : ''} 
                        onclick="submitTask('${recordId}', '${stage}')">
                    ${isCompleted ? '✓ 품질 보고서 제출 완료' : `제출 및 ${stage} 완료하기`}
                </button>
                <button class="task-close-btn" onclick="closeTaskCard('${recordId}', '${stage}')">
                    창닫기
                </button>
            </div>
        `;

        // 카드 바디: 기본 닫힘 (▼ 클릭해야 열림, 단 expandedCardIds에 있으면 열림)
        card.innerHTML = `
            ${headerHtml}
            <div class="task-card-body" id="${cardBodyId}" style="display: ${isExpanded ? 'block' : 'none'};">
                ${checklistHtml}${photoHtml}${buttonHtml}
            </div>
        `;
        taskListContainer.appendChild(card);

        // 헤더 클릭 → 바디 토글
        const headerEl = card.querySelector('.task-card-toggle');
        const bodyEl = card.querySelector(`#${cardBodyId}`);
        const iconEl = card.querySelector('.task-accordion-icon');
        headerEl.addEventListener('click', () => {
            const isOpen = bodyEl.style.display !== 'none';
            if (isOpen) {
                // 제출하지 않은 상태에서 작성 중인 내용이 있는지 체크 (닫기 경고)
                if (!isCompleted) {
                    const hasChecked = card.querySelectorAll('.checklist-list .check-item.checked').length > 0;
                    const hasImage = card.querySelectorAll('.photo-slot.has-image').length > 0;
                    if (hasChecked || hasImage) {
                        if (!confirm("아직 완료 보고서를 제출하지 않았습니다. 정말로 창을 닫으시겠습니까?")) {
                            return; // 닫기 취소
                        }
                    }
                }
                bodyEl.style.display = 'none';
                iconEl.textContent = '▼';
                expandedCardIds.delete(cardKey);
            } else {
                bodyEl.style.display = 'block';
                iconEl.textContent = '▲';
                expandedCardIds.add(cardKey);
            }
        });

        // 이벤트 리스너 바인딩 (수정 불가능한 완료상태 제외)
        if (!isCompleted) {
            // 1. 체크박스 클릭 이벤트
            card.querySelectorAll('.checklist-list .check-item').forEach(item => {
                item.addEventListener('click', () => {
                    item.classList.toggle('checked');
                    
                    // 로컬 메모리 상태에 체크 상태 즉시 기록하여 리렌더링 시 보존되게 함
                    const checkedTexts = [];
                    card.querySelectorAll('.checklist-list .check-item').forEach(ch => {
                        const txt = ch.querySelector('.check-text').textContent.trim();
                        const isChk = ch.classList.contains('checked');
                        checkedTexts.push(`${isChk ? '[✓]' : '[ ]'} ${txt}`);
                    });
                    
                    const t = projectData.tasks.find(x => x.id === recordId);
                    if (t) {
                        t.fields.점검결과 = checkedTexts.join('\n');
                    }
                    
                    validateCardSubmitButton(card);
                });
            });

            // 2. 사진 슬롯 클릭 이벤트 (파일 선택기 연결)
            card.querySelectorAll('.photo-slot:not(.has-image)').forEach(slot => {
                slot.addEventListener('click', () => {
                    triggerImageUpload(slot);
                });
            });

            // 최초 1회 버튼 활성화 검사
            validateCardSubmitButton(card);
        }
    }

    // 6. 비즈니스 로직 및 이벤트 액션들

    // 제출하기 버튼 활성화 검증
    function validateCardSubmitButton(cardElement) {
        const submitBtn = cardElement.querySelector('.task-submit-btn');
        if (submitBtn.classList.contains('completed')) return;

        // 모든 체크리스트 확인 여부
        const totalChecks = cardElement.querySelectorAll('.checklist-list .check-item').length;
        const completedChecks = cardElement.querySelectorAll('.checklist-list .check-item.checked').length;
        const allChecked = totalChecks === completedChecks;

        // 모든 사진 업로드 여부
        const totalPhotos = cardElement.querySelectorAll('.photo-slot').length;
        const uploadedPhotos = cardElement.querySelectorAll('.photo-slot.has-image').length;
        const allUploaded = totalPhotos === uploadedPhotos;

        if (allChecked && allUploaded) {
            submitBtn.classList.add('active');
            submitBtn.disabled = false;
        } else {
            submitBtn.classList.remove('active');
            submitBtn.disabled = true;
        }
    }

    // 숨겨진 File Input을 만들어 카메라 업로드 실행
    function triggerImageUpload(slotElement) {
        // 이미 활성화된 input이 있다면 바디에서 지워줌
        const oldInput = document.getElementById('tempFileInput');
        if (oldInput) oldInput.remove();

        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'tempFileInput';
        input.accept = 'image/*';
        input.className = 'file-input';
        
        activeUploadSlot = slotElement;

        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            await uploadImageToServer(file);
        });

        document.body.appendChild(input);
        input.click();
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

    // n8n 이미지 업로드 서버 호출
    async function uploadImageToServer(file) {
        if (!activeUploadSlot) return;

        const recordId = activeUploadSlot.dataset.recordId;
        const fieldName = activeUploadSlot.dataset.fieldName;
        const slotIndex = Number(activeUploadSlot.dataset.slotIndex);
        const slotName = activeUploadSlot.dataset.slotName;

        showLoading("사진 압축 및 업로드 중...");

        try {
            const resizedFile = await resizeImageFile(file);

            // Form 데이터 구성
            const formData = new FormData();
            formData.append('image', resizedFile);
            formData.append('recordId', recordId);
            formData.append('fieldName', fieldName);
            formData.append('slotIndex', slotIndex);
            formData.append('slotName', slotName);
            formData.append('projectCode', projectRecordId);

            const response = await fetch(API_UPLOAD_URL, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || "업로드 실패");
            }
            
            // 로컬 메모리 상태에 이미지 미리보기를 즉시 적용하여 렌더링 (에어테이블 백그라운드 지연 우회)
            const task = projectData.tasks.find(t => t.id === recordId);
            if (task) {
                if (!task.fields[fieldName]) {
                    task.fields[fieldName] = [];
                }
                task.fields[fieldName][slotIndex] = {
                    url: URL.createObjectURL(file),
                    isLocal: true
                };
            }

            showToast(`${slotName} 촬영 완료!`);
            renderTasks();

        } catch (error) {
            console.error(error);
            showToast(`사진 전송 실패: ${error.message}`, "danger");
        } finally {
            hideLoading();
            activeUploadSlot = null;
        }
    }

    // 사진 삭제 (Airtable에서 해당 인덱스의 이미지 링크 제거 요청)
    window.deletePhoto = async function(recordId, fieldName, slotIndex) {
        if (!confirm("해당 사진을 삭제하시겠습니까?")) return;

        showLoading("사진 삭제하는 중...");
        try {
            const response = await fetch(API_SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectCode: projectRecordId,
                    recordId: recordId,
                    type: 'delete_photo',
                    fieldName: fieldName,
                    slotIndex: slotIndex
                })
            });

            if (!response.ok) throw new Error("삭제 처리 오류");
            
            // 로컬 메모리 상태에서 사진 제거 후 즉시 리렌더링
            const task = projectData.tasks.find(t => t.id === recordId);
            if (task && task.fields[fieldName]) {
                task.fields[fieldName][slotIndex] = {
                    url: "https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png",
                    isLocal: true
                };
            }

            showToast("사진이 삭제되었습니다.");
            renderTasks();

        } catch (error) {
            console.error(error);
            showToast("삭제를 진행할 수 없습니다.", "danger");
        } finally {
            hideLoading();
        }
    };

    // 태스크 최종 제출하기
    window.submitTask = function(recordId, stage) {
        const card = document.querySelector(`.task-card[data-id="${recordId}"][data-stage="${stage}"]`);
        if (!card) return;

        // 체크리스트 결과 파싱 수집
        const checkedTexts = [];
        card.querySelectorAll('.checklist-list .check-item').forEach(item => {
            const text = item.querySelector('.check-text').textContent.trim();
            const isChecked = item.classList.contains('checked');
            checkedTexts.push(`${isChecked ? '[✓]' : '[ ]'} ${text}`);
        });

        const promptMessage = `정말로 이 ${stage} 품질 검수 보고서를 제출하시겠습니까? 제출 후에는 수정이 불가능합니다.`;

        openModal(promptMessage, async () => {
            showLoading("보고서 제출 데이터 기록 중...");
            try {
                const payload = {
                    projectCode: projectRecordId,
                    projectName: projectData.project.현장명 || "알 수 없는 현장",
                    recordId: recordId,
                    type: 'submit_task',
                    stage: stage,
                    workerName: currentWorker,
                    resultsText: checkedTexts.join('\n')
                };

                const response = await fetch(API_SAVE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error("서버 제출 오류");

                showToast(`${stage} 완료 보고 완료!`);
                
                // 데이터 리로드 및 렌더링
                await loadProjectData(projectRecordId);

            } catch (error) {
                console.error(error);
                showToast("결과 제출에 실패했습니다. 네트워크 상태를 확인해 주세요.", "danger");
            } finally {
                hideLoading();
            }
        });
    };

    // 태스크 카드 접기 (창닫기)
    window.closeTaskCard = function(recordId, stage) {
        const cardBodyId = `task-body-${recordId}-${stage}`;
        const bodyEl = document.getElementById(cardBodyId);
        if (!bodyEl) return;
        const card = bodyEl.closest('.task-card');
        const iconEl = card.querySelector('.task-accordion-icon');

        // 제출하지 않은 상태에서 작성 중인 내용이 있는지 체크 (닫기 경고)
        const isCompleted = card.classList.contains('completed');
        if (!isCompleted) {
            const hasChecked = card.querySelectorAll('.checklist-list .check-item.checked').length > 0;
            const hasImage = card.querySelectorAll('.photo-slot.has-image').length > 0;
            if (hasChecked || hasImage) {
                if (!confirm("아직 완료 보고서를 제출하지 않았습니다. 정말로 창을 닫으시겠습니까?")) {
                    return; // 닫기 취소
                }
            }
        }
        
        bodyEl.style.display = 'none';
        if (iconEl) iconEl.textContent = '▼';
        
        const cardKey = `${recordId}-${stage}`;
        expandedCardIds.delete(cardKey);
    };

    // 임시 캐시 초기화 함수 (사장님 테스트용 - 로컬 캐시 및 에어테이블 내역 리셋)
    window.clearNoticeCache = async function() {
        if (!confirm("정말로 이 현장의 모든 작업 데이터(체크리스트, 사진 포함)를 초기화하시겠습니까?")) return;

        showLoading("서버 데이터 초기화 중...");
        
        try {
            // 1. 로컬 스토리지 정리
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('notice_') || key.startsWith('notice_reported_')) {
                    localStorage.removeItem(key);
                }
            });

            // 2. 현재 현장에 배정된 모든 태스크들을 순회하며 초기화 요청 전송 (Airtable 클리어)
            const tasks = projectData.tasks || [];
            const promises = tasks.map(task => {
                return fetch(API_SAVE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        projectCode: projectRecordId,
                        recordId: task.id,
                        type: 'reset_task'
                    })
                });
            });

            // 모든 초기화 요청이 완료될 때까지 대기
            await Promise.all(promises);

            showToast("모든 내역이 깨끗하게 초기화되었습니다!", "success");
            
            // 3. 현장 데이터 리로드
            await loadProjectData(projectRecordId);

        } catch (error) {
            console.error(error);
            showToast("초기화 처리 중 에러가 발생했습니다.", "danger");
        } finally {
            hideLoading();
        }
    };
});

