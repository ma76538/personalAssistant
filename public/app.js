const state = {
  tasks: [],
  summary: null,
  reminderPolicy: null,
  editingTask: null
};

const metricsEl = document.getElementById("metrics");
const timelineEl = document.getElementById("timeline");
const focusListEl = document.getElementById("focus-list");
const tasksEl = document.getElementById("tasks");
const statusBarsEl = document.getElementById("status-bars");
const energyEl = document.getElementById("energy");
const lastUpdatedEl = document.getElementById("last-updated");
const refreshEl = document.getElementById("refresh");
const replanEl = document.getElementById("replan");
const newTaskEl = document.getElementById("new-task");
const syncTodoEl = document.getElementById("sync-todo");
const todoListNameEl = document.getElementById("todo-list-name");
const drawerEl = document.getElementById("drawer");
const drawerBackdropEl = document.getElementById("drawer-backdrop");
const closeDrawerEl = document.getElementById("close-drawer");
const cancelEditEl = document.getElementById("cancel-edit");
const taskFormEl = document.getElementById("task-form");
const drawerTitleEl = document.getElementById("drawer-title");
const reminderSettingsFormEl = document.getElementById("reminder-settings-form");
const reminderSettingsStatusEl = document.getElementById("reminder-settings-status");
const resetReminderSettingsEl = document.getElementById("reset-reminder-settings");
let reminderSettingsSaveTimer = null;
let draggedTaskId = null;

refreshEl.addEventListener("click", loadDashboard);
syncTodoEl.addEventListener("click", syncTodoList);
replanEl.addEventListener("click", async () => {
  await requestJson("/api/replan", { method: "POST" });
  await loadDashboard();
});

async function syncTodoList() {
  const original = syncTodoEl.textContent;
  syncTodoEl.textContent = "同步中";
  syncTodoEl.disabled = true;
  try {
    const payload = await requestJson("/api/sync/apple-reminders", {
      method: "POST",
      body: JSON.stringify({ listName: todoListNameEl.value.trim() || "提醒事項" })
    });
    await loadDashboard();
    lastUpdatedEl.textContent = `已同步 ${payload.imported} 項`;
  } catch (error) {
    lastUpdatedEl.textContent = error instanceof Error ? error.message : "同步失敗";
  } finally {
    syncTodoEl.textContent = original;
    syncTodoEl.disabled = false;
  }
}
newTaskEl.addEventListener("click", () => openEditor());
closeDrawerEl.addEventListener("click", closeEditor);
cancelEditEl.addEventListener("click", closeEditor);
drawerBackdropEl.addEventListener("click", closeEditor);
reminderSettingsFormEl.addEventListener("input", scheduleReminderSettingsSave);
reminderSettingsFormEl.addEventListener("change", scheduleReminderSettingsSave);
resetReminderSettingsEl.addEventListener("click", resetReminderSettings);

tasksEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const taskId = Number(button.dataset.id);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;

  if (button.dataset.action === "edit") {
    openEditor(task);
    return;
  }
  if (button.dataset.action === "done") {
    await requestJson(`/api/tasks/${taskId}/done`, { method: "POST" });
    await loadDashboard();
    return;
  }
  if (button.dataset.action === "cancel") {
    await requestJson(`/api/tasks/${taskId}/cancel`, { method: "POST" });
    await loadDashboard();
  }
});

tasksEl.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".task-card");
  if (!card) return;
  draggedTaskId = Number(card.dataset.id);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(draggedTaskId));
  card.classList.add("dragging");
});

tasksEl.addEventListener("dragend", (event) => {
  event.target.closest(".task-card")?.classList.remove("dragging");
  tasksEl.querySelectorAll(".quadrant.drop-target").forEach((item) => item.classList.remove("drop-target"));
  draggedTaskId = null;
});

tasksEl.addEventListener("dragover", (event) => {
  const quadrant = event.target.closest(".quadrant");
  if (!quadrant || !draggedTaskId) return;
  event.preventDefault();
  quadrant.classList.add("drop-target");
});

tasksEl.addEventListener("dragleave", (event) => {
  event.target.closest(".quadrant")?.classList.remove("drop-target");
});

tasksEl.addEventListener("drop", async (event) => {
  const quadrant = event.target.closest(".quadrant");
  if (!quadrant || !draggedTaskId) return;
  event.preventDefault();
  quadrant.classList.remove("drop-target");
  const task = state.tasks.find((item) => item.id === draggedTaskId);
  if (!task) return;
  const important = quadrant.dataset.important === "true";
  await requestJson(`/api/tasks/${task.id}`, {
    method: "PATCH",
    body: JSON.stringify({ priority: important ? 5 : 2, status: normalizeStatusValue(task.status) })
  });
  await loadDashboard();
});

taskFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formPayload();
  const id = document.getElementById("task-id").value;

  if (id) {
    await requestJson(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
  } else {
    await requestJson("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
  }

  closeEditor();
  await loadDashboard();
});

