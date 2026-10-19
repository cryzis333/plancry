/* План обучения CAV — страница внутри Planacry (/learning/).
 *
 * Как это работает:
 *  1. Загружаем план (plan-data.json): сначала свежий с GitHub, если не вышло — локальную копию.
 *  2. Пробуем достучаться до API Planacry. Получилось — режим «Planacry»: каждый пункт плана
 *     это задача в проекте «CAV · обучение», галочка = статус задачи.
 *     Не получилось — «автономный» режим: галочки хранятся в localStorage этого браузера.
 *  3. Задачу и пункт связывает тег в описании задачи: «#cav-learn:<id пункта>».
 *
 * Без библиотек и сборки. Вся отрисовка — createElement + textContent (никакого innerHTML с данными).
 */
"use strict";

// ---------- Настройки ----------

const REMOTE_PLAN_URL =
  "https://raw.githubusercontent.com/cryzis333/plancry/refs/heads/claude/learning-plan/frontend/learning/plan-data.json";
const LOCAL_PLAN_URL = "./plan-data.json";
const API_BASE = "/api"; // абсолютный путь: страница живёт на том же сервере, что и Planacry
const PLAN_TIMEOUT_MS = 4000;
const API_TIMEOUT_MS = 5000;
const PROGRESS_KEY = "cavLearning.v2"; // автономные галочки
const UI_KEY = "cavLearning.v2.ui"; // какие этапы раскрыты

const PARAMS = new URLSearchParams(location.search);
// ?today=2026-12-01 — подменить «сегодня» (удобно проверить индикатор темпа)
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(PARAMS.get("today") || "") ? PARAMS.get("today") : localIsoDate(new Date());
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const PRIORITY_LABELS = { high: "высокий", medium: "средний", low: "низкий" };

// ---------- Состояние страницы ----------

const state = {
  plan: null,
  planSource: "", // "github" | "local"
  entries: [], // все пункты плана: { stage, item } в порядке этапов
  byId: new Map(), // id пункта → { stage, item }
  mode: "offline", // "planacry" | "offline"
  offlineReason: "", // "file" | "noapi"
  project: null, // проект в Planacry (если найден)
  tasks: new Map(), // id пункта → задача Planacry
  progress: { done: {} }, // автономные галочки: { done: { [id пункта]: true } }
  filter: null, // id трека, по которому отфильтрован список
  openStages: new Set(), // раскрытые этапы (запоминаются)
  filterOpen: new Set(), // раскрытые этапы, пока включён фильтр (не запоминаются)
  openItems: new Set(), // раскрытые пункты
  openChecks: new Set(), // раскрытые блоки «Самопроверка»
  busy: false, // идёт создание/синхронизация
  job: null, // { label, done, total } — прогресс синхронизации
  error: null, // { text, retry, retryLabel }
};

start();

// ---------- Запуск ----------

async function start() {
  const loaded = await loadPlan(PARAMS.get("plan") === "local");
  if (!loaded) {
    showFatal();
    return;
  }
  setPlan(loaded.plan, loaded.source);
  state.progress = loadProgress();
  await connectPlanacry();
  restoreUiState();
  render();
}

// Сначала GitHub (свежий план), потом локальная копия рядом со страницей.
async function loadPlan(localOnly) {
  if (!localOnly) {
    const remote = await fetchPlan(REMOTE_PLAN_URL);
    if (remote) return { plan: remote, source: "github" };
  }
  const local = await fetchPlan(LOCAL_PLAN_URL);
  if (local) return { plan: local, source: "local" };
  return null;
}

async function fetchPlan(url) {
  try {
    const response = await fetchWithTimeout(url, { cache: "no-store" }, PLAN_TIMEOUT_MS);
    if (!response.ok) return null;
    const plan = await response.json();
    return isValidPlan(plan) ? plan : null;
  } catch {
    return null; // нет сети, таймаут, битый JSON — пробуем следующий источник
  }
}

function isValidPlan(plan) {
  return Boolean(plan && Array.isArray(plan.stages) && plan.stages.every((stage) => Array.isArray(stage.items)));
}

function setPlan(plan, source) {
  state.plan = plan;
  state.planSource = source;
  state.entries = plan.stages.flatMap((stage) => stage.items.map((item) => ({ stage, item })));
  state.byId = new Map(state.entries.map((entry) => [entry.item.id, entry]));
  document.title = `${plan.title} · Planacry`;
}

// Пробуем API Planacry. Любая неудача на этом шаге = автономный режим.
async function connectPlanacry() {
  if (!/^https?:$/.test(location.protocol)) {
    state.offlineReason = "file";
    return;
  }
  let list;
  try {
    list = await api("GET", "/projects");
  } catch {
    state.offlineReason = "noapi";
    return;
  }
  state.mode = "planacry";
  try {
    await refreshProject(list);
  } catch (error) {
    state.error = { text: `Не получилось загрузить проект из Planacry: ${error.message}`, retry: reload, retryLabel: "Повторить" };
  }
}

