const state = { tasks: [], summary: null, reminderPolicy: null, search: "" };
const $ = (id) => document.getElementById(id);

const matrixEl = $("matrix");
const completedListEl = $("completed-list");
const metricsEl = $("metrics");
const timelineEl = $("timeline-list");
const focusListEl = $("focus-list");
const lastUpdatedEl = $("last-updated");
const drawerEl = $("drawer");
const drawerBackdropEl = $("drawer-backdrop");
const taskFormEl = $("task-form");
const drawerTitleEl = $("drawer-title");
const reminderSettingsFormEl = $("reminder-settings-form");
const reminderSettingsStatusEl = $("reminder-settings-status");

let draggedTaskId = null;
let reminderSettingsSaveTimer = null;

$("refresh").addEventListener("click", loadDashboard);
$("new-task").addEventListener("click", () => openEditor());
$("close-drawer").addEventListener("click", closeEditor);
$("cancel-edit").addEventListener("click", closeEditor);
drawerBackdropEl.addEventListener("click", closeEditor);
$("task-search").addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  render();
});
$("sync-todo").addEventListener("click", syncTodoList);
$("clear-completed").addEventListener("click", clearCompletedBin);
$("replan").addEventListener("click", async () => {
  await requestJson("/api/replan", { method: "POST" });
  await loadDashboard();
});
reminderSettingsFormEl.addEventListener("input", scheduleReminderSettingsSave);
reminderSettingsFormEl.addEventListener("change", scheduleReminderSettingsSave);
$("reset-reminder-settings").addEventListener("click", resetReminderSettings);
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
  const task = state.tasks.find((item) => item.id === draggedTaskId);
  if (!task) return;

  const payload = {
    quadrant: quadrant.dataset.quadrant,
    priority: quadrant.dataset.important === "true" ? 5 : 2,
    status: "pending"
  };
  if (quadrant.dataset.urgent === "true" && !task.deadline) {
    payload.deadline = new Date(Date.now() + 3 * 86400000).toISOString();
  }
  await requestJson(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload) });
  await loadDashboard();
});

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

async function syncTodoList() {
  const button = $("sync-todo");
  const oldText = button.textContent;
  button.textContent = "同步中";
  button.disabled = true;
  try {
    const payload = await requestJson("/api/sync/apple-reminders", {
      method: "POST",
      body: JSON.stringify({ listName: $("todo-list-name").value.trim() || "全部" })
    });
    await loadDashboard();
    lastUpdatedEl.textContent = `已同步 ${payload.imported} 項，完成 ${payload.completed || 0} 項，刪除 ${payload.deleted || 0} 項`;
  } catch (error) {
    lastUpdatedEl.textContent = error instanceof Error ? error.message : "同步失敗";
  } finally {
    button.textContent = oldText;
    button.disabled = false;
  }
}

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
  if (button.dataset.action === "status") await updateTaskStatus(id, button.dataset.status);
  await loadDashboard();
}

async function updateTaskStatus(id, status) {
  await requestJson(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
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

function handleDragStart(event) {
  const card = event.target.closest(".task-row,.completed-task");
  if (!card) return;
  draggedTaskId = Number(card.dataset.id);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(draggedTaskId));
  card.classList.add("dragging");
}

function handleDragEnd(event) {
  event.target.closest(".task-row,.completed-task")?.classList.remove("dragging");
  document.querySelectorAll(".drop-target").forEach((item) => item.classList.remove("drop-target"));
  draggedTaskId = null;
}

async function loadDashboard() {
  const [summaryResponse, tasksResponse, reminderResponse] = await Promise.all([
    fetch("/api/summary"),
    fetch("/api/tasks"),
    fetch("/api/reminder-settings")
  ]);
  state.summary = await summaryResponse.json();
  state.tasks = (await tasksResponse.json()).tasks;
  state.reminderPolicy = (await reminderResponse.json()).policy;
  render();
}

function render() {
  renderMetrics();
  renderMatrix();
  renderCompletedBin();
  renderTimeline();
  renderFocusList();
  renderReminderSettings();
  lastUpdatedEl.textContent = `更新於 ${new Intl.DateTimeFormat("zh-Hant", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date())}`;
}

function filtered(tasks) {
  if (!state.search) return tasks;
  return tasks.filter((task) => [task.title, task.context, task.status].filter(Boolean).join(" ").toLowerCase().includes(state.search));
}

function renderMetrics() {
  const summary = state.summary || {};
  metricsEl.innerHTML = `<span>全部 ${summary.total || 0}</span><span>進行中 ${summary.byStatus?.in_progress || 0}</span><span>今日 ${summary.today?.length || 0}</span><span class="danger">逾期 ${summary.overdue || 0}</span>`;
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
      const tasks = filtered(quadrants[key] || []).slice(0, 8);
      return `<section class="matrix-card ${key}" data-quadrant="${key}" data-urgent="${urgent}" data-important="${important}">
        <header class="matrix-head"><div><h2><span>${icon}</span>${title}</h2><p>${subtitle}</p></div><strong>${tasks.length}</strong></header>
        <div class="matrix-list">${tasks.length ? tasks.map((task, index) => taskRow(task, index + 1)).join("") : `<div class="drop-empty">拖拉任務到這裡</div>`}</div>
      </section>`;
    })
    .join("");
}