async function loadDashboard() {
  const [summaryResponse, tasksResponse, reminderSettingsResponse] = await Promise.all([fetch("/api/summary"), fetch("/api/tasks"), fetch("/api/reminder-settings")]);
  state.summary = await summaryResponse.json();
  const taskPayload = await tasksResponse.json();
  state.tasks = taskPayload.tasks;
  const reminderPayload = await reminderSettingsResponse.json();
  state.reminderPolicy = reminderPayload.policy;
  render();
}

function render() {
  renderMetrics();
  renderFocusList();
  renderTimeline();
  renderStatusBars();
  renderEnergy();
  renderTasks();
  renderReminderSettings();
  lastUpdatedEl.textContent = `更新於 ${new Intl.DateTimeFormat("zh-Hant", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
}

function renderFocusList() {
  const priorities = state.summary.topPriorities || [];
  if (!priorities.length) {
    focusListEl.innerHTML = `<div class="empty">目前沒有未完成任務。</div>`;
    return;
  }

  focusListEl.innerHTML = priorities
    .map(
      (task, index) => `
        <article class="focus-item ${task.urgencyLabel}">
          <span>${index + 1}</span>
          <div>
            <h3>#${task.id} ${escapeHtml(task.title)}</h3>
            <p class="muted">${escapeHtml(task.reason)}${task.deadline ? `｜期限 ${formatDate(task.deadline)}` : ""}</p>
          </div>
          <strong>${task.urgencyScore}</strong>
        </article>
      `
    )
    .join("");
}

function renderMetrics() {
  const summary = state.summary;
  metricsEl.innerHTML = [
    metric("全部任務", summary.total, "◆"),
    metric("進行中", summary.active, "↗"),
    metric("今日安排", summary.today.length, "◎"),
    metric("逾期", summary.overdue, "!")
  ].join("");
}

function metric(label, value, icon) {
  return `
    <article class="metric">
      <div><span>${label}</span><strong>${value}</strong></div>
      <div class="metric-icon">${icon}</div>
    </article>
  `;
}

function renderTimeline() {
  const today = state.summary.today;
  if (!today.length) {
    timelineEl.innerHTML = `<div class="empty">今天還沒有安排。按「新增」建立任務，或到 Telegram 傳任務後回 /confirm。</div>`;
    return;
  }

  timelineEl.innerHTML = today
    .map(
      (task) => `
        <article class="timeline-item">
          <div class="time">${timeRange(task.scheduledStart, task.scheduledEnd)}</div>
          <div>
            <h3>${escapeHtml(task.title)}</h3>
            <p class="muted">${task.context ? escapeHtml(task.context) : "沒有補充情境"}</p>
            <div class="task-meta">
              ${chip(task.status)}
              ${chip(task.energy)}
              <span class="chip">優先 ${task.priority}</span>
            </div>
          </div>
        </article>
      `
    )
    .join("");
}

function renderStatusBars() {
  const counts = normalizeStatusCounts(state.summary.byStatus);
  const total = Math.max(Object.values(counts).reduce((sum, count) => sum + count, 0), 1);
  const rows = Object.entries(counts);

  statusBarsEl.innerHTML = rows.length
    ? rows
        .map(([status, count]) => {
          const width = Math.round((count / total) * 100);
          return `
            <div class="bar-row">
              <div class="bar-label"><span>${label(status)}</span><span>${count}</span></div>
              <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
            </div>
          `;
        })
        .join("")
    : `<div class="empty">暫無狀態資料</div>`;
}

function renderEnergy() {
  energyEl.innerHTML = [5, 4, 3, 2, 1]
    .map(
      (priority) => `
        <article class="energy-card priority-${priority}">
          <span class="muted">優先 ${priority}</span>
          <strong>${priorityLabel(priority)}</strong>
        </article>
      `
    )
    .join("");
}

function renderTasks() {
  const quadrants = state.summary.quadrants || {};
  const config = [
    ["urgent-important", "緊急重要", "立即處理"],
    ["urgent-not-important", "緊急不重要", "快速處理或委派"],
    ["not-urgent-important", "不緊急重要", "安排深度時間"],
    ["not-urgent-not-important", "不緊急不重要", "延後或刪減"]
  ];

  tasksEl.innerHTML = config
    .map(([key, title, subtitle]) => {
      const tasks = quadrants[key] || [];
      return `
        <section class="quadrant ${key}" data-important="${key.includes("important") && !key.includes("not-important")}">
          <div class="quadrant-head">
            <div>
              <h3>${title}</h3>
              <p class="muted">${subtitle}</p>
            </div>
            <strong>${tasks.length}</strong>
          </div>
          <div class="quadrant-list">
            ${
              tasks.length
                ? tasks.map(taskCard).join("")
                : `<div class="empty small">暫無任務</div>`
            }
          </div>
        </section>
      `;
    })
    .join("");
}

function taskCard(task) {
  return `
    <article class="task-card priority-${task.priority}" draggable="true" data-id="${task.id}">
      <div class="task-card-head">
        <h3>#${task.id} ${escapeHtml(task.title)}</h3>
        <button data-action="edit" data-id="${task.id}" type="button" title="編輯">✎</button>
      </div>
      <p class="muted">${task.scheduledStart ? timeRange(task.scheduledStart, task.scheduledEnd) : "尚未安排時間"}</p>
      <p class="muted">期限：${task.deadline ? formatDate(task.deadline) : "未設定"}</p>
      <p class="muted">${escapeHtml(task.reason || "")}</p>
      <div class="task-meta">
        ${chip(displayStatus(task.status))}
        <span class="chip">${task.durationMinutes} 分鐘</span>
        <span class="chip">優先 ${task.priority}</span>
      </div>
      <div class="card-actions">
        <button data-action="done" data-id="${task.id}" type="button">完成</button>
        <button data-action="cancel" data-id="${task.id}" type="button">取消</button>
      </div>
    </article>
  `;
}

function openEditor(task = null) {
  state.editingTask = task;
  drawerTitleEl.textContent = task ? `編輯 #${task.id}` : "新增任務";
  document.getElementById("task-id").value = task?.id ?? "";
  document.getElementById("title").value = task?.title ?? "";
  document.getElementById("durationMinutes").value = task?.durationMinutes ?? 30;
  document.getElementById("priority").value = task?.priority ?? 3;
  document.getElementById("task-energy").value = task?.energy ?? "medium";
  document.getElementById("task-status").value = normalizeStatusValue(task?.status ?? "pending");
  document.getElementById("earliestStart").value = toLocalInputValue(task?.earliestStart);
  document.getElementById("deadline").value = toLocalInputValue(task?.deadline);
  document.getElementById("context").value = task?.context ?? "";
  drawerBackdropEl.hidden = false;
  drawerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("drawer-open");
}

