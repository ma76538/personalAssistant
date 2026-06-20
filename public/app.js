const state = { tasks: [], summary: null, reminderPolicy: null, calendarSettings: null, workSettings: null, search: "" };
const $ = (id) => document.getElementById(id);

const matrixEl = $("matrix");
const pendingBucketListEl = $("pending-bucket-list");
const pendingBucketCountEl = $("pending-bucket-count");
const quickWinsListEl = $("quick-wins-list");
const quickWinsCountEl = $("quick-wins-count");
const ganttBoardEl = $("gantt-board");
const ganttCountEl = $("gantt-count");
const calendarBoardEl = $("calendar-board");
const calendarStatusEl = $("calendar-status");
const completedListEl = $("completed-list");
const metricsEl = $("metrics");
const focusListEl = $("focus-list");
const lastUpdatedEl = $("last-updated");
const drawerEl = $("drawer");
const drawerBackdropEl = $("drawer-backdrop");
const taskFormEl = $("task-form");
const drawerTitleEl = $("drawer-title");
const reminderSettingsFormEl = $("reminder-settings-form");
const reminderSettingsStatusEl = $("reminder-settings-status");
const calendarSettingsStatusEl = $("calendar-settings-status");
const workCapacityStatusEl = $("work-capacity-status");
const pendingReviewStatusEl = $("pending-review-status");

let draggedTaskId = null;
let pointerDrag = null;
let lastMovedTaskId = null;
let lastDueWarningTaskId = null;
let reminderSettingsSaveTimer = null;
let editingTask = null;

$("refresh").addEventListener("click", loadDashboard);
$("new-task").addEventListener("click", () => openEditor());
$("close-drawer").addEventListener("click", closeEditor);
$("cancel-edit").addEventListener("click", closeEditor);
drawerBackdropEl.addEventListener("click", closeEditor);
$("clear-completed").addEventListener("click", clearCompletedBin);
$("save-calendar-settings").addEventListener("click", saveCalendarSettings);
$("save-work-capacity")?.addEventListener("click", saveWorkCapacity);
$("run-pending-review")?.addEventListener("click", runPendingReview);
reminderSettingsFormEl.addEventListener("input", scheduleReminderSettingsSave);
reminderSettingsFormEl.addEventListener("change", scheduleReminderSettingsSave);
$("reset-reminder-settings").addEventListener("click", resetReminderSettings);
["earliestStart", "deadline"].forEach((id) => {
  const input = $(id);
  input?.addEventListener("click", () => input.showPicker?.());
});
document.querySelectorAll(".side-nav a").forEach((link) =>
  link.addEventListener("click", () => {
    document.querySelectorAll(".side-nav a").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  })
);

matrixEl.addEventListener("click", handleTaskButtonClick);
matrixEl.addEventListener("dragstart", handleDragStart);
matrixEl.addEventListener("dragend", handleDragEnd);
matrixEl.addEventListener("dragover", (event) => {
  const quadrant = event.target.closest(".matrix-card");
  if (!quadrant || !draggedTaskId) return;
  event.preventDefault();
  quadrant.classList.add("drop-target");
});
matrixEl.addEventListener("dragleave", (event) => event.target.closest(".matrix-card")?.classList.remove("drop-target"));
matrixEl.addEventListener("drop", async (event) => {
  const quadrant = event.target.closest(".matrix-card");
  if (!quadrant || !draggedTaskId) return;
  event.preventDefault();
  quadrant.classList.remove("drop-target");
  await moveTaskToQuadrant(draggedTaskId, quadrant);
});
matrixEl.addEventListener("pointerdown", handlePointerDragStart);
document.addEventListener("pointerup", handlePointerDragEnd);

quickWinsListEl.addEventListener("click", handleTaskButtonClick);
quickWinsListEl.addEventListener("dragstart", handleDragStart);
quickWinsListEl.addEventListener("dragend", handleDragEnd);
quickWinsListEl.addEventListener("dragover", (event) => {
  if (!draggedTaskId) return;
  event.preventDefault();
  quickWinsListEl.classList.add("drop-target");
});
quickWinsListEl.addEventListener("dragleave", () => quickWinsListEl.classList.remove("drop-target"));
quickWinsListEl.addEventListener("drop", async (event) => {
  if (!draggedTaskId) return;
  event.preventDefault();
  quickWinsListEl.classList.remove("drop-target");
  await moveTaskToQuickWins(draggedTaskId);
  await loadDashboard();
});
quickWinsListEl.addEventListener("pointerdown", handlePointerDragStart);
pendingBucketListEl.addEventListener("click", handleTaskButtonClick);