// Находим проект по имени и забираем его задачи. Состояние меняем, только когда всё прочитано.
async function refreshProject(list) {
  const projects = findProjects(list === undefined ? await api("GET", "/projects") : list);
  const project = projects.find((p) => p.name === state.plan.planacry.projectName) || null;
  if (!project) {
    state.project = null;
    state.tasks = new Map();
    return;
  }
  const data = await api("GET", `/projects/${project.id}`);
  const tasks = findTasks(data);
  // не поняли ответ — лучше остановиться, чем решить, что задач нет, и создать дубли
  if (!tasks) throw new Error("не получилось найти список задач в ответе Planacry");
  state.project = data && data.project && data.project.id != null ? { ...project, ...data.project } : project;
  state.tasks = matchTasks(tasks);
}

async function reload() {
  state.error = null;
  render();
  try {
    await refreshProject();
  } catch (error) {
    state.error = { text: `Planacry не ответил: ${error.message}`, retry: reload, retryLabel: "Повторить" };
  }
  render();
}

// ---------- Разбор ответов Planacry ----------

// Список проектов может прийти массивом, {projects: [...]} или несколькими массивами ({active, archived}).
function findProjects(data) {
  const isProject = (p) => p && typeof p === "object" && p.id != null && typeof p.name === "string";
  if (Array.isArray(data)) return data.filter(isProject);
  if (!data || typeof data !== "object") return [];
  return Object.values(data).filter(Array.isArray).flat().filter(isProject);
}

// Planacry отдаёт сам объект ({id, ...}); на всякий случай понимаем и обёртку {task: {...}}.
function unwrap(data, key) {
  return data && data.id == null && data[key] && typeof data[key] === "object" ? data[key] : data;
}

// Задачи проекта: {project, tasks}, просто массив или поле tasks внутри вложенного объекта.
// null — формат не распознан.
function findTasks(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.tasks)) return data.tasks;
  for (const value of Object.values(data)) {
    if (value && Array.isArray(value.tasks)) return value.tasks;
  }
  return null;
}

// Регулярка для тега «#cav-learn:<id>» (сам тег берём из плана).
function tagPattern() {
  const tag = state.plan.planacry.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(tag + "([\\w-]+)");
}

// Сопоставляем задачи с пунктами плана по тегу. Задачи без тега (её собственные) не трогаем.
function matchTasks(tasks) {
  const pattern = tagPattern();
  const map = new Map();
  for (const task of tasks) {
    if (!task || task.id == null) continue;
    const match = pattern.exec(String(task.description || ""));
    if (match && state.byId.has(match[1]) && !map.has(match[1])) map.set(match[1], task);
  }
  return map;
}

// ---------- Синхронизация с Planacry ----------

// Пункты по порядку расписания (order), при равенстве — как в плане.
function entriesByOrder(entries = state.entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.item.order || 0) - (b.entry.item.order || 0) || a.index - b.index)
    .map((pair) => pair.entry);
}

// Чего не хватает в Planacry: новых пунктов и отметок «засчитано на уроке».
function computeDiff() {
  const missing = [];
  const toDone = [];
  if (state.mode !== "planacry" || !state.project) return { missing, toDone };
  for (const entry of entriesByOrder()) {
    const task = state.tasks.get(entry.item.id);
    if (!task) missing.push(entry);
    else if (entry.item.done && task.status !== "done") toDone.push(entry);
  }
  return { missing, toDone };
}

function projectBody() {
  const plan = state.plan;
  return {
    name: plan.planacry.projectName,
    description: `${plan.subtitle}\nПроект синхронизируется со страницей /learning/ — теги ${plan.planacry.tag}… в описаниях задач не удаляй.`,
    color: plan.planacry.color,
    deadline: plan.schedule.end,
    planned_hours: plan.schedule.totalHours,
  };
}

function taskBody({ stage, item }) {
  const lines = [item.how];
  const links = item.links || [];
  if (links.length) {
    lines.push("", "Ссылки:", ...links.map(([label, url]) => `— ${label}: ${url}`));
  }
  lines.push("", state.plan.planacry.tag + item.id);
  return {
    name: `${stage.code} · ${item.title}`,
    description: lines.join("\n"),
    planned_hours: item.h,
    deadline: item.deadline,
    priority: item.priority,
    status: item.done ? "done" : "backlog",
  };
}

// Создать проект (если его нет), добавить недостающие задачи, отметить засчитанные.
// Ничего не удаляет и не меняет её поля (часы, названия, свои задачи).
async function syncAll() {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  state.job = { label: "Проверяю Planacry…", done: 0, total: 0 };
  render();
  let created = 0;
  let marked = 0;
  try {
    await refreshProject();
    if (!state.project) {
      state.job.label = "Создаю проект…";
      renderNotices();
      state.project = unwrap(await api("POST", "/projects", projectBody()), "project");
      if (!state.project || state.project.id == null) throw new Error("Planacry не вернул id нового проекта");
    }
    const { missing, toDone } = computeDiff();
    state.job = { label: "Синхронизирую задачи", done: 0, total: missing.length + toDone.length };
    renderNotices();

    for (const entry of missing) {
      const task = unwrap(await api("POST", `/projects/${state.project.id}/tasks`, taskBody(entry)), "task");
      if (task && task.id != null) state.tasks.set(entry.item.id, task);
      created += 1;
      stepJob();
    }
    for (const entry of toDone) {
      const task = state.tasks.get(entry.item.id);
      const updated = unwrap(await api("PUT", `/tasks/${task.id}`, { status: "done" }), "task");
      Object.assign(task, updated && updated.id != null ? updated : { status: "done" });
      marked += 1;
      stepJob();
    }
    await refreshProject(); // перечитываем, чтобы показать то, что реально лежит в базе
    toast(syncSummary(created, marked), "ok");
  } catch (error) {
    state.error = {
      text: `Синхронизация прервалась: ${error.message}. Уже созданное не пропадёт и не задвоится.`,
      retry: syncAll,
      retryLabel: "Повторить",
    };
  } finally {
    state.busy = false;
    state.job = null;
    render();
  }
}

