#!/usr/bin/env node
// Markdown CRM: one .md file per record. Frontmatter holds the fields, the body holds notes.
// No deps (Node 18+). Part of pumpgtm-ai-opencrm, https://github.com/pumpgtm/pumpgtm-ai-opencrm
// Records live in $CRM_DIR (default ./crm). Run with no args for usage. See README.md, SCHEMA.md.
//
// Library (require("./crm")): { setRoot, schema, all, find, upsertAccount, upsertPerson,
//   logActivity, accountForEmail, createTask, updateTask, createAgreement, updateAgreement, accountView, pipeline,
//   due, validate }

const fs = require("fs");
const path = require("path");

let ROOT = path.resolve(process.env.CRM_DIR || "crm");
const setRoot = (dir) => { ROOT = path.resolve(dir); };

// Only fields that were filled on most records of a real 5-month sales pipeline. See SCHEMA.md.
const DEFAULT_SCHEMA = {
  accounts: {
    name: "text",
    stage: ["Discovery", "Scoping", "Pilot", "Customer", "Lost"],
    source: ["Outbound", "Inbound", "Referral"],
    domain: "text",
  },
  people: {
    name: "text",
    email: "text",
    account: "account",
    status: ["Engaged", "Active", "Inactive", "Disqualified"],
    channel: ["LinkedIn", "Email"],
    linkedin: "text",
  },
  activities: {
    name: "text",
    date: "date",
    type: ["Meeting", "Email", "LinkedIn", "Other"],
    account: "account",
    attendees: "list",
    source: "text",
    source_id: "text",
    url: "text",
  },
  tasks: {
    name: "text",
    due: "date",
    status: ["Open", "Waiting", "Done", "Skipped"],
    type: ["Follow-up", "LinkedIn", "Email", "Call", "Internal"],
    account: "account",
    person: "text",
    activity: "text",
  },
  agreements: {
    name: "text",
    account: "account",
    type: ["Order Form", "Invoice", "SOW", "NDA"],
    status: ["Sent", "Signed", "Active", "Paid", "Unpaid", "Cancelled"],
    fee: "number",
    effective: "date",
    next: "date",
    signer: "text",
    ref: "text",
  },
};
const OPEN = ["Open", "Waiting"];

// schema.json in the CRM dir replaces the default enums (written by `crm init`).
function schema() {
  const file = path.join(ROOT, "schema.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : DEFAULT_SCHEMA;
}

const today = () => new Date().toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const emailFile = (s) => String(s).toLowerCase().replace(/[^a-z0-9@._+-]+/g, "-");
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// ---- file format ----

function parse(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: text.trim() };
  const rec = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    rec[k] = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean) : v;
  }
  rec.body = m[2].trim();
  return rec;
}

function format(rec) {
  const lines = Object.entries(rec)
    .filter(([k, v]) => k !== "body" && k !== "file" && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : String(v).replace(/\n/g, " ")}`);
  return `---\n${lines.join("\n")}\n---\n${rec.body ? `\n${rec.body}\n` : ""}`;
}

function all(kind) {
  const dir = path.join(ROOT, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
    .map((f) => ({ ...parse(fs.readFileSync(path.join(dir, f), "utf8")), file: `${kind}/${f}` }));
}

function find(kind, file) {
  const p = path.join(ROOT, kind, `${file}.md`);
  return fs.existsSync(p) ? { ...parse(fs.readFileSync(p, "utf8")), file: `${kind}/${file}.md` } : null;
}

// Checks one record against the schema. Returns a list of problems (empty = valid).
function check(kind, rec) {
  const fields = schema()[kind], errors = [];
  for (const [k, v] of Object.entries(rec)) {
    if (k === "body" || k === "file" || v === "" || v === undefined) continue;
    const type = fields[k];
    if (!type) errors.push(`unknown field "${k}"`);
    else if (Array.isArray(type) && !type.includes(v)) errors.push(`${k}="${v}" is not one of: ${type.join(" | ")}`);
    else if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${k}="${v}" is not YYYY-MM-DD`);
    else if (type === "number" && !Number.isFinite(Number(v))) errors.push(`${k}="${v}" is not a number`);
    else if (type === "account" && !find("accounts", slug(v))) errors.push(`account "${v}" does not exist`);
  }
  if (!rec.name) errors.push(`missing name`);
  return errors;
}

// Fixes enum casing ("lost" -> "Lost") and splits list fields given as "a,b".
function normalize(kind, input) {
  const fields = schema()[kind], out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    const type = fields[k];
    out[k] = Array.isArray(type) ? type.find((t) => same(t, v)) || v
      : type === "list" && !Array.isArray(v) ? String(v).split(",").map((x) => x.trim()).filter(Boolean)
      : type === "account" ? (find("accounts", slug(v)) || {}).name || v
      : v;
  }
  return out;
}