completedListEl.addEventListener("click", handleTaskButtonClick);
completedListEl.addEventListener("dragstart", handleDragStart);
completedListEl.addEventListener("dragend", handleDragEnd);
completedListEl.addEventListener("dragover", (event) => {
  if (!draggedTaskId) return;
  event.preventDefault();
  completedListEl.classList.add("drop-target");
});
completedListEl.addEventListener("dragleave", () => completedListEl.classList.remove("drop-target"));
completedListEl.addEventListener("drop", async (event) => {
  if (!draggedTaskId) return;
  event.preventDefault();
  completedListEl.classList.remove("drop-target");
  await updateTaskStatus(draggedTaskId, "done");
  await loadDashboard();
});

taskFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = formPayload();
    const id = $("task-id").value;
    await requestJson(id ? `/api/tasks/${id}` : "/api/tasks", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    closeEditor();
    await loadDashboard();
  } catch (error) {
    lastUpdatedEl.textContent = error instanceof Error ? `儲存失敗：${error.message}` : "儲存失敗";
  }
});

async function clearCompletedBin() {
  const response = await requestJson("/api/tasks/completed", { method: "DELETE" });
  await loadDashboard();
  lastUpdatedEl.textContent = `已清空完成箱：刪除 ${response.deleted || 0} 項`;
}

async function handleTaskButtonClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "new") return openEditor();
  const id = Number(button.dataset.id);
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  if (button.dataset.action === "edit") return openEditor(task);
  if (button.dataset.action === "delete") await requestJson(`/api/tasks/${id}`, { method: "DELETE" });
  if (button.dataset.action === "restore") await restoreToUrgentImportant(task);
  if (button.dataset.action === "pending-bucket") await moveTaskToPendingBucket(task);
  if (button.dataset.action === "quadrant") await updateTaskQuadrant(id, button.dataset.quadrant);
  if (button.dataset.action === "status") await updateTaskStatus(id, button.dataset.status);
  if (button.dataset.action === "check-in") await checkInTask(id, button.dataset.outcome || "defer");
  if (button.dataset.action === "next-action") await previewNextAction(id);
  await loadDashboard();
}

async function updateTaskStatus(id, status) {
  await requestJson(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
}

async function updateTaskQuadrant(id, quadrant) {
  await requestJson(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      quadrant,
      priority: quadrant === "urgent-important" || quadrant === "not-urgent-important" ? 5 : 2,
      status: "pending"
    })
  });
}

async function moveTaskToPendingBucket(task) {
  await requestJson(`/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ quadrant: null, status: "pending", scheduledStart: null, scheduledEnd: null })
  });
}

async function moveTaskToQuickWins(taskId) {
  await requestJson(`/api/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify({ durationMinutes: 2, status: "pending" })
  });
}