function taskRow(task, rank) {
  const status = normalizeStatusValue(task.status);
  return `<article class="task-row priority-${task.priority}" draggable="true" data-id="${task.id}">
    <span class="priority-bar"></span>
    <span class="task-rank">${rank}</span>
    <div class="task-main">
      <strong>${esc(task.title)}</strong>
      <div class="task-dates">
        ${task.earliestStart ? `<span>Start day ${shortDate(task.earliestStart)}</span>` : ""}
        ${task.deadline ? `<span>Due day ${shortDate(task.deadline)}</span>` : ""}
      </div>
    </div>
    <div class="matrix-status-actions" aria-label="改變任務狀態">
      <button class="${status === "pending" ? "active" : ""}" data-action="status" data-status="pending" data-id="${task.id}" type="button">待定</button>
      <button class="${status === "in_progress" ? "active" : ""}" data-action="status" data-status="in_progress" data-id="${task.id}" type="button">進行中</button>
      <button data-action="status" data-status="done" data-id="${task.id}" type="button">完成</button>
      <button data-action="edit" data-id="${task.id}" type="button">編輯</button>
    </div>
  </article>`;
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

function renderTimeline() {
  const today = state.summary?.today || [];
  timelineEl.innerHTML = today.length
    ? today.map((task) => `<article class="timeline-item"><span>${timeRange(task.scheduledStart, task.scheduledEnd)}</span><strong>${esc(task.title)}</strong></article>`).join("")
    : `<div class="empty">今天還沒有安排。</div>`;
}

function renderFocusList() {
  const priorities = state.summary?.topPriorities || [];
  focusListEl.innerHTML = priorities.length
    ? priorities.slice(0, 5).map((task, index) => `<article class="focus-item"><span>${index + 1}</span><strong>#${task.id} ${esc(task.title)}</strong><small>${esc(task.reason || "")}</small></article>`).join("")
    : `<div class="empty">目前沒有未完成任務。</div>`;
}

function openEditor(task = null) {
  drawerTitleEl.textContent = task ? `編輯 #${task.id}` : "新增任務";
  $("task-id").value = task?.id ?? "";
  $("title").value = task?.title ?? "";
  $("durationMinutes").value = task?.durationMinutes ?? 30;
  $("priority").value = task?.priority ?? 3;
  $("task-energy").value = task?.energy ?? "medium";
  $("task-status").value = normalizeStatusValue(task?.status ?? "pending");
  $("earliestStart").value = toLocalInputValue(task?.earliestStart);
  $("deadline").value = toLocalInputValue(task?.deadline);
  $("context").value = task?.context ?? "";
  drawerBackdropEl.hidden = false;
  drawerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeEditor() {
  drawerBackdropEl.hidden = true;
  drawerEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  taskFormEl.reset();
}

function formPayload() {
  return {
    title: $("title").value.trim(),
    durationMinutes: Number($("durationMinutes").value),
    priority: Number($("priority").value),
    energy: $("task-energy").value,
    status: $("task-status").value,
    earliestStart: fromLocalInputValue($("earliestStart").value),
    deadline: fromLocalInputValue($("deadline").value),
    context: $("context").value.trim() || null
  };
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

function timeRange(start, end) {
  return `${fmtTime(start)} - ${fmtTime(end)}`;
}

function fmtTime(value) {
  return new Intl.DateTimeFormat("zh-Hant", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function shortDate(value) {
  return new Intl.DateTimeFormat("zh-Hant", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function toLocalInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function fromLocalInputValue(value) {
  return value ? new Date(value).toISOString() : null;
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