function stepJob() {
  state.job.done += 1;
  renderNotices();
}

function syncSummary(created, marked) {
  if (!created && !marked) return "Всё уже синхронизировано";
  const parts = [];
  if (created) parts.push(`создано ${created} ${plural(created, "задача", "задачи", "задач")}`);
  if (marked) parts.push(`засчитано ${marked}`);
  return `Готово: ${parts.join(", ")}`;
}

// ---------- Статусы пунктов ----------

function statusOf(item) {
  if (item.done) return "done"; // засчитано на уроке
  if (state.mode === "planacry") {
    const task = state.tasks.get(item.id);
    return task ? task.status : "backlog";
  }
  return state.progress.done[item.id] ? "done" : "backlog";
}

function isDone(item) {
  return statusOf(item) === "done";
}

function canToggle(item) {
  if (item.done || state.busy) return false;
  return state.mode === "offline" || state.tasks.has(item.id);
}

function actualHours(item) {
  const task = state.tasks.get(item.id);
  return task ? Number(task.actual_hours) || 0 : 0;
}

// Клик по галочке. В Planacry — оптимистично меняем статус и откатываем, если сервер отказал.
async function toggleItem(item, checked) {
  if (!canToggle(item)) return;
  if (state.mode === "offline") {
    if (checked) state.progress.done[item.id] = true;
    else delete state.progress.done[item.id];
    saveProgress();
    render();
    return;
  }
  const task = state.tasks.get(item.id);
  const previous = task.status;
  task.status = checked ? "done" : "backlog";
  render();
  try {
    const updated = unwrap(await api("PUT", `/tasks/${task.id}`, { status: task.status }), "task");
    if (updated && updated.id != null) Object.assign(task, updated);
  } catch (error) {
    task.status = previous;
    toast(`Не сохранилось в Planacry: ${error.message}`, "error");
  }
  render();
}

// ---------- Подсчёты ----------

function countStats(entries) {
  const stats = { done: 0, total: entries.length, hoursDone: 0, hoursTotal: 0, spent: 0 };
  for (const { item } of entries) {
    const hours = Number(item.h) || 0;
    stats.hoursTotal += hours;
    stats.spent += actualHours(item);
    if (isDone(item)) {
      stats.done += 1;
      stats.hoursDone += hours;
    }
  }
  return stats;
}

function stageEntries(stage) {
  return stage.items.map((item) => state.byId.get(item.id));
}

// Следующий шаг — первый несделанный пункт по расписанию среди основных этапов.
function nextMainEntry() {
  return entriesByOrder().find((entry) => !entry.stage.parallel && !isDone(entry.item)) || null;
}

// Для каждого фонового этапа — его ближайший несделанный пункт.
function nextParallelEntries() {
  return state.plan.stages
    .filter((stage) => stage.parallel)
    .map((stage) => entriesByOrder(stageEntries(stage)).find((entry) => !isDone(entry.item)))
    .filter(Boolean);
}

// Темп: просроченные несделанные пункты против сделанных заранее.
function paceInfo() {
  let behind = 0;
  let ahead = 0;
  for (const { item } of state.entries) {
    const done = isDone(item);
    if (!done && item.deadline && item.deadline < TODAY) behind += 1;
    if (done && !item.done && item.deadline && item.deadline > TODAY) ahead += 1;
  }
  const word = (n) => plural(n, "пункт", "пункта", "пунктов");
  if (behind) return { kind: "behind", text: `Отстаёшь на ${behind} ${word(behind)} — не страшно, просто продолжай по порядку` };
  if (ahead) return { kind: "ahead", text: `Впереди графика на ${ahead} ${word(ahead)}` };
  const start = state.plan.schedule && state.plan.schedule.start;
  if (start && TODAY < start) return { kind: "ontrack", text: `План стартует ${formatDate(start)} — можно начинать уже сейчас` };
  return { kind: "ontrack", text: "Идёшь по графику" };
}

// ---------- Отрисовка ----------

function render() {
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : null;
  const loading = document.getElementById("loading");
  if (loading) loading.remove();
  renderHeader();
  renderNotices();
  renderOverview();
  renderStages();
  renderLessons();
  renderFooter();
  restoreFocus(focusKey);
}