async function restoreToUrgentImportant(task) {
  await requestJson(`/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "pending",
      quadrant: "urgent-important",
      priority: 5,
      deadline: task.deadline || new Date(Date.now() + 3 * 86400000).toISOString()
    })
  });
}

async function moveTaskToQuadrant(taskId, quadrant) {
  const task = state.tasks.find((item) => item.id === Number(taskId));
  if (!task || !quadrant?.dataset?.quadrant) return;
  const targetQuadrant = quadrant.dataset.quadrant;
  const payload = {
    quadrant: targetQuadrant,
    priority: quadrant.dataset.important === "true" ? 5 : 2,
    status: "pending"
  };
  if (task.durationMinutes <= 2) payload.durationMinutes = 30;
  await requestJson(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload) });
  lastMovedTaskId = task.id;
  lastDueWarningTaskId = isUrgentQuadrant(targetQuadrant) && !task.deadline ? task.id : null;
  await loadDashboard();
  if (lastDueWarningTaskId) {
    lastUpdatedEl.textContent = `「${task.title}」已移到緊急象限，請補回 Due Date。`;
  } else {
    lastUpdatedEl.textContent = `已移動「${task.title}」到${quadrant.querySelector("h2")?.textContent?.trim() || "新象限"}`;
  }
}

function handleDragStart(event) {
  const card = event.target.closest(".task-row,.quick-task,.completed-task");
  if (!card) return;
  draggedTaskId = Number(card.dataset.id);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(draggedTaskId));
  card.classList.add("dragging");
}

function handleDragEnd(event) {
  event.target.closest(".task-row,.quick-task,.completed-task")?.classList.remove("dragging");
  document.querySelectorAll(".drop-target").forEach((item) => item.classList.remove("drop-target"));
  draggedTaskId = null;
}

function handlePointerDragStart(event) {
  if (event.target.closest("button, input, select, textarea, a")) return;
  const card = event.target.closest(".task-row,.quick-task,.completed-task");
  if (!card) return;
  pointerDrag = {
    id: Number(card.dataset.id),
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    card
  };
}

async function handlePointerDragEnd(event) {
  if (!pointerDrag) return;
  const drag = pointerDrag;
  pointerDrag = null;
  const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
  if (distance < 12) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".matrix-card");
  const quickWinsTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest("#quick-wins");
  if (quickWinsTarget) {
    await moveTaskToQuickWins(drag.id);
    await loadDashboard();
    return;
  }
  if (!target) return;
  await moveTaskToQuadrant(drag.id, target);
}

async function loadDashboard() {
  const [summaryResponse, tasksResponse, reminderResponse, calendarSettingsResponse, workSettingsResponse] = await Promise.all([
    fetch("/api/summary"),
    fetch("/api/tasks"),
    fetch("/api/reminder-settings"),
    fetch("/api/calendar-settings"),
    fetch("/api/work-capacity")
  ]);
  state.summary = await summaryResponse.json();
  state.tasks = (await tasksResponse.json()).tasks;
  state.reminderPolicy = (await reminderResponse.json()).policy;
  state.calendarSettings = await calendarSettingsResponse.json();
  state.workSettings = await workSettingsResponse.json();
  render();
}

function render() {
  renderMetrics();
  renderQuickWins();
  renderMatrix();
  renderPendingBucket();
  renderGantt();
  renderCalendar();
  renderCompletedBin();
  renderFocusList();
  renderReminderSettings();
  renderCalendarSettings();
  renderWorkSettings();
  lastUpdatedEl.textContent = `更新於 ${new Intl.DateTimeFormat("zh-Hant", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date())}`;
}

function renderPendingBucket() {
  const tasks = filtered(state.summary?.pendingBucket || []).filter((task) => !isQuickWin(task));
  pendingBucketCountEl.textContent = String(tasks.length);
  pendingBucketListEl.innerHTML = tasks.length
    ? tasks.map(pendingTask).join("")
    : `<div class="drop-empty">沒有待定任務。未決定幾時做的事會放在這裡。</div>`;
}

function pendingTask(task) {
  return `<article class="pending-task priority-${task.priority}" data-id="${task.id}">
    <span class="priority-bar"></span>
    <div class="pending-task-content">
      <div class="pending-task-main">
        <strong>${esc(task.title)}</strong>
        <small>${task.deadline ? `Due ${shortMonthDay(task.deadline)}` : "未決定時間，不進排程"}</small>
      </div>
      ${taskMeta(task)}
    </div>
    <div class="pending-actions">
      <button data-action="quadrant" data-quadrant="urgent-important" data-id="${task.id}" title="緊急重要" type="button">緊重</button>
      <button data-action="quadrant" data-quadrant="urgent-not-important" data-id="${task.id}" title="緊急不重要" type="button">緊不重</button>
      <button data-action="quadrant" data-quadrant="not-urgent-important" data-id="${task.id}" title="不緊急重要" type="button">不緊重</button>
      <button data-action="quadrant" data-quadrant="not-urgent-not-important" data-id="${task.id}" title="不緊急不重要" type="button">不緊不重</button>
      <button data-action="edit" data-id="${task.id}" type="button">編輯</button>
      <button data-action="check-in" data-outcome="complete" data-id="${task.id}" type="button">完成</button>
    </div>
  </article>`;
}

function filtered(tasks) {
  if (!state.search) return tasks;
  return tasks.filter((task) => [task.title, task.context, task.status].filter(Boolean).join(" ").toLowerCase().includes(state.search));
}

function renderMetrics() {
  if (!metricsEl) return;
  const summary = state.summary || {};
  const total = summary.total || 0;
  const active = summary.active || 0;
  const inProgress = summary.byStatus?.in_progress || 0;
  const today = summary.today?.length || 0;
  const overdue = summary.overdue || 0;
  const done = summary.done || 0;
  const cards = [
    ["total", "全部", total, "任務庫", total ? 100 : 0],
    ["progress", "進行中", inProgress, `${active} 個未完成`, ratio(inProgress, Math.max(active, 1))],
    ["today", "今日", today, "已安排", ratio(today, Math.max(active, 1))],
    ["overdue", "逾期", overdue, overdue ? "需要處理" : "目前清爽", ratio(overdue, Math.max(active, 1))]
  ];
  metricsEl.innerHTML = `<div class="metrics-board">
    ${cards
      .map(
        ([tone, label, value, caption, progress]) => `<article class="metric-card ${tone}">
          <div class="metric-icon">${metricIcon(tone)}</div>
          <div class="metric-copy"><span>${label}</span><strong>${value}</strong><small>${caption}</small></div>
          <div class="metric-ring" style="--value:${Math.max(4, Math.min(100, progress))}%"><b>${progress}%</b></div>
        </article>`
      )
      .join("")}
    <article class="metric-card done"><div class="metric-icon">✓</div><div class="metric-copy"><span>完成</span><strong>${done}</strong><small>已歸檔</small></div><div class="metric-spark"><i style="width:${Math.max(8, ratio(done, Math.max(total, 1)))}%"></i></div></article>
  </div>`;
}

function renderMatrix() {
  const quadrants = state.summary?.quadrants || {};
  const config = [
    ["urgent-important", "⏰", "緊急重要", "立即處理", true, true],
    ["urgent-not-important", "🔔", "緊急不重要", "快速處理", true, false],
    ["not-urgent-important", "☆", "不緊急重要", "安排深度時間", false, true],
    ["not-urgent-not-important", "♧", "不緊急不重要", "延後或刪減", false, false]
  ];

  matrixEl.innerHTML = config
    .map(([key, icon, title, subtitle, urgent, important]) => {
      const tasks = prioritizeVisibleTasks(filtered(quadrants[key] || []).filter((task) => !isQuickWin(task)));
      return `<section class="matrix-card ${key}" data-quadrant="${key}" data-urgent="${urgent}" data-important="${important}">
        <header class="matrix-head"><div class="matrix-title-line"><h2><span>${icon}</span>${title}</h2><em>${subtitle}</em></div><strong>${tasks.length}</strong></header>
        <div class="matrix-list">${tasks.length ? tasks.map((task, index) => taskRow(task, index + 1)).join("") : `<div class="drop-empty">拖拉任務到這裡</div>`}</div>
      </section>`;
    })
    .join("");
}

function renderQuickWins() {
  const tasks = filtered(state.tasks).filter((task) => isQuickWin(task));
  quickWinsCountEl.textContent = String(tasks.length);
  quickWinsListEl.innerHTML = tasks.length
    ? tasks.map(quickWinRow).join("")
    : `<div class="drop-empty">沒有 2 分鐘內可完成的任務。</div>`;
}

function quickWinRow(task) {
  return `<article class="quick-task priority-${task.priority}" draggable="true" data-id="${task.id}">
    <span class="priority-bar"></span>
    <div class="quick-task-main">
      <strong>${esc(task.title)}</strong>
      <small>${task.deadline ? `Due ${shortMonthDay(task.deadline)}` : "立即處理的小任務"}</small>
    </div>
    <button class="quick-done" data-action="status" data-status="done" data-id="${task.id}" type="button">完成</button>
  </article>`;
}

function isQuickWin(task) {
  return task.durationMinutes <= 2 && !["done", "cancelled"].includes(task.status);
}

function prioritizeVisibleTasks(tasks) {
  if (!lastMovedTaskId) return tasks;
  return [...tasks].sort((a, b) => {
    if (a.id === lastMovedTaskId) return -1;
    if (b.id === lastMovedTaskId) return 1;
    return 0;
  });
}

function taskRow(task, rank) {
  const status = normalizeStatusValue(task.status);
  const urgentMissingDue = !task.deadline;
  const needsDue = urgentMissingDue || lastDueWarningTaskId === task.id;
  const startMarkup = task.earliestStart ? `<span>Start Date ${shortDate(task.earliestStart)}</span>` : "";
  return `<article class="task-row priority-${task.priority} ${needsDue ? "needs-due" : ""}" draggable="true" data-id="${task.id}">
    <span class="priority-bar"></span>
    <span class="task-rank">${rank}</span>
    <div class="task-main">
      <strong>${esc(task.title)}</strong>
      ${taskMeta(task)}
      ${startMarkup ? `<div class="task-dates">${startMarkup}</div>` : ""}
      ${needsDue ? `<p class="due-warning">每個任務都必須加 Due Date，未補前不會自動排程。</p>` : ""}
    </div>
    <div class="matrix-status-actions" aria-label="改變任務狀態">
      ${dueChip(task, needsDue)}
      <button class="${status === "in_progress" ? "active" : ""}" data-action="status" data-status="in_progress" data-id="${task.id}" type="button">進行中</button>
      <button data-action="check-in" data-outcome="complete" data-id="${task.id}" type="button">完成</button>
      <button data-action="check-in" data-outcome="stuck" data-id="${task.id}" type="button">卡住</button>
      <button data-action="check-in" data-outcome="defer" data-id="${task.id}" type="button">延後</button>
      ${task.isProject ? `<button data-action="next-action" data-id="${task.id}" type="button">下一步</button>` : ""}
      <button data-action="pending-bucket" data-id="${task.id}" type="button">放待定</button>
      <button data-action="edit" data-id="${task.id}" type="button">編輯</button>
    </div>
  </article>`;
}

function renderGantt() {
  const segments = state.summary?.scheduleSegments || [];
  const calendar = state.summary?.calendar || { events: [] };
  const items = [
    ...segments.map((segment) => ({ type: "task", ...segment, task: state.tasks.find((task) => task.id === segment.taskId) })),
    ...(calendar.events || []).filter((event) => !event.allDay).map((event) => ({ type: "busy", scheduledStart: event.start, scheduledEnd: event.end, title: event.title }))
  ]
    .filter((item) => item.scheduledStart && item.scheduledEnd)
    .sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart))
    .slice(0, 40);
  if (ganttCountEl) ganttCountEl.textContent = String(items.length);

  ganttBoardEl.innerHTML = items.length
    ? items
        .map((item) => {
          const start = new Date(item.scheduledStart);
          const end = new Date(item.scheduledEnd);
          const left = ganttLeft(start);
          const width = Math.max(6, ((end - start) / 60000 / (12 * 60)) * 100);
          const task = item.task;
          const title = item.type === "busy" ? item.title : task?.title || `#${item.taskId}`;
          const meta =
            item.type === "busy"
              ? "Calendar"
              : item.segmentCount > 1
                ? `第 ${item.segmentIndex}/${item.segmentCount} 段`
                : "任務";
          const badges =
            item.type === "busy"
              ? `<span class="gantt-time">${shortMonthDay(item.scheduledStart)} ${timeRange(item.scheduledStart, item.scheduledEnd)}</span><span class="gantt-calendar-badge">日曆</span>`
              : `<span class="gantt-time">${shortMonthDay(item.scheduledStart)} ${timeRange(item.scheduledStart, item.scheduledEnd)}</span>
                <span class="gantt-importance priority-${task?.priority ?? 3}"><i></i>重要 ${task?.valueScore ?? 3}</span>
                <span class="gantt-priority">優先 ${task?.priority ?? 3}</span>
                ${task?.quadrant ? `<span>${quadrantLabel(task.quadrant)}</span>` : ""}`;
          return `<article class="gantt-row ${item.type} priority-${task?.priority ?? 3}">
            <div class="gantt-label"><strong>${esc(title)}</strong><small>${meta}</small><div class="gantt-badges">${badges}</div></div>
            <div class="gantt-track"><span style="left:${left}%;width:${width}%"></span></div>
          </article>`;
        })
        .join("")
    : `<div class="drop-empty">暫時沒有可排程的工作段。四象限任務需要 Due Date，並且不是已完成/取消，才會進甘特圖。</div>`;
}

