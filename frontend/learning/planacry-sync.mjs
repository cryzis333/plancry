#!/usr/bin/env node
// Синхронизация плана обучения с Planacry через его API — то же самое, что кнопка на странице /learning/.
// Создаёт проект «CAV · обучение» (если его нет), добавляет недостающие задачи и отмечает
// засчитанные на уроке. Ничего не удаляет и не трогает часы, названия и твои собственные задачи.
//
// Запуск (Node 18+, без зависимостей), из папки planacry:
//   node frontend/learning/planacry-sync.mjs              — план с GitHub (или локальный, если GitHub недоступен)
//   node frontend/learning/planacry-sync.mjs --dry-run    — только показать, что будет сделано
//   node frontend/learning/planacry-sync.mjs --local      — взять plan-data.json рядом со скриптом
//   node frontend/learning/planacry-sync.mjs --api http://127.0.0.1:8080/api --plan другой-план.json

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REMOTE_PLAN_URL =
  "https://raw.githubusercontent.com/cryzis333/plancry/refs/heads/claude/learning-plan/frontend/learning/plan-data.json";
const LOCAL_PLAN_PATH = fileURLToPath(new URL("./plan-data.json", import.meta.url));
const DEFAULT_API = "http://127.0.0.1:8080/api";

const HELP = `Синхронизация плана обучения с Planacry.

  node planacry-sync.mjs [--api URL] [--dry-run] [--local] [--plan ФАЙЛ]

  --api URL    адрес API Planacry (по умолчанию ${DEFAULT_API})
  --dry-run    ничего не записывать, только показать изменения
  --local      не ходить на GitHub, взять plan-data.json рядом со скриптом
  --plan ФАЙЛ  взять план из указанного файла`;

main().catch((error) => {
  console.error(`\nОшибка: ${error.message}`);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const { plan, source } = await loadPlan(options);
  const entries = plan.stages.flatMap((stage) => stage.items.map((item) => ({ stage, item })));
  console.log(`План: «${plan.title}», обновлён ${plan.updated}, ${entries.length} пунктов (${source})`);
  console.log(`Planacry: ${options.api}${options.dryRun ? "  [dry-run — ничего не записываю]" : ""}\n`);

  const client = makeClient(options.api);
  const projects = findProjects(await client.request("GET", "/projects", undefined, true));
  let project = projects.find((p) => p.name === plan.planacry.projectName) || null;
  let tasks = new Map();
  let createdProject = false;

  if (project) {
    const data = await client.request("GET", `/projects/${project.id}`);
    const list = findTasks(data);
    // не поняли ответ — останавливаемся, чтобы не создать дубли
    if (!list) throw new Error(`в ответе GET /projects/${project.id} нет списка задач`);
    tasks = matchTasks(plan, list);
    const archived = (data && data.project && data.project.status) === "archived" || project.status === "archived";
    console.log(`Проект «${project.name}» найден (id ${project.id})${archived ? ", лежит в архиве" : ""}: ${tasks.size} задач из плана`);
  } else if (options.dryRun) {
    console.log(`Проект «${plan.planacry.projectName}» не найден — будет создан`);
  } else {
    project = unwrap(await client.request("POST", "/projects", projectBody(plan)), "project");
    if (!project || project.id == null) throw new Error("Planacry не вернул id нового проекта");
    createdProject = true;
    console.log(`Создан проект «${project.name}» (id ${project.id})`);
  }

  const { missing, toDone } = computeDiff(entries, tasks);
  const prefix = options.dryRun ? "[dry-run] " : "";

  for (const entry of missing) {
    const body = taskBody(plan, entry);
    if (!options.dryRun) await client.request("POST", `/projects/${project.id}/tasks`, body);
    console.log(`${prefix}+ ${body.name}${body.status === "done" ? "  (сразу done)" : ""}`);
  }
  for (const entry of toDone) {
    const task = tasks.get(entry.item.id);
    if (!options.dryRun) await client.request("PUT", `/tasks/${task.id}`, { status: "done" });
    console.log(`${prefix}✓ ${task.name}  (засчитано на уроке)`);
  }

  console.log("");
  const projectIsNew = createdProject || !project; // !project бывает только в dry-run
  if (!projectIsNew && !missing.length && !toDone.length) {
    console.log("Всё уже синхронизировано — 0 изменений.");
    return;
  }
  const summary = [];
  if (projectIsNew) summary.push("проект создан");
  summary.push(`задач добавлено: ${missing.length}`, `засчитано: ${toDone.length}`);
  console.log(options.dryRun ? `Dry-run, ничего не записано. Было бы: ${summary.join(", ")}.` : `Готово: ${summary.join(", ")}.`);
}

// ---------- Аргументы и план ----------

function parseArgs(args) {
  const options = { api: DEFAULT_API, dryRun: false, local: false, plan: null, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    const value = () => {
      const v = inline !== undefined ? inline : args[++i];
      if (!v) throw new Error(`после ${flag} нужно значение`);
      return v;
    };
    if (flag === "--api") options.api = value().replace(/\/+$/, "");
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--local") options.local = true;
    else if (flag === "--plan") options.plan = value();
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`неизвестный параметр ${args[i]} (см. --help)`);
  }
  return options;
}