function renderHeader() {
  const plan = state.plan;
  document.getElementById("back-link").hidden = state.mode !== "planacry";
  document.getElementById("title").textContent = plan.title;
  document.getElementById("subtitle").textContent = plan.subtitle || "";
  document.getElementById("kicker").textContent = `CAV // план обучения · v${plan.version || 1}`;

  const online = state.mode === "planacry";
  const source = state.planSource === "github" ? "план: GitHub, свежий" : "план: локальная копия";
  document.getElementById("badges").replaceChildren(
    el("span", { class: cls("badge", online ? "badge-on" : "badge-off"), title: offlineHint() },
      el("span", { class: "dot", "aria-hidden": "true" }),
      online ? "Planacry · подключено" : "автономно"),
    el("span", { class: "badge badge-plain" }, source, el("span", { class: "mono", text: ` · ${formatDate(plan.updated, true)}` })),
  );
}

function offlineHint() {
  if (state.mode === "planacry") return "Отметки сохраняются в Planacry";
  if (state.offlineReason === "file") return "Страница открыта как файл — Planacry недоступен";
  return "Planacry не ответил — отметки хранятся в этом браузере";
}

// Верхние сообщения: создать проект / обновления плана / прогресс / ошибки.
function renderNotices() {
  const box = document.getElementById("notices");
  const nodes = [];
  if (state.job) nodes.push(renderJob());
  if (state.error) nodes.push(renderError());
  if (state.mode === "planacry" && !state.busy && !state.error) {
    if (!state.project) nodes.push(renderCreateNotice());
    else {
      const notice = renderDiffNotice();
      if (notice) nodes.push(notice);
    }
  }
  if (state.project && state.project.status === "archived") nodes.push(renderArchivedNotice());
  if (state.mode === "offline") nodes.push(renderOfflineNotice());
  box.replaceChildren(...nodes);
}

function renderJob() {
  const { label, done, total } = state.job;
  return el("div", { class: "panel notice notice-job", role: "status" },
    el("div", { class: "notice-row" },
      el("span", { class: "notice-title", text: label }),
      total ? el("span", { class: "mono", text: `${done} / ${total}` }) : null),
    progressBar(total ? done / total : 0, "bar bar-job"));
}

function renderError() {
  const { text, retry, retryLabel } = state.error;
  return el("div", { class: "panel notice notice-error", role: "alert" },
    el("p", { class: "notice-text", text }),
    retry ? el("button", { type: "button", class: "btn", onclick: retry, text: retryLabel }) : null);
}

function renderCreateNotice() {
  const { plan } = state;
  const count = state.entries.length;
  const label = `Создать проект «${plan.planacry.projectName}» в Planacry — ${count} ${plural(count, "задача", "задачи", "задач")}, ${formatHours(plan.schedule.totalHours)} ч`;
  return el("div", { class: "panel notice notice-create" },
    el("h2", { class: "notice-title", text: "Проекта плана в Planacry ещё нет" }),
    el("p", { class: "notice-text", text:
      `Кнопка создаст проект с дедлайном ${formatDate(plan.schedule.end, true)} и по задаче на каждый пункт. ` +
      "Дальше галочки здесь и статусы на доске Planacry — одно и то же." }),
    el("button", { type: "button", class: "btn btn-primary btn-big", onclick: syncAll, text: label }));
}

function renderDiffNotice() {
  const { missing, toDone } = computeDiff();
  if (!missing.length && !toDone.length) return null;
  const parts = [];
  if (missing.length) parts.push(`${missing.length} ${plural(missing.length, "новый пункт", "новых пункта", "новых пунктов")}`);
  if (toDone.length) parts.push(`${toDone.length} засчитано на уроке`);
  return el("div", { class: "panel notice notice-update" },
    el("p", { class: "notice-title", text: `В плане обновления: ${parts.join(", ")}` }),
    el("button", { type: "button", class: "btn btn-primary", onclick: syncAll, text: "Синхронизировать" }));
}

function renderArchivedNotice() {
  return el("div", { class: "panel notice notice-info" },
    el("p", { class: "notice-text", text:
      `Проект «${state.project.name}» в архиве Planacry. Отметки здесь работают; чтобы он снова был на доске — верни его из архива.` }));
}

function renderOfflineNotice() {
  const text = state.offlineReason === "file"
    ? "Автономный режим: страница открыта как файл. Отметки хранятся в этом браузере. Чтобы они шли в Planacry, открой http://127.0.0.1:8080/learning/"
    : "Автономный режим: Planacry не ответил, отметки хранятся в этом браузере. Запусти сервер (cd backend && cargo run) и обнови страницу.";
  return el("div", { class: "notice notice-muted" }, el("p", { class: "notice-text", text }));
}

function renderOverview() {
  const box = document.getElementById("overview");
  box.replaceChildren(renderProgressPanel(), renderNextPanel(), renderTracksPanel());
}