function ganttLeft(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  return Math.max(0, Math.min(94, ((hour - 8) / 12) * 100));
}

function dueChip(task, needsDue = false) {
  if (task.deadline) {
    return `<button class="due-chip" data-action="edit" data-id="${task.id}" type="button" title="編輯 Due Date">${shortMonthDay(task.deadline)}</button>`;
  }
  if (needsDue) {
    return `<button class="due-chip missing" data-action="edit" data-id="${task.id}" type="button" title="補回 Due Date">加 Due</button>`;
  }
  return "";
}

function taskMeta(task) {
  const chips = [
    `<span>價值 ${task.valueScore ?? 3}</span>`,
    `<span>${deadlineTypeLabel(task.deadlineType)}</span>`,
    task.isProject ? "<span>項目</span>" : "",
    task.projectId ? `<span>屬於 #${task.projectId}</span>` : ""
  ].filter(Boolean);
  return `<div class="task-tags meta-tags">${chips.join("")}</div>`;
}

function renderCompletedBin() {
  const completed = filtered(state.summary?.completed || state.tasks.filter((task) => task.status === "done")).slice(0, 30);
  completedListEl.innerHTML = completed.length
    ? completed.map(completedTask).join("")
    : `<div class="drop-empty">完成的項目會放在這裡</div>`;
}