// Merges fields into the record, appends note to the body, validates, writes. Returns the record.
function save(kind, file, input, note) {
  const { note: _, ...fields } = input;
  const rec = { name: undefined, ...(find(kind, file) || {}), ...normalize(kind, fields) };
  if (note && !(rec.body || "").includes(note)) rec.body = [rec.body, kind === "activities" ? note : `${today()}: ${note}`].filter(Boolean).join("\n\n");
  const errors = check(kind, rec);
  if (errors.length) throw new Error(`${kind}/${file}.md: ${errors.join("; ")}`);
  fs.mkdirSync(path.join(ROOT, kind), { recursive: true });
  fs.writeFileSync(path.join(ROOT, kind, `${file}.md`), format(rec));
  return { ...rec, file: `${kind}/${file}.md` };
}

// ---- writes (upsert keys: account name, person email, activity dedup ids, task/agreement account + title) ----

const upsertAccount = (name, fields = {}) => save("accounts", slug(name), { ...fields, name }, fields.note);

function upsertPerson(email, fields = {}) {
  const key = email ? email.toLowerCase() : slug(fields.name || "");
  if (!key) throw new Error("person needs an email or a name");
  return save("people", email ? emailFile(key) : key, { ...fields, email: email ? key : undefined }, fields.note);
}

// Facts only: never changes an account's stage. Dedup key is source + source_id (or date + title).
function logActivity(name, fields = {}) {
  const date = fields.date || today();
  const id = fields.source_id && String(fields.source_id);
  const file = id ? `${date}-${slug(name)}-${slug(id).slice(-12)}` : `${date}-${slug(name)}`;
  const hit = id ? all("activities").find((a) => a.source_id === id && same(a.source, fields.source)) : find("activities", file);
  if (hit) return { ...hit, skipped: true };
  return save("activities", file, { type: "Other", ...fields, name, date }, fields.note);
}

// The account whose domain matches this email, for integrations that only know attendee emails.
function accountForEmail(email) {
  const domain = String(email || "").toLowerCase().split("@")[1];
  return domain ? all("accounts").find((a) => a.domain && (domain === a.domain || domain.endsWith(`.${a.domain}`))) || null : null;
}

function matchOne(kind, account, title, filter = () => true) {
  const hits = all(kind).filter((r) => same(r.account, account) && filter(r) && String(r.name).toLowerCase().includes(String(title).toLowerCase()));
  if (hits.length !== 1) throw new Error(`${hits.length} ${kind} on "${account}" match "${title}"`);
  return hits[0];
}
const fileKey = (rec) => path.basename(rec.file, ".md");

const createTask = (name, fields = {}) =>
  save("tasks", `${slug(fields.account)}--${slug(name)}`, { status: "Open", type: "Follow-up", ...fields, name }, fields.note);
const updateTask = (account, title, fields = {}) =>
  save("tasks", fileKey(matchOne("tasks", account, title, (t) => OPEN.includes(t.status))), fields, fields.note);

const createAgreement = (name, fields = {}) =>
  save("agreements", `${slug(fields.account)}--${slug(name)}`, { ...fields, name }, fields.note);
const updateAgreement = (account, title, fields = {}) =>
  save("agreements", fileKey(matchOne("agreements", account, title)), fields, fields.note);

// ---- reads ----

// Account plus everything related. last_contact and next_followup are derived, never stored.
function accountView(name) {
  const account = find("accounts", slug(name));
  if (!account) throw new Error(`account "${name}" does not exist`);
  const mine = (kind) => all(kind).filter((r) => same(r.account, account.name));
  const activities = mine("activities").sort((a, b) => b.date.localeCompare(a.date));
  const tasks = mine("tasks").sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
  const open = tasks.filter((t) => OPEN.includes(t.status) && t.due);
  return {
    ...account,
    last_contact: activities[0] ? activities[0].date : null,
    next_followup: open[0] ? open[0].due : null,
    people: mine("people"),
    activities,
    tasks,
    agreements: mine("agreements"),
  };
}

// Every live deal (stage set, not Lost), most neglected first.
function pipeline() {
  return all("accounts").filter((a) => a.stage && a.stage !== "Lost")
    .map((a) => accountView(a.name))
    .sort((a, b) => (a.last_contact || "").localeCompare(b.last_contact || ""));
}

// Every Open/Waiting task across the CRM, soonest due first.
const due = () => all("tasks").filter((t) => OPEN.includes(t.status)).sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));

// Schema errors on every record, plus live deals that have no open task (every next step needs one).
function validate() {
  const problems = [];
  for (const kind of Object.keys(schema())) for (const r of all(kind)) for (const e of check(kind, r)) problems.push(`${r.file}: ${e}`);
  for (const a of pipeline()) if (!a.next_followup) problems.push(`${a.file}: live deal (${a.stage}) has no open task with a due date`);
  return problems;
}

module.exports = { setRoot, schema, all, find, upsertAccount, upsertPerson, logActivity, accountForEmail, createTask, updateTask, createAgreement, updateAgreement, accountView, pipeline, due, validate };

// ---- CLI ----