function renderProgressPanel() {
  const stats = countStats(state.entries);
  const pace = paceInfo();
  const share = stats.total ? stats.done / stats.total : 0;
  const schedule = state.plan.schedule || {};
  return el("section", { class: "panel progress-panel", "aria-labelledby": "progress-title" },
    el("h2", { class: "panel-label", id: "progress-title", text: "Прогресс" }),
    el("div", { class: "stat-row" },
      stat(`${stats.done} / ${stats.total}`, "пунктов сделано"),
      stat(`${Math.floor(share * 100)}%`, "плана", "stat-accent"),
      stat(`${formatHours(stats.hoursDone)} / ${formatHours(stats.hoursTotal)}`, "часов по плану")),
    progressBar(share, "bar bar-big"),
    el("p", { class: cls("pace", "pace-" + pace.kind) }, el("span", { class: "dot", "aria-hidden": "true" }), pace.text),
    el("p", { class: "muted small" },
      state.mode === "planacry" ? `Фактически потрачено ${formatHours(stats.spent)} ч. ` : "",
      `Темп ~${schedule.hoursPerWeek} ч в неделю · основа к ${formatDate(schedule.coreEnd, true)} · всё к ${formatDate(schedule.end, true)}`));
}

function stat(value, label, extra) {
  return el("div", { class: cls("stat", extra) },
    el("span", { class: "stat-value mono", text: value }),
    el("span", { class: "stat-label", text: label }));
}

function renderNextPanel() {
  const entry = nextMainEntry();
  const panel = el("section", { class: "panel next-panel", "aria-labelledby": "next-title" },
    el("h2", { class: "panel-label", id: "next-title", text: "Следующий шаг" }));
  if (!entry) {
    panel.append(el("p", { class: "next-title", text: "Основной план пройден целиком. Это было мощно." }));
  } else {
    panel.append(...renderNextBody(entry).filter(Boolean));
  }
  const background = nextParallelEntries();
  if (background.length) panel.append(renderBackgroundLine(background));
  return panel;
}

function renderNextBody(entry) {
  const { stage, item } = entry;
  const allowed = canToggle(item);
  return [
    el("p", { class: "next-stage muted small", text: stage.title }),
    el("h3", { class: "next-title", text: item.title }),
    el("div", { class: "chips" }, ...itemChips(item, statusOf(item))),
    el("p", { class: "how", text: item.how }),
    renderLinks(item),
    el("div", { class: "next-actions" },
      el("button", {
        type: "button", class: "btn btn-primary", disabled: !allowed, dataset: { focus: "next-done" },
        title: allowed ? "" : "Сначала создай проект в Planacry", onclick: () => toggleItem(item, true), text: "Готово ✓",
      }),
      el("button", { type: "button", class: "btn btn-ghost", onclick: () => revealItem(item.id), text: "Показать в плане" })),
  ];
}

function renderBackgroundLine(entries) {
  return el("div", { class: "background" },
    el("span", { class: "background-label", text: "фоном" }),
    el("ul", { class: "background-list" }, ...entries.map(({ stage, item }) =>
      el("li", {},
        el("button", { type: "button", class: "background-item", vars: { "--c": trackColor(item.track) }, onclick: () => revealItem(item.id) },
          el("span", { class: "background-stage", text: stage.code }),
          el("span", { text: item.title }))))));
}

function renderTracksPanel() {
  const tracks = Object.entries(state.plan.tracks || {});
  const buttons = tracks.map(([id, track]) => {
    const stats = countStats(state.entries.filter((entry) => entry.item.track === id));
    if (!stats.total) return null;
    const active = state.filter === id;
    return el("button", {
      type: "button", class: cls("track", active && "is-active"), "aria-pressed": String(active),
      vars: { "--c": trackColor(id) }, dataset: { focus: "track:" + id }, onclick: () => setFilter(active ? null : id),
    },
      el("span", { class: "track-head" },
        el("span", { class: "track-name", text: track.name }),
        el("span", { class: "mono small", text: `${stats.done}/${stats.total}` })),
      progressBar(stats.done / stats.total, "bar bar-track"));
  });
  return el("section", { class: "panel tracks-panel", "aria-labelledby": "tracks-title" },
    el("div", { class: "panel-head" },
      el("h2", { class: "panel-label", id: "tracks-title", text: "Треки" }),
      el("button", { type: "button", class: cls("btn btn-ghost btn-small", !state.filter && "is-active"), "aria-pressed": String(!state.filter),
        dataset: { focus: "track:all" }, onclick: () => setFilter(null), text: "все" })),
    el("div", { class: "track-grid" }, ...buttons));
}

function setFilter(trackId) {
  state.filter = trackId;
  // при фильтре раскрываем все этапы, где есть пункты этого трека
  state.filterOpen = new Set(trackId
    ? state.plan.stages.filter((stage) => stage.items.some((item) => item.track === trackId)).map((stage) => stage.id)
    : []);
  render();
}

function renderStages() {
  const box = document.getElementById("stages");
  const title = state.filter
    ? `Этапы · только «${state.plan.tracks[state.filter].name}»`
    : "Этапы";
  const cards = state.plan.stages.map(renderStage).filter(Boolean);
  box.replaceChildren(el("div", { class: "section-head" }, el("h2", { class: "section-title", text: title })), ...cards);
}