function completedTask(task) {
  return `<article class="completed-task priority-${task.priority}" draggable="true" data-id="${task.id}">
    <span class="priority-bar"></span>
    <div><strong>${esc(task.title)}</strong><p>已完成</p></div>
    <div class="task-side">
      <button data-action="restore" data-id="${task.id}" type="button">移回待定</button>
      <button data-action="edit" data-id="${task.id}" type="button">編輯</button>
    </div>
  </article>`;
}

function renderCalendar() {
  const days = calendarMonthDays(new Date());
  const monthTasks = state.summary?.month || [];
  const calendar = state.summary?.calendar || { accountEmail: "kevin@region.mo", connected: false, events: [] };
  const calendarMode = calendar.matchMode === "google-source-fallback" ? "｜Google source fallback" : "";
  calendarStatusEl.textContent = calendar.connected
    ? `已連結 ${calendar.accountEmail}${calendarMode}`
    : `未連結 ${calendar.accountEmail}${calendar.error ? `：${calendar.error}` : ""}`;
  calendarBoardEl.innerHTML = days
    .map((day) => {
      const tasks = monthTasks.filter((task) => sameLocalDay(task.deadline, day));
      const events = (calendar.events || []).filter((event) => sameLocalDay(event.start, day));
      const isOutside = day.getMonth() !== new Date().getMonth();
      return `<article class="calendar-day ${sameLocalDay(day.toISOString(), new Date()) ? "today" : ""} ${isOutside ? "outside-month" : ""}">
        <header><span>${weekdayLabel(day)}</span><strong>${shortMonthDay(day.toISOString())}</strong></header>
        <div class="calendar-items">${
          tasks.length || events.length
            ? [
                ...events.map((event) => `<div class="calendar-item event"><i></i><span>${event.allDay ? "全日" : timeRange(event.start, event.end)}</span><strong>${esc(event.title)}</strong></div>`),
                ...tasks.map((task) => `<div class="calendar-item priority-${task.priority}"><i class="priority-bar"></i><span>Due ${fmtTime(task.deadline)}</span><strong>${esc(task.title)}</strong></div>`)
              ].join("")
            : `<p>未安排</p>`
        }</div>
      </article>`;
    })
    .join("");
}

