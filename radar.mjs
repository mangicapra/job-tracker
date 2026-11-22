#!/usr/bin/env node
// Job radar: pulls open roles from (1) the public jobs_db API and (2) the
// public job-board APIs of companies on a watchlist, keeps the ones the person
// can actually take, scores them against their CV and writes CSVs you can open
// in Google Sheets / Excel.
//
// Everything person-specific lives in profiles/<name>/:
//   profile.json   titles to look for, where they can work, optional skill list
//   cv.txt         their CV as plain text
//   watchlist.txt  company job-board links to check
//
//   node radar.mjs dragan             # both sources
//   node radar.mjs dragan --boards    # watchlist only (fast, run this daily)
//   node radar.mjs dragan --db        # jobs_db only
//   node radar.mjs dragan --all       # also keep roles they can't take, marked
//
// Needs Node 18+ (built-in fetch). No npm install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = path.join(DIR, "profiles");
const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith("--")));
const ONLY_DB = FLAGS.has("--db");
const ONLY_BOARDS = FLAGS.has("--boards");
const KEEP_ALL = FLAGS.has("--all");

const DB_MAX_ROWS = 4000; // most rows to pull from jobs_db per run
const DB_PAGE = 250;
const JOBS_DB = {
  url: "https://snimonofzyrbsqovpnsq.supabase.co/rest/v1/ds_hiring_cafe",
  // publishable, read-only key published in the jobs_db README
  key: "sb_publishable_TPu8VN6vPj2yKYAG-Z-_fg_LubsqKkn",
};

// ---------- location signals (shared by every profile) ----------
const US_ONLY = [
  /\b(US|U\.S\.|USA|United States)[- ]?(only|based)\b/i,
  /must (be )?(located|based|reside|residing|live|living) in the (US|U\.S\.|USA|United States)/i,
  /(authori[sz]ed|eligible|legally able) to work in the (US|U\.S\.|USA|United States)/i,
  /\bremote\b[^\n]{0,6}\b(US|USA|United States)\b/i,
  /\b(US|USA|United States)[^\n]{0,4}\bremote\b/i,
  /\bUS citizens?(hip)?\b|security clearance/i,
];
const EUROPE = [/\beurope\b|\beuropean\b|\bEMEA\b|\bEU\b/i, /\bCET\b|\bCEST\b|GMT ?\+ ?[12]|UTC ?\+ ?[12]/i];
// "remote-first" or "distributed team" says nothing about where they hire, so it's not here
const WORLDWIDE = /anywhere|worldwide|world-wide|\bglobal(ly)?\b|any location|any country|any time ?zone/i;
// A remote role tied to one European country: often open to residents of that
// country (or the EU) only.
const EU_COUNTRY = /estonia|latvia|lithuania|poland|germany|berlin|munich|hamburg|netherlands|amsterdam|belgium|france|paris|spain|madrid|barcelona|portugal|lisbon|ireland|dublin|united kingdom|\bUK\b|london|austria|vienna|switzerland|zurich|czech|prague|slovakia|hungary|budapest|romania|bulgaria|greece|italy|milan|denmark|sweden|stockholm|norway|finland|slovenia|croatia|serbia|cyprus|malta|luxembourg/i;

// ---------- profile ----------
function listProfiles() {
  if (!fs.existsSync(PROFILES)) return [];
  return fs.readdirSync(PROFILES).filter((d) =>
    !d.startsWith("_") && fs.existsSync(path.join(PROFILES, d, "profile.json")));
}