const USAGE = `crm <command>   (records in $CRM_DIR, default ./crm; add --json for machine output)

  init                                     create the folders and schema.json
  account "<Name>" [stage= source= domain= note=]
  person <email|-> [name= account= status= channel= linkedin= note=]
  activity "<Title>" [account= date= type= attendees=a@x,b@y source= source_id= url= note=]
  task create "<Title>" account= [due= status=Open type=Follow-up person= activity= note=]
  task done|skip account= title=<substring>
  task snooze account= title=<substring> due=YYYY-MM-DD
  task set account= title=<substring> [status= due= note=]
  agreement create "<Title>" account= type= [status= fee= effective= next= signer= ref= note=]
  agreement set account= title=<substring> [status= next= fee= note=]
  show "<Name>"                            account with people, activities, tasks, agreements
  pipeline                                 live deals, most neglected first
  due                                      open and waiting tasks, soonest first
  list <accounts|people|activities|tasks|agreements> [field=value ...]
  validate                                 schema errors and live deals with no next step`;

function cli(argv) {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const opt = Object.fromEntries(args.filter((a) => /^[a-z_]+=/.test(a)).map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]));
  const [cmd, a1, a2] = args.filter((a) => !/^[a-z_]+=/.test(a));
  const out = (result, text) => console.log(json ? JSON.stringify(result, null, 2) : text(result));
  const saved = (r) => `${r.skipped ? "exists " : "saved  "}${r.file}`;
  const row = (r) => [r.due || r.date || "", r.status || r.stage || r.type || "", r.account || "", r.name].filter(Boolean).join("  ");

  if (cmd === "init") {
    fs.mkdirSync(ROOT, { recursive: true });
    for (const k of Object.keys(DEFAULT_SCHEMA)) fs.mkdirSync(path.join(ROOT, k), { recursive: true });
    const file = path.join(ROOT, "schema.json");
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(DEFAULT_SCHEMA, null, 2) + "\n");
    return out({ root: ROOT }, () => `crm ready at ${ROOT}`);
  }
  if (cmd === "account" && a1) return out(upsertAccount(a1, opt), saved);
  if (cmd === "person" && a1) return out(upsertPerson(a1 === "-" ? null : a1, opt), saved);
  if (cmd === "activity" && a1) return out(logActivity(a1, opt), saved);
  if (cmd === "task" && a1 === "create" && a2) return out(createTask(a2, opt), saved);
  if (cmd === "task" && ["done", "skip", "snooze", "set"].includes(a1) && opt.account && opt.title) {
    const { account, title, ...rest } = opt;
    if (a1 === "snooze" && !rest.due) throw new Error("snooze needs due=YYYY-MM-DD");
    const status = { done: "Done", skip: "Skipped" }[a1];
    return out(updateTask(account, title, status ? { ...rest, status } : rest), saved);
  }
  if (cmd === "agreement" && a1 === "create" && a2) return out(createAgreement(a2, opt), saved);
  if (cmd === "agreement" && a1 === "set" && opt.account && opt.title) {
    const { account, title, ...rest } = opt;
    return out(updateAgreement(account, title, rest), saved);
  }
  if (cmd === "show" && a1) return out(accountView(a1), (v) => [
    `# ${v.name}  ${[v.stage, v.source, v.domain].filter(Boolean).join(" · ")}`,
    `last contact ${v.last_contact || "never"} · next follow-up ${v.next_followup || "none"}`,
    v.body && `\n${v.body}`,
    `\npeople\n${v.people.map((p) => `  ${p.name || ""} <${p.email || "no email"}> ${p.status || ""}`).join("\n") || "  none"}`,
    `tasks\n${v.tasks.map((t) => `  ${row(t)}`).join("\n") || "  none"}`,
    `activities\n${v.activities.map((x) => `  ${x.date}  ${x.type}  ${x.name}`).join("\n") || "  none"}`,
    `agreements\n${v.agreements.map((g) => `  ${g.type}  ${g.status || ""}  ${g.fee ? `$${g.fee}` : ""}  ${g.name}`).join("\n") || "  none"}`,
  ].filter(Boolean).join("\n"));
  if (cmd === "pipeline") return out(pipeline(), (rows) => rows.map((a) =>
    `${(a.last_contact || "never").padEnd(10)}  ${(a.next_followup || "no task").padEnd(10)}  ${a.stage.padEnd(16)}  ${a.name}`).join("\n") || "no live deals");
  if (cmd === "due") return out(due(), (rows) => rows.map(row).join("\n") || "nothing due");
  if (cmd === "list" && schema()[a1]) {
    const rows = all(a1).filter((r) => Object.entries(opt).every(([k, v]) => same(r[k], v)));
    return out(rows, (rs) => rs.map(row).join("\n") || "none");
  }
  if (cmd === "validate") {
    const problems = validate();
    out(problems, (p) => p.join("\n") || "ok");
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (e) { console.error(`error: ${e.message}`); process.exitCode = 1; }
}