function renderStage(stage) {
  const all = stageEntries(stage);
  const visible = state.filter ? all.filter((entry) => entry.item.track === state.filter) : all;
  if (!visible.length) return null;
  const stats = countStats(all);
  const complete = stats.done === stats.total;

  const card = el("details", {
    class: cls("panel stage", stage.parallel && "is-parallel", complete && "is-complete"),
    id: "stage-" + stage.id, open: isStageOpen(stage.id),
    ontoggle: (event) => onStageToggle(stage.id, event.currentTarget.open),
  });
  card.append(renderStageSummary(stage, stats), renderStageBody(stage, visible, stats));
  return card;
}

function renderStageSummary(stage, stats) {
  const hoursText = state.mode === "planacry"
    ? `потрачено ${formatHours(stats.spent)} ч из ${formatHours(stats.hoursTotal)}`
    : `${formatHours(stats.hoursTotal)} ч`;
  return el("summary", { class: "stage-summary", dataset: { focus: "stage:" + stage.id } },
    el("span", { class: "stage-line" },
      el("span", { class: "stage-code mono", text: stage.code }),
      el("h3", { class: "stage-title", text: stage.title }),
      stage.parallel ? el("span", { class: "tag tag-parallel", text: "фоном" }) : null),
    el("span", { class: "stage-line stage-meta" },
      el("span", { class: "muted", text: stage.weeks }),
      el("span", { class: "mono", text: `${stats.done}/${stats.total}` }),
      progressBar(stats.total ? stats.done / stats.total : 0, "bar bar-mini"),
      el("span", { class: "muted mono", text: hoursText })));
}

function renderStageBody(stage, visible, stats) {
  const body = el("div", { class: "stage-body" },
    el("dl", { class: "stage-goal" },
      el("dt", { text: "Цель" }), el("dd", { text: stage.goal }),
      el("dt", { text: "Результат" }), el("dd", { text: stage.result })),
    el("ul", { class: "items" }, ...visible.map(renderItem)),
    el("p", { class: "stage-total muted small mono", text: stageTotalText(stats) }));
  if (stage.check && stage.check.length) body.append(renderSelfCheck(stage));
  return body;
}

function stageTotalText(stats) {
  const done = `сделано ${stats.done} из ${stats.total} · ${formatHours(stats.hoursDone)} из ${formatHours(stats.hoursTotal)} ч по плану`;
  return state.mode === "planacry" ? `${done} · потрачено ${formatHours(stats.spent)} ч` : done;
}

function renderSelfCheck(stage) {
  const count = stage.check.length;
  return el("details", {
    class: "selfcheck", open: state.openChecks.has(stage.id),
    ontoggle: (event) => toggleInSet(state.openChecks, stage.id, event.currentTarget.open),
  },
    el("summary", { dataset: { focus: "check-block:" + stage.id } },
      `Самопроверка · ${count} ${plural(count, "вопрос", "вопроса", "вопросов")}`),
    el("ol", {}, ...stage.check.map((question) => el("li", { text: question }))));
}

function renderItem({ item }) {
  const status = statusOf(item);
  const open = state.openItems.has(item.id);
  const overdue = status !== "done" && item.deadline && item.deadline < TODAY;
  const li = el("li", {
    class: cls("item", status === "done" && "is-done", status === "doing" && "is-doing", item.done && "is-locked", overdue && "is-overdue"),
    id: "item-" + item.id, vars: { "--c": trackColor(item.track) },
  });
  li.append(
    el("div", { class: "item-row" },
      renderCheckbox(item, status),
      el("button", {
        type: "button", class: "item-main", "aria-expanded": String(open), "aria-controls": "details-" + item.id,
        dataset: { focus: "item:" + item.id }, onclick: () => toggleOpenItem(item.id),
      },
        el("span", { class: "item-title", text: item.title }),
        el("span", { class: "chips" }, ...itemChips(item, status)))));
  if (open) li.append(renderItemDetails(item));
  return li;
}

function renderCheckbox(item, status) {
  let hint = status === "done" ? "Снять отметку" : "Отметить сделанным";
  if (item.done) hint = "Засчитано на уроке";
  else if (!canToggle(item) && state.mode === "planacry") hint = "Сначала синхронизируй с Planacry";
  return el("input", {
    type: "checkbox", class: "check", checked: status === "done", disabled: !canToggle(item),
    title: hint, "aria-label": `${hint}: ${item.title}`, dataset: { focus: "check:" + item.id },
    onchange: (event) => toggleItem(item, event.currentTarget.checked),
  });
}

// Чипы у пункта: трек, тип, дедлайн, «в работе», факт часов.
function itemChips(item, status) {
  const track = state.plan.tracks[item.track];
  const overdue = status !== "done" && item.deadline && item.deadline < TODAY;
  const spent = actualHours(item);
  return [
    track ? el("span", { class: "chip chip-track", vars: { "--c": trackColor(item.track) }, text: track.name }) : null,
    el("span", { class: cls("chip chip-type", "type-" + item.type), text: state.plan.types[item.type] || item.type }),
    item.deadline ? el("span", { class: cls("chip chip-date mono", overdue && "is-overdue"), title: overdue ? "Срок прошёл" : "Срок по графику",
      text: `до ${formatDate(item.deadline)}` }) : null,
    status === "doing" ? el("span", { class: "chip chip-doing", text: "в работе" }) : null,
    item.done ? el("span", { class: "chip chip-lesson", text: "засчитано на уроке" }) : null,
    spent > 0 ? el("span", { class: "chip chip-hours mono", text: `${formatHours(spent)} ч` }) : null,
  ];
}