async function loadPlan(options) {
  if (options.plan) return { plan: checkPlan(JSON.parse(await readFile(options.plan, "utf8"))), source: options.plan };
  if (!options.local) {
    try {
      const response = await fetch(REMOTE_PLAN_URL, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      if (response.ok) return { plan: checkPlan(await response.json()), source: "GitHub" };
    } catch {
      // нет сети — берём локальную копию
    }
  }
  return { plan: checkPlan(JSON.parse(await readFile(LOCAL_PLAN_PATH, "utf8"))), source: "локальная копия" };
}

function checkPlan(plan) {
  const ok = plan && Array.isArray(plan.stages) && plan.stages.every((s) => Array.isArray(s.items)) && plan.planacry;
  if (!ok) throw new Error("файл плана не похож на plan-data.json");
  return plan;
}

// ---------- API Planacry ----------

function makeClient(apiBase) {
  return {
    async request(method, path, body, first = false) {
      const init = { method, headers: { Accept: "application/json" } };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetch(apiBase + path, init);
      } catch {
        const hint = first ? " Запущен ли Planacry? (cd backend && cargo run)" : "";
        throw new Error(`не удалось подключиться к ${apiBase}.${hint}`);
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 200)}`);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path}: ответ не JSON — это точно API Planacry?`);
      }
    },
  };
}

// ---------- Та же логика, что в learning.js ----------

function unwrap(data, key) {
  return data && data.id == null && data[key] && typeof data[key] === "object" ? data[key] : data;
}

function findProjects(data) {
  const isProject = (p) => p && typeof p === "object" && p.id != null && typeof p.name === "string";
  if (Array.isArray(data)) return data.filter(isProject);
  if (!data || typeof data !== "object") return [];
  return Object.values(data).filter(Array.isArray).flat().filter(isProject);
}

function findTasks(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.tasks)) return data.tasks;
  for (const value of Object.values(data)) {
    if (value && Array.isArray(value.tasks)) return value.tasks;
  }
  return null; // формат не распознан
}

function matchTasks(plan, tasks) {
  const ids = new Set(plan.stages.flatMap((stage) => stage.items.map((item) => item.id)));
  const pattern = new RegExp(plan.planacry.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([\\w-]+)");
  const map = new Map();
  for (const task of tasks) {
    if (!task || task.id == null) continue;
    const match = pattern.exec(String(task.description || ""));
    if (match && ids.has(match[1]) && !map.has(match[1])) map.set(match[1], task);
  }
  return map;
}

function computeDiff(entries, tasks) {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.item.order || 0) - (b.entry.item.order || 0) || a.index - b.index)
    .map((pair) => pair.entry);
  const missing = ordered.filter((entry) => !tasks.has(entry.item.id));
  const toDone = ordered.filter((entry) => entry.item.done && tasks.has(entry.item.id) && tasks.get(entry.item.id).status !== "done");
  return { missing, toDone };
}

function projectBody(plan) {
  return {
    name: plan.planacry.projectName,
    description: `${plan.subtitle}\nПроект синхронизируется со страницей /learning/ — теги ${plan.planacry.tag}… в описаниях задач не удаляй.`,
    color: plan.planacry.color,
    deadline: plan.schedule.end,
    planned_hours: plan.schedule.totalHours,
  };
}

function taskBody(plan, { stage, item }) {
  const lines = [item.how];
  const links = item.links || [];
  if (links.length) lines.push("", "Ссылки:", ...links.map(([label, url]) => `— ${label}: ${url}`));
  lines.push("", plan.planacry.tag + item.id);
  return {
    name: `${stage.code} · ${item.title}`,
    description: lines.join("\n"),
    planned_hours: item.h,
    deadline: item.deadline,
    priority: item.priority,
    status: item.done ? "done" : "backlog",
  };
}