function renderCalendarSettings() {
  const settings = state.calendarSettings;
  if (!settings) return;
  setValue("calendar-account-email", settings.accountEmail);
  calendarSettingsStatusEl.textContent = `${settings.provider || "apple-calendar"}｜${settings.oauthStatus || "not_required"}`;
  const note = $("calendar-oauth-note");
  if (note) note.textContent = settings.note || "日曆設定已載入。";
}

function renderWorkSettings() {
  const settings = state.workSettings || state.summary?.workSettings;
  if (!settings) return;
  setValue("work-capacity-hours", settings.dailyWorkCapacityHours);
  setChecked("secretary-mvp-mode", settings.secretaryMvpMode);
  if (workCapacityStatusEl) {
    workCapacityStatusEl.textContent = `每日容量 ${settings.dailyWorkCapacityHours} 小時｜${settings.secretaryMvpMode ? "電子秘書 MVP 最高價值" : "一般排序"}`;
  }
}

async function saveWorkCapacity() {
  try {
    const response = await requestJson("/api/work-capacity", {
      method: "PUT",
      body: JSON.stringify({
        dailyWorkCapacityHours: Number($("work-capacity-hours").value),
        secretaryMvpMode: $("secretary-mvp-mode").checked
      })
    });
    state.workSettings = response;
    state.tasks = response.tasks || state.tasks;
    await loadDashboard();
    workCapacityStatusEl.textContent = "每日容量已儲存，未開始任務已重排。";
  } catch (error) {
    workCapacityStatusEl.textContent = error instanceof Error ? `儲存失敗：${error.message}` : "儲存失敗";
  }
}

async function runPendingReview() {
  try {
    const response = await requestJson("/api/pending-review", {
      method: "POST",
      body: JSON.stringify({ limit: 8 })
    });
    const items = response.items || [];
    setReviewStatus(
      items.length
        ? `<strong>待定整理建議</strong>${items.map((item) => `<p>#${item.task.id} ${esc(item.task.title)} → ${quadrantLabel(item.suggestion.recommendedQuadrant)}｜價值 ${item.suggestion.valueScore}｜${esc(item.suggestion.reason)}</p>`).join("")}`
        : "<p>目前沒有待定任務需要整理。</p>"
    );
  } catch (error) {
    setReviewStatus(error instanceof Error ? `整理失敗：${error.message}` : "整理失敗", false);
  }
}

async function checkInTask(id, outcome) {
  const note =
    outcome === "complete"
      ? ""
      : window.prompt(outcome === "stuck" ? "卡在哪？" : "延後原因或新線索？") || "";
  const response = await requestJson(`/api/tasks/${id}/check-in`, {
    method: "POST",
    body: JSON.stringify({ outcome, note })
  });
  if (response.nextActionPreview) {
    setReviewStatus(`<strong>下一步建議</strong><p>${esc(response.nextActionPreview.title)}｜${response.nextActionPreview.durationMinutes} 分鐘</p><p>${esc(response.nextActionPreview.reason)}</p>`);
  }
}