function renderItemDetails(item) {
  const facts = [`план ${formatHours(item.h)} ч`];
  if (state.mode === "planacry") facts.push(`факт ${formatHours(actualHours(item))} ч`);
  facts.push(`приоритет: ${PRIORITY_LABELS[item.priority] || item.priority}`);
  if (item.deadline) facts.push(`срок ${formatDate(item.deadline, true)}`);
  return el("div", { class: "item-details", id: "details-" + item.id },
    el("p", { class: "how", text: item.how }),
    renderLinks(item),
    el("p", { class: "muted small mono", text: facts.join(" · ") }));
}

// Ссылки — только http/https, в новой вкладке.
function renderLinks(item) {
  const links = (item.links || [])
    .map(([label, url]) => ({ label, url: safeUrl(url) }))
    .filter((link) => link.url);
  if (!links.length) return null;
  return el("ul", { class: "links" }, ...links.map((link) =>
    el("li", {}, el("a", { href: link.url, target: "_blank", rel: "noopener noreferrer", text: link.label }))));
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function renderLessons() {
  const lessons = state.plan.lessons || [];
  const box = document.getElementById("lessons");
  if (!lessons.length) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    el("div", { class: "section-head" }, el("h2", { class: "section-title", text: "Журнал уроков" })),
    el("ol", { class: "panel lessons" }, ...lessons.map((lesson) =>
      el("li", { class: "lesson" },
        el("time", { class: "lesson-date mono", datetime: lesson.date, text: formatDate(lesson.date, true) }),
        el("div", {},
          el("h3", { class: "lesson-title", text: lesson.title }),
          el("p", { class: "lesson-note", text: lesson.note }))))));
}

function renderFooter() {
  const box = document.getElementById("footer");
  const actions = state.mode === "planacry" ? planacryActions() : offlineActions();
  const source = state.planSource === "github" ? "GitHub" : "локальная копия";
  box.replaceChildren(
    el("div", { class: "footer-actions" }, ...actions),
    el("p", { class: "muted small" },
      `План v${state.plan.version || 1} обновлён ${formatDate(state.plan.updated, true)} · источник: ${source}. `,
      state.planSource === "github" ? "Локальная копия: добавь к адресу ?plan=local." : ""));
}

function planacryActions() {
  const project = state.project
    ? `Проект «${state.project.name}» · ${state.tasks.size} ${plural(state.tasks.size, "задача", "задачи", "задач")} из плана`
    : "Проект ещё не создан";
  return [
    el("button", { type: "button", class: "btn btn-primary", disabled: state.busy, onclick: syncAll, text: "Синхронизировать" }),
    el("a", { class: "btn btn-ghost", href: "/", text: "Открыть Planacry" }),
    el("span", { class: "muted small", text: project }),
  ];
}

function offlineActions() {
  const fileInput = el("input", {
    type: "file", accept: "application/json,.json", hidden: true,
    onchange: (event) => importProgress(event.currentTarget.files[0]),
  });
  return [
    el("button", { type: "button", class: "btn", onclick: exportProgress, text: "Экспорт прогресса" }),
    el("button", { type: "button", class: "btn", onclick: () => fileInput.click(), text: "Импорт" }),
    fileInput,
    el("button", { type: "button", class: "btn btn-danger", onclick: resetProgress, text: "Сбросить" }),
  ];
}

function showFatal() {
  const loading = document.getElementById("loading");
  if (loading) loading.remove();
  document.getElementById("notices").replaceChildren(
    el("div", { class: "panel notice notice-error", role: "alert" },
      el("h2", { class: "notice-title", text: "План не загрузился" }),
      el("p", { class: "notice-text", text:
        "Не получилось скачать plan-data.json ни с GitHub, ни из папки рядом со страницей. " +
        "Проверь, что файл лежит в frontend/learning/, и открой страницу через Planacry: http://127.0.0.1:8080/learning/" })));
}

// ---------- Раскрытие этапов и пунктов ----------

function isStageOpen(stageId) {
  return (state.filter ? state.filterOpen : state.openStages).has(stageId);
}

function onStageToggle(stageId, open) {
  const set = state.filter ? state.filterOpen : state.openStages;
  if (set.has(stageId) === open) return; // событие от самой отрисовки — ничего не поменялось
  toggleInSet(set, stageId, open);
  if (!state.filter) saveUiState();
}

function toggleInSet(set, key, on) {
  if (on) set.add(key);
  else set.delete(key);
}

function toggleOpenItem(itemId) {
  toggleInSet(state.openItems, itemId, !state.openItems.has(itemId));
  render();
}