function loadProfile() {
  const available = listProfiles();
  let name = argv.find((a) => !a.startsWith("--"));
  if (!name && available.length === 1) name = available[0];
  if (!name || !available.includes(name)) {
    console.error(name ? `No profile called "${name}".` : "Say which profile to run.");
    console.error(`Profiles: ${available.join(", ") || "(none yet — copy profiles/_template)"}`);
    console.error("Usage: node radar.mjs <profile> [--boards|--db|--all]");
    process.exit(1);
  }
  const dir = path.join(PROFILES, name);
  const p = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8"));
  const words = (list) => (list || []).filter(Boolean)
    .map((s) => s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  const anyOf = (list) => (words(list).length ? new RegExp(`\\b(${words(list).join("|")})\\b`, "i") : null);
  if (!p.titles?.length) throw new Error(`${name}/profile.json needs at least one entry in "titles"`);
  const cvFile = path.join(dir, p.cv || "cv.txt");
  if (!fs.existsSync(cvFile)) throw new Error(`CV not found: ${cvFile}`);
  return {
    name, dir, out: path.join(dir, "out"),
    titles: p.titles,
    titleInclude: anyOf(p.titles),
    titleExclude: anyOf(p.excludeTitles),
    titleBoost: anyOf(p.boostTitleWords),
    titlePenalty: anyOf(p.avoidTitleWords),
    region: (p.canWorkIn || "anywhere").toLowerCase(), // "europe" | "us" | "anywhere"
    localPlaces: anyOf(p.localPlaces),
    remoteOnly: p.remoteOnly !== false,
    skills: Array.isArray(p.skills) && p.skills.length
      ? p.skills.map(([label, re, w]) => [label, new RegExp(re, "i"), w || 1]) : null,
    cv: fs.readFileSync(cvFile, "utf8").replace(/\S+@\S+/g, " ").replace(/\b(email|phone|tel)\s*:/gi, " "),
    watchlist: path.join(dir, "watchlist.txt"),
  };
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function toText(html) {
  if (!html) return "";
  return decodeEntities(decodeEntities(String(html)).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function getJSON(url, opts = {}, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return { notFound: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get("content-type") || "";
      return type.includes("json") ? await res.json() : await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500);
    }
  }
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCSV(file, rows, cols) {
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  fs.writeFileSync(file, "﻿" + lines.join("\n")); // BOM so Excel reads UTF-8
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ---------- source 1: jobs_db (hiring.cafe US snapshot) ----------
async function fromJobsDb(profile) {
  const select = [
    "primary_key", "title", "company_name", "company_industry", "company_hq_country",
    "company_employee_count", "workplace_type", "locations", "salary_min_yearly",
    "salary_max_yearly", "apply_url", "description_md", "scraped_at",
  ].join(",");
  // short titles like "PM" would match half the database; the title filter catches them later
  const phrases = profile.titles.filter((t) => t.trim().length >= 4 && !/[,()]/.test(t));
  if (!phrases.length) { console.warn("  jobs_db skipped: no title long enough to search for"); return []; }
  const or = `(${phrases.map((t) => `title.ilike.*${t.trim()}*`).join(",")})`;
  const remote = profile.remoteOnly ? "&workplace_type=eq.Remote" : "";
  const jobs = [];
  for (let offset = 0; offset < DB_MAX_ROWS; offset += DB_PAGE) {
    const url = `${JOBS_DB.url}?select=${select}&or=${encodeURIComponent(or)}${remote}&limit=${DB_PAGE}&offset=${offset}`;
    let rows;
    try {
      rows = await getJSON(url, { headers: { apikey: JOBS_DB.key } }, 3);
    } catch (e) {
      console.warn(`  jobs_db stopped at offset ${offset}: ${e.message}`);
      break;
    }
    if (!Array.isArray(rows)) {
      console.warn("  jobs_db returned something unexpected:", String(JSON.stringify(rows)).slice(0, 200));
      break;
    }
    for (const r of rows) {
      const loc = Array.isArray(r.locations) ? r.locations.join("; ") : r.locations || "";
      const isRemote = r.workplace_type === "Remote";
      jobs.push({
        id: `db:${r.primary_key}`, source: "jobs_db", title: r.title || "", company: r.company_name || "",
        location: isRemote ? (loc ? `Remote (${loc})` : "Remote") : `${r.workplace_type || ""} ${loc}`.trim(),
        remote: isRemote,
        salary: r.salary_min_yearly || r.salary_max_yearly ? `$${r.salary_min_yearly || "?"}–${r.salary_max_yearly || "?"}/yr` : "",
        url: r.apply_url || "", posted: (r.scraped_at || "").slice(0, 10), description: r.description_md || "",
        industry: Array.isArray(r.company_industry) ? r.company_industry.join("; ") : r.company_industry || "",
        hq: r.company_hq_country || "", size: r.company_employee_count || "",
      });
    }
    process.stdout.write(`\r  jobs_db: ${jobs.length} rows`);
    if (rows.length < DB_PAGE) break;
    await sleep(300);
  }
  process.stdout.write("\n");
  return jobs;
}

// ---------- source 2: company job boards on the watchlist ----------
function parseBoard(line) {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;
  let u;
  try { u = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { return { unsupported: raw }; }
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split("/").filter(Boolean)[0];
  if (host.endsWith("greenhouse.io")) {
    const slug = u.searchParams.get("for") || (first === "embed" ? null : first);
    return slug && { ats: "greenhouse", slug, eu: host.includes(".eu.") };
  }
  if (host.endsWith("lever.co")) return first && { ats: "lever", slug: first, eu: host.includes(".eu.") };
  if (host.endsWith("ashbyhq.com")) return first && { ats: "ashby", slug: first };
  if (host.endsWith("smartrecruiters.com")) return first && { ats: "smartrecruiters", slug: first };
  if (host.endsWith("workable.com")) return first && first !== "j" && { ats: "workable", slug: first };
  if (host.endsWith(".recruitee.com")) return { ats: "recruitee", slug: host.split(".")[0] };
  if (host.includes(".jobs.personio.")) return { ats: "personio", slug: host.split(".")[0], tld: host.split(".").pop() };
  if (host.endsWith(".breezy.hr")) return { ats: "breezy", slug: host.split(".")[0] };
  if (host.endsWith(".bamboohr.com")) return { ats: "bamboohr", slug: host.split(".")[0] };
  return { unsupported: raw };
}

const BOARDS = {
  async greenhouse({ slug, eu }) {
    const hosts = eu ? ["boards-api.eu.greenhouse.io", "boards-api.greenhouse.io"] : ["boards-api.greenhouse.io"];
    for (const h of hosts) {
      const data = await getJSON(`https://${h}/v1/boards/${slug}/jobs?content=true`);
      if (data?.notFound) continue;
      return (data.jobs || []).map((j) => ({
        id: `gh:${slug}:${j.id}`, title: j.title, location: j.location?.name || "",
        url: j.absolute_url, posted: (j.updated_at || "").slice(0, 10), description: toText(j.content),
      }));
    }
    return null;
  },
  async lever({ slug, eu }) {
    const data = await getJSON(`https://api${eu ? ".eu" : ""}.lever.co/v0/postings/${slug}?mode=json`);
    if (data?.notFound || !Array.isArray(data)) return null;
    return data.map((j) => ({
      id: `lv:${slug}:${j.id}`, title: j.text,
      location: [j.workplaceType, ...(j.categories?.allLocations || [j.categories?.location])].filter(Boolean).join("; "),
      remote: j.workplaceType === "remote" || undefined,
      url: j.hostedUrl, posted: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : "",
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text} ${toText(l.content)}`), j.additionalPlain].join(" "),
    }));
  },
  async ashby({ slug }) {
    const data = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    if (data?.notFound || !data?.jobs) return null;
    return data.jobs.filter((j) => j.isListed !== false).map((j) => ({
      id: `ab:${slug}:${j.id || j.jobUrl}`, title: j.title,
      location: [j.location, ...(j.secondaryLocations || []).map((s) => s.location || s)].filter(Boolean).join("; "),
      remote: j.isRemote || j.workplaceType === "Remote" || undefined,
      salary: j.compensation?.compensationTierSummary || "",
      url: j.jobUrl, posted: (j.publishedAt || "").slice(0, 10), description: j.descriptionPlain || toText(j.descriptionHtml),
    }));
  },
  async smartrecruiters({ slug }) {
    const data = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
    if (data?.notFound || !data?.content) return null;
    return data.content.map((j) => ({
      id: `sr:${slug}:${j.id}`, title: j.name,
      location: [j.location?.remote ? "Remote" : "", j.location?.city, j.location?.country].filter(Boolean).join(", "),
      remote: j.location?.remote || undefined,
      url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, posted: (j.releasedDate || "").slice(0, 10),
      description: "", // list endpoint has no description; title/location only
    }));
  },
  async workable({ slug }) {
    const data = await getJSON(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
    if (data?.notFound || !data?.jobs) return null;
    return data.jobs.map((j) => ({
      id: `wk:${slug}:${j.shortcode}`, title: j.title,
      location: [j.telecommuting ? "Remote" : "", j.city, j.country].filter(Boolean).join(", "),
      remote: j.telecommuting || undefined,
      url: j.url || j.shortlink, posted: j.published_on || "", description: toText(j.description),
    }));
  },
  async recruitee({ slug }) {
    const data = await getJSON(`https://${slug}.recruitee.com/api/offers/`);
    if (data?.notFound || !data?.offers) return null;
    return data.offers.map((j) => ({
      id: `rc:${slug}:${j.id}`, title: j.title,
      location: [j.remote ? "Remote" : "", j.location].filter(Boolean).join(", "),
      remote: j.remote || undefined,
      url: j.careers_url, posted: (j.published_at || "").slice(0, 10),
      description: toText(`${j.description || ""} ${j.requirements || ""}`),
    }));
  },
  async personio({ slug, tld }) {
    const xml = await getJSON(`https://${slug}.jobs.personio.${tld || "de"}/xml?language=en`);
    if (xml?.notFound || typeof xml !== "string") return null;
    const tag = (s, t) => (s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || "";
    return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(([, p]) => {
      const id = toText(tag(p, "id"));
      return {
        id: `ps:${slug}:${id}`, title: toText(tag(p, "name")), location: toText(tag(p, "office")),
        url: `https://${slug}.jobs.personio.${tld || "de"}/job/${id}`, posted: toText(tag(p, "createdAt")).slice(0, 10),
        description: toText(tag(p, "jobDescriptions").replace(/<!\[CDATA\[|\]\]>/g, "")),
      };
    });
  },
  async bamboohr({ slug }) {
    const data = await getJSON(`https://${slug}.bamboohr.com/careers/list`);
    const list = data?.result;
    if (data?.notFound || !Array.isArray(list)) return null;
    return list.map((j) => ({
      id: `bh:${slug}:${j.id}`, title: j.jobOpeningName,
      location: [j.isRemote ? "Remote" : "", j.location?.city, j.location?.state, j.atsLocation?.country].filter(Boolean).join(", "),
      remote: j.isRemote || undefined,
      url: `https://${slug}.bamboohr.com/careers/${j.id}`, posted: "", description: "",
    }));
  },
  async breezy({ slug }) {
    const data = await getJSON(`https://${slug}.breezy.hr/json`);
    if (data?.notFound || !Array.isArray(data)) return null;
    return data.map((j) => ({
      id: `bz:${slug}:${j.id}`, title: j.name,
      location: [j.location?.is_remote ? "Remote" : "", j.location?.name].filter(Boolean).join(", "),
      remote: j.location?.is_remote || undefined,
      url: j.url, posted: (j.published_date || "").slice(0, 10), description: "",
    }));
  },
};

async function fromBoards(profile) {
  if (!fs.existsSync(profile.watchlist)) return { jobs: [], report: [] };
  const seen = new Set();
  const boards = [];
  const report = [];
  for (const line of fs.readFileSync(profile.watchlist, "utf8").split("\n")) {
    const b = parseBoard(line);
    if (!b) continue;
    if (b.unsupported) { report.push(`skipped (board type not supported): ${b.unsupported}`); continue; }
    const key = `${b.ats}:${b.slug}`;
    if (!seen.has(key)) { seen.add(key); boards.push(b); }
  }
  const all = [];
  await pool(boards, 5, async (b) => {
    try {
      const jobs = await BOARDS[b.ats](b);
      if (!jobs) { report.push(`not found: ${b.ats}/${b.slug} — check the link`); return; }
      report.push(`ok: ${b.ats}/${b.slug} — ${jobs.length} open role${jobs.length === 1 ? "" : "s"}`);
      for (const j of jobs) all.push({ ...j, source: b.ats, company: b.slug, description: j.description || "" });
    } catch (e) {
      report.push(`error: ${b.ats}/${b.slug} — ${e.message}`);
    }
  });
  console.log(`  watchlist: ${boards.length} boards, ${all.length} open roles in total`);
  return { jobs: all, report: report.sort() };
}

// ---------- where can they work ----------
function locationSignals(job, profile) {
  const loc = `${job.title} ${job.location}`;
  const text = `${loc} ${job.description}`;
  const has = (res, s) => (Array.isArray(res) ? res : [res]).some((r) => r.test(s));
  return {
    local: !!profile.localPlaces?.test(loc),
    us: has(US_ONLY, loc) || (!has(WORLDWIDE, loc) && !has(EUROPE, loc) && has(US_ONLY, text)),
    europe: has(EUROPE, loc) || (!has(US_ONLY, loc) && has(EUROPE, text)),
    worldwide: has(WORLDWIDE, loc) || (!has(US_ONLY, loc) && has(WORLDWIDE, text)),
    country: EU_COUNTRY.test(job.location) ? (job.location.match(EU_COUNTRY) || [""])[0] : "",
  };
}

// Returns [label, keep?]. Labels: local, ok, maybe, check, restricted.
function eligibility(sig, profile) {
  if (sig.local) return ["local", true];
  const where = sig.worldwide ? "worldwide" : sig.europe ? "Europe" : sig.us ? "US" : sig.country || "?";
  if (profile.region === "europe") {
    if (sig.worldwide || (sig.europe && !sig.us)) return [`ok (${where})`, true];
    if (sig.us) return ["restricted (US only)", false];
    if (sig.country) return [`maybe (${sig.country})`, true];
    return ["check", true];
  }
  if (profile.region === "us") {
    if (sig.worldwide || sig.us) return [`ok (${where})`, true];
    if (sig.europe || sig.country) return [`restricted (${sig.europe ? "Europe" : sig.country})`, false];
    return ["check", true];
  }
  return [where === "?" ? "check" : `ok (${where})`, true]; // anywhere
}

function isRemote(job) {
  return job.remote === true || /remote|anywhere|distributed/i.test(job.location);
}

// ---------- matching: curated skill list (if the profile has one) ----------
function curatedScorer(profile) {
  const cvTerms = new Set(profile.skills.filter(([, re]) => re.test(profile.cv)).map(([l]) => l));
  return {
    cvHas: (label) => cvTerms.has(label),
    score(job) {
      const text = `${job.title} ${job.description}`;
      const asked = profile.skills.filter(([, re]) => re.test(text));
      const hit = asked.filter(([l]) => cvTerms.has(l));
      const w = (arr) => arr.reduce((s, [, , wt]) => s + wt, 0);
      const coverage = asked.length ? w(hit) / w(asked) : 0.5;
      const breadth = Math.min(hit.length / 8, 1);
      return {
        base: 100 * (0.6 * coverage + 0.4 * breadth),
        matched: hit.map(([l]) => l), gaps: asked.filter(([l]) => !cvTerms.has(l)).map(([l]) => l),
        asked: asked.map(([l]) => l),
      };
    },
  };
}

// ---------- matching: automatic (works for any role, no skill list needed) ----------
// Learns which words and two-word phrases matter from the job ads themselves:
// terms that show up in many ads for this kind of role are requirements; terms in
// every ad ("team", "work") or in just one are noise. A job scores higher the more
// of its requirement terms also appear in the CV.
const STOP = new Set(("a an the and or of to in for on with at by from as is are be been will would you your yours we our ours us " +
  "this that these those it its into across their they them who whom what which how can could able ability have has had " +
  "strong experience experienced years year work working works team teams role roles including such other new more most " +
  "within about using use used well while all any per not but also job jobs company companies help helps ensure etc e g i " +
  "do does did make makes making get gets very just like than then there here where when why so if no yes our we're you'll " +
  "you're we've it's they're want looking join part day days time great good best plus based across must should may might " +
  "every each both one two three first own over under up down out off them some many much need needs needed please apply " +
  "opportunity opportunities candidate candidates position positions responsibilities requirements qualifications preferred " +
  "benefits salary equal employer status gender race religion disability veteran national origin orientation " +
  // perks and benefits text, common in every ad but not a skill
  "equity insurance vacation pto paid leave flexible hours budget home offer offers perks stipend compensation bonus " +
  "distributed remote-first parental wellness holiday holidays health dental vision 401k pension retirement gym laptop " +
  "equipment allowance generous competitive unlimited").split(" "));

// where and how senior: handled elsewhere, not skills
const LOCATION_WORDS = new Set(("remote hybrid onsite on-site office location locations timezone timezones zone zones based " +
  "country countries city relocation europe european emea eu us usa americas apac worldwide anywhere cet est pst " +
  "senior junior mid staff principal lead level full-time part-time contract fulltime").split(" "));
// role nouns appear in nearly every ad title for the role
const ROLE_WORDS = new Set("engineer engineers developer developers manager managers designer designers analyst analysts specialist owner".split(" "));

function termsOf(text, skip = new Set()) {
  const words = text.toLowerCase()
    .replace(/[,;:!?()\[\]{}•·|"]+/g, " | ")       // phrases never run across punctuation
    .replace(/\.(\s|$)/g, " | ")
    .replace(/[^a-z0-9+#./| -]/g, " ")
    .split(/\s+/).map((w) => w.replace(/^[./-]+|[./-]+$/g, ""))
    .filter((w) => w === "|" || (w.length > 1 && !/^\d+$/.test(w)));
  const bad = (w) => w === "|" || STOP.has(w) || LOCATION_WORDS.has(w) || ROLE_WORDS.has(w);
  const out = new Set();
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    if (!bad(a) && a.length > 2) out.add(a);
    const b = words[i + 1];
    if (b && !bad(a) && !bad(b) && !skip.has(`${a} ${b}`)) out.add(`${a} ${b}`);
  }
  return out;
}

// "state management" says more than "state" and "management" on their own:
// drop single words that are part of a phrase in the same list.
function preferPhrases(list) {
  const inPhrase = new Set(list.filter((t) => t.includes(" ")).flatMap((t) => t.split(" ")));
  return list.filter((t) => t.includes(" ") || !inPhrase.has(t));
}

function autoScorer(profile, jobs) {
  // the job titles they search for are in every ad, so they tell us nothing
  const skip = new Set(profile.titles.map((t) => t.toLowerCase().trim().replace(/\s+/g, " ")));
  const terms = (text) => termsOf(text, skip);
  const cvTerms = terms(profile.cv);
  const docs = jobs.filter((j) => j.description).map((j) => terms(`${j.title} ${j.description}`));
  const df = new Map();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  const minDf = n >= 15 ? 2 : 1; // a term only one ad uses is that company's wording, not a requirement
  // weight = how many ads for this role ask for it, so the common requirements count most
  const weight = (t) => df.get(t) || 0;
  const significant = (t) => weight(t) >= minDf;
  return {
    cvHas: (t) => cvTerms.has(t),
    score(job) {
      if (!job.description) {
        // title only: compare title words with the CV
        const tt = [...termsOf(job.title)].filter((t) => !t.includes(" "));
        const hit = tt.filter((t) => cvTerms.has(t));
        return { base: tt.length ? 50 * (hit.length / tt.length) : 25, matched: hit, gaps: [], asked: [] };
      }
      const jt = [...terms(`${job.title} ${job.description}`)].filter(significant);
      const hit = jt.filter((t) => cvTerms.has(t));
      const sum = (arr) => arr.reduce((s, t) => s + weight(t), 0);
      const coverage = jt.length ? sum(hit) / sum(jt) : 0;
      const breadth = Math.min(hit.length / 20, 1);
      // most common across ads first: those are the real requirements
      const byDf = (arr) => [...arr].sort((a, b) => (df.get(b) || 0) - (df.get(a) || 0));
      const miss = byDf(jt.filter((t) => !cvTerms.has(t)));
      return {
        base: 100 * (0.7 * Math.min(coverage * 1.5, 1) + 0.3 * breadth),
        matched: preferPhrases(byDf(hit)).slice(0, 10), gaps: preferPhrases(miss).slice(0, 8), asked: jt,
      };
    },
  };
}

// ---------- main ----------
async function main() {
  const profile = loadProfile();
  fs.mkdirSync(profile.out, { recursive: true });
  console.log(`Profile: ${profile.name} (${profile.skills ? "skill list" : "automatic"} matching, can work in: ${profile.region})`);

  console.log("Collecting jobs…");
  const jobs = [];
  let boardReport = [];
  if (!ONLY_BOARDS) {
    try { jobs.push(...(await fromJobsDb(profile))); } catch (e) { console.warn("  jobs_db failed:", e.message); }
  }
  if (!ONLY_DB) {
    const b = await fromBoards(profile);
    jobs.push(...b.jobs);
    boardReport = b.report;
  }

  const relevant = jobs.filter((j) =>
    profile.titleInclude.test(j.title) && !(profile.titleExclude && profile.titleExclude.test(j.title)));
  const scorer = profile.skills ? curatedScorer(profile) : autoScorer(profile, relevant);

  const seenFile = path.join(profile.out, "seen.json");
  const seenBefore = new Set(fs.existsSync(seenFile) ? JSON.parse(fs.readFileSync(seenFile, "utf8")) : []);
  const firstRun = seenBefore.size === 0;

  const rows = relevant.map((j) => {
    const [elig, ok] = eligibility(locationSignals(j, profile), profile);
    const remote = isRemote(j);
    const s = scorer.score(j);
    let score = s.base;
    if (profile.titleBoost?.test(j.title)) score += 8;
    if (profile.titlePenalty?.test(j.title)) score -= 15;
    if (!j.description) score -= 10; // title-only match, less certain
    const keep = ok && (!profile.remoteOnly || remote || elig === "local");
    return {
      ...j, score: Math.max(0, Math.min(100, Math.round(score))), eligibility: elig, keep,
      workplace: remote ? "remote" : "onsite/hybrid",
      matched: s.matched.join("; "), gaps: s.gaps.join("; "), asked: s.asked,
      new: firstRun || seenBefore.has(j.id) ? "" : "NEW",
    };
  });

  const usable = rows.filter((r) => KEEP_ALL || r.keep);
  usable.sort((a, b) => (b.new === "NEW") - (a.new === "NEW") || b.score - a.score);
  writeCSV(path.join(profile.out, "matches.csv"), usable,
    ["new", "score", "eligibility", "workplace", "title", "company", "location", "salary", "source",
      "posted", "url", "matched", "gaps"]);

  // company roll-up (every relevant role, incl. ones they can't take, so they see who hires)
  const companies = new Map();
  for (const r of rows) {
    const k = r.company.toLowerCase();
    const c = companies.get(k) || { company: r.company, roles: 0, usable_roles: 0, best_score: 0, where: new Set(),
      industry: r.industry || "", hq: r.hq || "", size: r.size || "", source: r.source, example_url: r.url };
    c.roles++;
    if (r.keep) c.usable_roles++;
    c.best_score = Math.max(c.best_score, r.score);
    c.where.add(r.eligibility);
    companies.set(k, c);
  }
  const companyRows = [...companies.values()]
    .map((c) => ({ ...c, eligibility_seen: [...c.where].join(" / ") }))
    .sort((a, b) => b.usable_roles - a.usable_roles || b.best_score - a.best_score || b.roles - a.roles);
  writeCSV(path.join(profile.out, "companies.csv"), companyRows,
    ["company", "roles", "usable_roles", "best_score", "eligibility_seen", "industry", "hq", "size", "source", "example_url"]);

  // keyword report over the better half of the roles they could take
  const withDesc = usable.filter((r) => r.keep && r.description).sort((a, b) => b.score - a.score);
  const focus = withDesc.slice(0, Math.max(5, Math.ceil(withDesc.length / 2)));
  const freq = new Map();
  for (const r of focus) for (const t of new Set(r.asked)) freq.set(t, (freq.get(t) || 0) + 1);
  const pct = (n) => `${Math.round((100 * n) / Math.max(focus.length, 1))}%`;
  const minShare = profile.skills ? 1 : Math.max(2, Math.ceil(focus.length * 0.15));
  const ranked = [...freq.entries()].filter(([, n]) => n >= minShare).sort((a, b) => b[1] - a[1]);
  const keepPhrases = (list) => {
    const kept = new Set(profile.skills ? list.map(([t]) => t) : preferPhrases(list.map(([t]) => t)));
    return list.filter(([t]) => kept.has(t));
  };
  const missing = keepPhrases(ranked.filter(([t]) => !scorer.cvHas(t))).slice(0, 50);
  const present = keepPhrases(ranked.filter(([t]) => scorer.cvHas(t))).slice(0, 50);

  const md = [
    `# Keyword report for ${profile.name} — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Based on the ${focus.length} best-matching roles ${profile.name} could take` +
      `${profile.skills ? "" : ". Automatic mode: terms come from the ads themselves, so expect some noise"}.`,
    "",
    "## Asked for often, not in the CV",
    "Only add what's true. If you have it, say it in the job ad's words.",
    "",
    ...(missing.length ? missing.map(([t, n]) => `- ${t} — in ${pct(n)} of roles`) : ["- (nothing stands out)"]),
    "",
    "## Asked for often, already in the CV",
    "",
    ...(present.length ? present.map(([t, n]) => `- ${t} — in ${pct(n)} of roles`) : ["- (nothing stands out)"]),
    "",
    "## Watchlist board check",
    "",
    ...(boardReport.length ? boardReport.map((l) => `- ${l}`) : ["- no watchlist boards checked"]),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(profile.out, "keyword-report.md"), md);

  fs.writeFileSync(seenFile, JSON.stringify([...new Set([...seenBefore, ...rows.map((r) => r.id)])]));

  console.log(`\nRelevant roles found: ${rows.length}. Kept: ${usable.length}` +
    `${KEEP_ALL ? ` (incl. ${usable.filter((r) => !r.keep).length} they can't take)` : ""}.`);
  if (!firstRun) console.log(`New since last run: ${usable.filter((r) => r.new).length}`);
  console.log(`Wrote profiles/${profile.name}/out/ matches.csv, companies.csv, keyword-report.md`);
  for (const r of usable.slice(0, 10)) {
    console.log(`  ${String(r.score).padStart(3)}  ${r.eligibility.padEnd(20)} ${r.title} — ${r.company}`);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