function closeEditor() {
  drawerBackdropEl.hidden = true;
  drawerEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  taskFormEl.reset();
  state.editingTask = null;
}

function formPayload() {
  return {
    title: document.getElementById("title").value.trim(),
    durationMinutes: Number(document.getElementById("durationMinutes").value),
    priority: Number(document.getElementById("priority").value),
    energy: document.getElementById("task-energy").value,
    status: document.getElementById("task-status").value,
    earliestStart: fromLocalInputValue(document.getElementById("earliestStart").value),
    deadline: fromLocalInputValue(document.getElementById("deadline").value),
    context: document.getElementById("context").value.trim() || null
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
    const payload = reminderSettingsPayload();
    const response = await requestJson("/api/reminder-settings", { method: "PUT", body: JSON.stringify(payload) });
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
    intensity: document.getElementById("reminder-intensity").value,
    beforeStart: {
      enabled: document.getElementById("before-start-enabled").checked,
      minutes: parseMinuteList(document.getElementById("before-start-minutes").value)
    },
    start: {
      enabled: document.getElementById("start-enabled").checked,
      requireResponse: document.getElementById("start-require-response").checked
    },
    inProgress: {
      enabled: document.getElementById("in-progress-enabled").checked,
      intervalMinutes: Number(document.getElementById("in-progress-interval").value),
      minimumTaskMinutes: 30
    },
    end: { enabled: document.getElementById("end-enabled").checked },
    unanswered: {
      enabled: document.getElementById("unanswered-enabled").checked,
      minutes: parseMinuteList(document.getElementById("unanswered-minutes").value)
    },
    quietHours: {
      enabled: document.getElementById("quiet-enabled").checked,
      start: document.getElementById("quiet-start").value,
      end: document.getElementById("quiet-end").value
    },
    highPriority: {
      enabled: document.getElementById("high-priority-enabled").checked,
      threshold: 4,
      extraBeforeStartMinutes: parseMinuteList(document.getElementById("high-priority-extra").value)
    }
  };
}

function parseMinuteList(value) {
  const minutes = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return [...new Set(minutes)];
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el && document.activeElement !== el) el.value = value ?? "";
}

function setChecked(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(checked);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "操作失敗");
  }
  return payload;
}

function chip(value) {
  return `<span class="chip ${value}">${label(value)}</span>`;
}

function label(value) {
  const labels = {
    todo: "待辦",
    pending: "待辦",
    scheduled: "待辦",
    in_progress: "進行中",
    done: "完成",
    cancelled: "取消",
    high: "專注工作",
    medium: "一般工作",
    low: "簡單行政"
  };
  return labels[value] || value;
}

function displayStatus(status) {
  return status === "scheduled" || status === "pending" ? "todo" : status;
}

function normalizeStatusValue(status) {
  return status === "scheduled" ? "pending" : status;
}

function normalizeStatusCounts(counts) {
  return {
    todo: (counts.pending || 0) + (counts.scheduled || 0),
    in_progress: counts.in_progress || 0,
    done: counts.done || 0
  };
}

function priorityLabel(priority) {
  if (priority >= 5) return "最高";
  if (priority === 4) return "高";
  if (priority === 3) return "中";
  if (priority === 2) return "低";
  return "最低";
}

function timeRange(start, end) {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function formatTime(value) {
  return new Intl.DateTimeFormat("zh-Hant", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-Hant", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function toLocalInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInputValue(value) {
  return value ? new Date(value).toISOString() : null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadDashboard();
setInterval(loadDashboard, 30_000);