async function previewNextAction(id) {
  const note = window.prompt("補充目前進度或卡點（可留空）") || "";
  const response = await requestJson(`/api/projects/${id}/next-action-preview`, {
    method: "POST",
    body: JSON.stringify({ progressNote: note })
  });
  setReviewStatus(`<strong>下一步建議</strong><p>${esc(response.action.title)}｜${response.action.durationMinutes} 分鐘</p><p>${esc(response.action.reason)}</p>`);
}

function setReviewStatus(content, asHtml = true) {
  if (pendingReviewStatusEl) {
    if (asHtml) pendingReviewStatusEl.innerHTML = content;
    else pendingReviewStatusEl.textContent = content;
    return;
  }
  lastUpdatedEl.textContent = asHtml ? content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : content;
}

async function saveCalendarSettings() {
  try {
    const response = await requestJson("/api/calendar-settings", {
      method: "PUT",
      body: JSON.stringify({ accountEmail: $("calendar-account-email").value.trim() })
    });
    state.calendarSettings = response;
    renderCalendarSettings();
    await loadDashboard();
    lastUpdatedEl.textContent = "日曆設定已儲存，已重新載入月曆。";
  } catch (error) {
    calendarSettingsStatusEl.textContent = error instanceof Error ? `儲存失敗：${error.message}` : "儲存失敗";
  }
}

function renderFocusList() {
  const priorities = state.summary?.topPriorities || [];
  focusListEl.innerHTML = priorities.length
    ? priorities.slice(0, 5).map((task, index) => `<article class="focus-item"><span>${index + 1}</span><strong>#${task.id} ${esc(task.title)}</strong><small>${esc(task.reason || "")}</small></article>`).join("")
    : `<div class="empty">目前沒有未完成任務。</div>`;
}

function openEditor(task = null) {
  editingTask = task;
  drawerTitleEl.textContent = task ? `編輯 #${task.id}` : "新增任務";
  $("task-id").value = task?.id ?? "";
  $("title").value = task?.title ?? "";
  $("task-quadrant").value = task?.quadrant ?? "pending-bucket";
  $("quick-win-toggle").checked = Boolean(task && task.durationMinutes <= 2);
  $("earliestStart").value = toLocalInputValue(task?.earliestStart);
  $("deadline").value = toLocalInputValue(task?.deadline);
  $("value-score").value = task?.valueScore ?? 3;
  $("deadline-type").value = task?.deadlineType ?? "none";
  $("is-project").checked = Boolean(task?.isProject);
  $("project-id").value = task?.projectId ?? "";
  $("progress-note").value = task?.progressNote ?? "";
  drawerBackdropEl.hidden = false;
  drawerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeEditor() {
  editingTask = null;
  drawerBackdropEl.hidden = true;
  drawerEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  taskFormEl.reset();
}

function formPayload() {
  const payload = {
    title: $("title").value.trim(),
    quadrant: $("task-quadrant").value === "pending-bucket" ? null : $("task-quadrant").value,
    earliestStart: fromLocalInputValue($("earliestStart").value),
    deadline: fromLocalInputValue($("deadline").value),
    valueScore: Number($("value-score").value),
    deadlineType: $("deadline-type").value,
    isProject: $("is-project").checked,
    projectId: $("project-id").value ? Number($("project-id").value) : null,
    progressNote: $("progress-note").value.trim() || null
  };
  if ($("quick-win-toggle").checked) {
    payload.durationMinutes = 2;
  } else if (editingTask?.durationMinutes <= 2) {
    payload.durationMinutes = 30;
  }
  return payload;
}

function renderReminderSettings() {
  const policy = state.reminderPolicy;
  if (!policy) return;
  setValue("reminder-intensity", policy.intensity);
  setChecked("before-start-enabled", policy.beforeStart.enabled);
  setValue("before-start-minutes", policy.beforeStart.minutes.join(", "));
  setChecked("start-enabled", policy.start.enabled);
  setChecked("start-require-response", policy.start.requireResponse);
  setChecked("in-progress-enabled", policy.inProgress.enabled);
  setValue("in-progress-interval", policy.inProgress.intervalMinutes);
  setChecked("end-enabled", policy.end.enabled);
  setChecked("unanswered-enabled", policy.unanswered.enabled);
  setValue("unanswered-minutes", policy.unanswered.minutes.join(", "));
  setChecked("quiet-enabled", policy.quietHours.enabled);
  setValue("quiet-start", policy.quietHours.start);
  setValue("quiet-end", policy.quietHours.end);
  setChecked("high-priority-enabled", policy.highPriority.enabled);
  setValue("high-priority-extra", policy.highPriority.extraBeforeStartMinutes.join(", "));
  reminderSettingsStatusEl.textContent = "提醒設定已載入";
}

function scheduleReminderSettingsSave() {
  clearTimeout(reminderSettingsSaveTimer);
  reminderSettingsStatusEl.textContent = "準備儲存...";
  reminderSettingsSaveTimer = setTimeout(saveReminderSettings, 500);
}

async function saveReminderSettings() {
  try {
    const response = await requestJson("/api/reminder-settings", { method: "PUT", body: JSON.stringify(reminderSettingsPayload()) });
    state.reminderPolicy = response.policy;
    reminderSettingsStatusEl.textContent = "提醒設定已儲存，下一分鐘生效";
  } catch (error) {
    reminderSettingsStatusEl.textContent = error instanceof Error ? error.message : "提醒設定儲存失敗";
  }
}

async function resetReminderSettings() {
  const response = await requestJson("/api/reminder-settings/reset", { method: "POST" });
  state.reminderPolicy = response.policy;
  renderReminderSettings();
  reminderSettingsStatusEl.textContent = "已恢復預設提醒設定";
}

function reminderSettingsPayload() {
  return {
    intensity: $("reminder-intensity").value,
    beforeStart: { enabled: $("before-start-enabled").checked, minutes: minuteList($("before-start-minutes").value) },
    start: { enabled: $("start-enabled").checked, requireResponse: $("start-require-response").checked },
    inProgress: { enabled: $("in-progress-enabled").checked, intervalMinutes: Number($("in-progress-interval").value), minimumTaskMinutes: 30 },
    end: { enabled: $("end-enabled").checked },
    unanswered: { enabled: $("unanswered-enabled").checked, minutes: minuteList($("unanswered-minutes").value) },
    quietHours: { enabled: $("quiet-enabled").checked, start: $("quiet-start").value, end: $("quiet-end").value },
    highPriority: { enabled: $("high-priority-enabled").checked, threshold: 4, extraBeforeStartMinutes: minuteList($("high-priority-extra").value) }
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "操作失敗");
  return payload;
}

function minuteList(value) {
  return [...new Set(value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0))];
}