// Прокрутить к пункту: снять чужой фильтр, раскрыть этап и сам пункт.
function revealItem(itemId) {
  const entry = state.byId.get(itemId);
  if (!entry) return;
  if (state.filter && state.filter !== entry.item.track) setFilter(null);
  toggleInSet(state.filter ? state.filterOpen : state.openStages, entry.stage.id, true);
  state.openItems.add(itemId);
  saveUiState();
  render();
  const node = document.getElementById("item-" + itemId);
  if (!node) return;
  node.scrollIntoView({ block: "center", behavior: REDUCED_MOTION ? "auto" : "smooth" });
  const button = node.querySelector(".item-main");
  if (button) button.focus({ preventScroll: true });
}

function restoreFocus(key) {
  if (!key) return;
  const node = document.querySelector(`[data-focus="${CSS.escape(key)}"]`);
  if (node && !node.disabled) node.focus({ preventScroll: true });
}

// ---------- localStorage ----------

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback; // приватный режим или битые данные
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // хранилище недоступно — просто не запоминаем
  }
}

function loadProgress() {
  const saved = readStore(PROGRESS_KEY, null);
  return { done: cleanDone(saved && saved.done) };
}

// Оставляем только отметки вида { id: true }.
function cleanDone(done) {
  const result = {};
  if (!done || typeof done !== "object") return result;
  for (const [id, value] of Object.entries(done)) if (value === true) result[id] = true;
  return result;
}

function saveProgress() {
  writeStore(PROGRESS_KEY, { done: state.progress.done, saved: new Date().toISOString() });
}

// Раскрытые этапы. Если следующий шаг переехал в новый этап — раскрываем и его.
function restoreUiState() {
  const saved = readStore(UI_KEY, null);
  const next = nextMainEntry();
  const nextStage = next ? next.stage.id : null;
  if (saved && Array.isArray(saved.open)) state.openStages = new Set(saved.open);
  if (nextStage && (!saved || saved.next !== nextStage)) state.openStages.add(nextStage);
  saveUiState();
}

function saveUiState() {
  const next = nextMainEntry();
  writeStore(UI_KEY, { open: [...state.openStages], next: next ? next.stage.id : null });
}

// ---------- Экспорт / импорт / сброс (автономный режим) ----------

function exportProgress() {
  const data = { app: "cav-learning", version: 2, exported: new Date().toISOString(), done: state.progress.done };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `cav-learning-${TODAY}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importProgress(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.done !== "object") throw new Error("нет поля done");
    const done = cleanDone(data.done);
    for (const id of Object.keys(done)) if (!state.byId.has(id)) delete done[id];
    state.progress = { done };
    saveProgress();
    render();
    toast(`Импортировано отметок: ${Object.keys(done).length}`, "ok");
  } catch {
    toast("Не получилось прочитать файл — нужен JSON, сохранённый кнопкой «Экспорт прогресса»", "error");
  }
}

function resetProgress() {
  if (!confirm("Сбросить все отметки в этом браузере? Засчитанное на уроках останется.")) return;
  state.progress = { done: {} };
  saveProgress();
  render();
  toast("Отметки сброшены", "ok");
}

// ---------- Сеть ----------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Запрос к API Planacry. Бросает ошибку, если ответ не 2xx или не JSON.
async function api(method, path, body) {
  const options = { method, headers: { Accept: "application/json" }, cache: "no-store" };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchWithTimeout(API_BASE + path, options, API_TIMEOUT_MS);
  } catch {
    throw new Error("сервер не отвечает");
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 160)}`.trim());
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("ответ не JSON");
  }
}

// ---------- Мелкие помощники ----------

// el("div", { class: "x", text: "..." }, ...дети) — короткая запись createElement.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "vars") for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false || child === "") continue;
    node.append(child); // строки превращаются в текстовые узлы, не в HTML
  }
  return node;
}

// cls("a", cond && "b") → "a b"
function cls(...names) {
  return names.filter(Boolean).join(" ");
}

function progressBar(share, className) {
  const percent = Math.round(Math.max(0, Math.min(1, share)) * 100);
  const bar = el("div", { class: className, role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) });
  bar.append(el("span", { class: "bar-fill", vars: { "--p": percent + "%" } }));
  return bar;
}

// Цвет трека, осветлённый под тёмный фон.
function trackColor(trackId) {
  const track = state.plan.tracks[trackId];
  return brighten(track ? track.color : "", 0.32);
}

function brighten(hex, amount) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!match) return "rgb(201 182 255)";
  const value = parseInt(match[1], 16);
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix((value >> 16) & 255)} ${mix((value >> 8) & 255)} ${mix(value & 255)})`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatHours(hours) {
  return (Number(hours) || 0).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

// "2026-10-21" → "21.10" (год показываем, если он не текущий или если попросили)
function formatDate(iso, withYear) {
  if (!iso) return "—";
  const [year, month, day] = iso.split("-");
  return withYear || year !== TODAY.slice(0, 4) ? `${day}.${month}.${year}` : `${day}.${month}`;
}

function localIsoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

let toastTimer = 0;
function toast(text, kind) {
  const box = document.getElementById("toast");
  box.textContent = text;
  box.dataset.kind = kind || "info";
  box.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("is-visible"), 4500);
}