function setValue(id, value) {
  const element = $(id);
  if (element && document.activeElement !== element) element.value = value ?? "";
}

function setChecked(id, value) {
  const element = $(id);
  if (element) element.checked = Boolean(value);
}

function normalizeStatusValue(status) {
  return status === "scheduled" ? "pending" : status;
}

function ratio(value, total) {
  return Math.round((Number(value || 0) / Math.max(Number(total || 0), 1)) * 100);
}

function metricIcon(tone) {
  return { total: "▦", progress: "◐", today: "◴", overdue: "!" }[tone] || "•";
}

function isUrgentTask(task) {
  return isUrgentQuadrant(task.quadrant);
}

function isUrgentQuadrant(quadrant) {
  return quadrant === "urgent-important" || quadrant === "urgent-not-important";
}

function deadlineTypeLabel(type) {
  return { hard: "Hard deadline", soft: "Soft deadline", none: "未定 deadline" }[type || "none"] || "未定 deadline";
}

function quadrantLabel(quadrant) {
  return (
    {
      "urgent-important": "緊急重要",
      "urgent-not-important": "緊急不重要",
      "not-urgent-important": "不緊急重要",
      "not-urgent-not-important": "不緊急不重要"
    }[quadrant] || "待定"
  );
}

function timeRange(start, end) {
  return `${fmtTime(start)} - ${fmtTime(end)}`;
}

function calendarMonthDays(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 0, 0, 0, 0);
  const start = new Date(first);
  const day = start.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(first.getDate() + mondayOffset);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 0, 0, 0, 0);
  const end = new Date(last);
  const endDay = end.getDay();
  end.setDate(last.getDate() + (endDay === 0 ? 0 : 7 - endDay));
  const totalDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  return Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function sameLocalDay(value, date) {
  if (!value) return false;
  const left = value instanceof Date ? value : new Date(value);
  const right = date instanceof Date ? date : new Date(date);
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function weekdayLabel(value) {
  return new Intl.DateTimeFormat("zh-Hant", { weekday: "short" }).format(value);
}

function fmtTime(value) {
  return new Intl.DateTimeFormat("zh-Hant", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function shortDate(value) {
  return new Intl.DateTimeFormat("zh-Hant", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function shortMonthDay(value) {
  return new Intl.DateTimeFormat("zh-Hant", { day: "2-digit", month: "2-digit" }).format(new Date(value));
}

function toLocalInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function fromLocalInputValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadDashboard();
setInterval(loadDashboard, 30000);
