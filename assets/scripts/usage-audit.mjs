import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const PRICE_REGISTRY_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const SUPPORTED_SOURCES_URL = "https://ccusage.com/guide/all-reports";
const TOKENMAXXING_API = "https://api.tokenmaxxing.sh";
const TOKENMAXXING_FIRST_DAY = "2026-01-01";

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

function runCcusage(args) {
  const globalName = process.platform === "win32" ? "ccusage.cmd" : "ccusage";
  let result = run(globalName, args);
  if (!result.error && result.status === 0) return result.stdout;

  const fallbacks = process.env.MYTOKEN_RUNTIME === "bun"
    ? [["bun", ["x", "ccusage", ...args]], ["npx", ["--yes", "ccusage@latest", ...args]]]
    : [["npx", ["--yes", "ccusage@latest", ...args]], ["bun", ["x", "ccusage", ...args]]];
  for (const [command, commandArgs] of fallbacks) {
    result = run(command, commandArgs);
    if (!result.error && result.status === 0) return result.stdout;
  }
  throw new Error(result.stderr?.trim() || "ccusage could not produce a JSON report.");
}

function parseJsonOutput(text) {
  const firstObject = text.indexOf("{");
  if (firstObject < 0) throw new Error("ccusage returned no JSON object.");
  try {
    return JSON.parse(text.slice(firstObject));
  } catch (error) {
    throw new Error(`Could not parse ccusage JSON: ${error.message}`);
  }
}

function asNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function breakdownsFor(owner) {
  const breakdowns = owner.modelBreakdowns ?? owner.breakdown;
  if (Array.isArray(breakdowns)) return breakdowns;
  if (breakdowns && typeof breakdowns === "object") {
    return Object.entries(breakdowns).map(([modelName, value]) => ({ modelName, ...value }));
  }
  const names = owner.modelsUsed ?? owner.models ?? [];
  if (Array.isArray(names) && names.length === 1) {
    return [{
      modelName: names[0],
      inputTokens: owner.inputTokens,
      outputTokens: owner.outputTokens,
      cacheCreationTokens: owner.cacheCreationTokens,
      cacheReadTokens: owner.cacheReadTokens,
    }];
  }
  return [{
    modelName: "(model detail unavailable)",
    inputTokens: owner.inputTokens,
    outputTokens: owner.outputTokens,
    cacheCreationTokens: owner.cacheCreationTokens,
    cacheReadTokens: owner.cacheReadTokens,
  }];
}

function parseUsage(payload) {
  const dailyRows = payload.daily ?? payload.data ?? [];
  if (!Array.isArray(dailyRows)) throw new Error("The ccusage daily JSON shape was not recognized.");
  const records = [];
  for (const row of dailyRows) {
    const date = row.date ?? row.period;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) continue;
    const agents = Array.isArray(row.agents) ? row.agents : [row];
    for (const agentRow of agents) {
      const source = String(agentRow.agent ?? row.agent ?? "unknown");
      for (const item of breakdownsFor(agentRow)) {
        records.push({
          date,
          source,
          model: String(item.modelName ?? item.model ?? "(unknown model)"),
          input: asNumber(item.inputTokens),
          output: asNumber(item.outputTokens),
          cacheCreate: asNumber(item.cacheCreationTokens),
          cacheRead: asNumber(item.cacheReadTokens),
          listCost: null,
          actualApiCost: null,
        });
      }
    }
  }
  return records;
}

function tokenmaxxingIdentity() {
  if (process.env.MYTOKEN_TOKENMAXXING_LOGIN) return process.env.MYTOKEN_TOKENMAXXING_LOGIN.trim();
  for (const args of [["whoami", "--json"], ["whoami"]]) {
    const result = run("tokenmaxxing", args);
    if (result.error || result.status !== 0) continue;
    try {
      const output = parseJsonOutput(result.stdout);
      const login = output.user?.login ?? output.login ?? output.account?.login;
      if (typeof login === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(login)) return login;
    } catch {
      const match = result.stdout.match(/(?:you are|signed in as|account|login|user)\s*[:=]?\s*([a-zA-Z0-9_-]{1,64})/i);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

async function askTokenmaxxingSync(login) {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`\nFound tokenmaxxing account “${login}”. Sync local usage to tokenmaxxing.sh before importing its longer history? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function importTokenmaxxingHistory(login) {
  const until = new Date().toISOString().slice(0, 10);
  const url = new URL(`/profiles/${encodeURIComponent(login)}/daily`, TOKENMAXXING_API);
  url.searchParams.set("groupBy", "model");
  url.searchParams.set("since", TOKENMAXXING_FIRST_DAY);
  url.searchParams.set("until", until);
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`tokenmaxxing.sh profile returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.days)) throw new Error("tokenmaxxing.sh returned an unexpected daily history format.");
  return payload.days.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.key && row.totalTokens > 0).map((row) => ({
    date: row.date,
    source: "tokenmaxxing history",
    model: String(row.key),
    input: Math.max(0, Number(row.totalTokens || 0) - Number(row.outputTokens || 0)),
    output: Number(row.outputTokens || 0),
    cacheCreate: 0,
    cacheRead: 0,
    listCost: null,
    actualApiCost: null,
    historyImported: true,
  }));
}

async function loadPriceRegistry() {
  const response = await fetch(PRICE_REGISTRY_URL, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`LiteLLM pricing registry returned HTTP ${response.status}`);
  return response.json();
}

function normalized(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findPriceEntry(model, registry) {
  if (registry[model]) return { key: model, value: registry[model] };
  const lower = model.toLowerCase();
  const entries = Object.entries(registry);
  const exact = entries.find(([key]) => key.toLowerCase() === lower);
  if (exact) return { key: exact[0], value: exact[1] };

  const suffix = model.includes("/") ? model.split("/").at(-1) : model;
  const suffixLower = suffix.toLowerCase();
  const exactSuffixes = entries.filter(([key]) => key.toLowerCase().endsWith(`/${suffixLower}`) || key.toLowerCase() === suffixLower);
  if (exactSuffixes.length === 1) return { key: exactSuffixes[0][0], value: exactSuffixes[0][1] };
  if (exactSuffixes.length > 1) {
    const prefix = model.includes("/") ? model.split("/")[0].toLowerCase() : "";
    const byProvider = exactSuffixes.find(([, value]) => String(value.litellm_provider ?? "").toLowerCase() === prefix);
    if (byProvider) return { key: byProvider[0], value: byProvider[1] };
  }

  const normalizedSuffix = normalized(suffix.replace(/-\d{8}$/, ""));
  const dated = entries.find(([key]) => normalized(key.replace(/-\d{8}$/, "")) === normalizedSuffix);
  return dated ? { key: dated[0], value: dated[1] } : null;
}

function tokenCost(tokens, pricePerToken) {
  return (asNumber(tokens) * asNumber(pricePerToken));
}

function costFromRateEntry(tokens, entry) {
  if (!entry || entry.input_cost_per_token == null || entry.output_cost_per_token == null) return null;
  const inputPrice = asNumber(entry.input_cost_per_token);
  const outputPrice = asNumber(entry.output_cost_per_token);
  const cacheCreatePrice = entry.cache_creation_input_token_cost == null ? inputPrice : asNumber(entry.cache_creation_input_token_cost);
  const cacheReadPrice = entry.cache_read_input_token_cost == null ? inputPrice : asNumber(entry.cache_read_input_token_cost);
  return tokenCost(tokens.input, inputPrice)
    + tokenCost(tokens.output, outputPrice)
    + tokenCost(tokens.cacheCreate, cacheCreatePrice)
    + tokenCost(tokens.cacheRead, cacheReadPrice);
}

function isPaidRateEntry(info) {
  if (!info) return false;
  const input = Number(info.input_cost_per_token);
  const output = Number(info.output_cost_per_token);
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0) return false;
  return ["cache_creation_input_token_cost", "cache_read_input_token_cost"].every((key) => {
    if (info[key] == null) return true;
    const rate = Number(info[key]);
    return Number.isFinite(rate) && rate > 0;
  });
}

function modelClass(name) {
  const id = String(name).toLowerCase();
  if (/\b(haiku|flash|mini|nano|small|lite|fast|instant|turbo)\b/.test(id)) return "fast";
  if (/\b(opus|pro|flagship|ultra|max|large)\b/.test(id)) return "premium";
  if (/\b(sonnet|glm(?:-\d+(?:\.\d+)*)?|medium|balanced|standard|gpt-[45]|gemini-\d|grok-\d|mistral)\b/.test(id)) return "standard";
  return null;
}

function contextWindow(info) {
  const value = Number(info?.max_input_tokens ?? info?.context_window ?? info?.max_tokens);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function periodFromDate(date, kind) {
  if (kind === "daily") return date;
  if (kind === "monthly") return date.slice(0, 7);
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekday + 3);
  const isoYear = day.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((day - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function flattenRegistry(registry) {
  return Object.entries(registry)
    .filter(([, info]) => info && typeof info === "object" && info.mode === "chat"
      && info.litellm_provider)
    .map(([key, info]) => ({ key, info }));
}

function modelCatalog(registry) {
  return flattenRegistry(registry).map(({ key, info }) => ({
    model: key,
    provider: String(info.litellm_provider),
    inputRate: info.input_cost_per_token == null ? null : Number(info.input_cost_per_token),
    outputRate: info.output_cost_per_token == null ? null : Number(info.output_cost_per_token),
    cacheCreateRate: info.cache_creation_input_token_cost == null ? (info.input_cost_per_token == null ? null : Number(info.input_cost_per_token)) : Number(info.cache_creation_input_token_cost),
    cacheReadRate: info.cache_read_input_token_cost == null ? (info.input_cost_per_token == null ? null : Number(info.input_cost_per_token)) : Number(info.cache_read_input_token_cost),
    contextWindow: contextWindow(info),
    modelClass: modelClass(key),
    features: Object.fromEntries(Object.entries(info).filter(([name, value]) => name.startsWith("supports_") && typeof value === "boolean")),
    paid: isPaidRateEntry(info),
  }));
}

function attachPrices(records, registry) {
  for (const record of records) {
    const match = findPriceEntry(record.model, registry);
    const cost = match ? costFromRateEntry(record, match.value) : null;
    record.priceKey = match?.key ?? null;
    record.priceProvider = match?.value?.litellm_provider ?? null;
    record.paidRate = isPaidRateEntry(match?.value);
    record.missingPrice = cost == null && record.input + record.output + record.cacheCreate + record.cacheRead > 0;
    record.listCost = cost;
    record.actualApiCost = cost;
  }
}

function aggregateModelUsage(records, kind) {
  const groups = new Map();
  for (const record of records) {
    const period = periodFromDate(record.date, kind);
    const pricingModel = record.priceKey ?? "";
    const key = `${period}\u0000${record.model}\u0000${pricingModel}`;
    if (!groups.has(key)) groups.set(key, {
      period, model: record.model, pricingModel, provider: record.priceProvider,
      input: 0, output: 0, cacheCreate: 0, cacheRead: 0, knownApiCost: 0,
      actualComplete: true, sources: new Set(),
    });
    const group = groups.get(key);
    group.input += record.input;
    group.output += record.output;
    group.cacheCreate += record.cacheCreate;
    group.cacheRead += record.cacheRead;
    group.sources.add(record.source);
    if (Number.isFinite(record.actualApiCost)) group.knownApiCost += record.actualApiCost;
    else group.actualComplete = false;
  }
  return [...groups.values()].map((group) => ({
    ...group,
    totalTokens: group.input + group.output + group.cacheCreate + group.cacheRead,
    sources: [...group.sources].sort(),
  })).sort((left, right) => left.period.localeCompare(right.period) || left.model.localeCompare(right.model));
}

function aggregate(records, kind) {
  const groups = new Map();
  for (const record of records) {
    const period = periodFromDate(record.date, kind);
    const key = `${period}\u0000${record.source}`;
    if (!groups.has(key)) {
      groups.set(key, {
        period,
        source: record.source,
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        listCost: 0,
        listComplete: true,
        actualApiCost: 0,
        actualComplete: true,
        models: new Set(),
        missingPriceModels: new Set(),
      });
    }
    const group = groups.get(key);
    group.input += record.input;
    group.output += record.output;
    group.cacheCreate += record.cacheCreate;
    group.cacheRead += record.cacheRead;
    if (Number.isFinite(record.listCost)) group.listCost += record.listCost;
    else group.listComplete = false;
    if (Number.isFinite(record.actualApiCost)) group.actualApiCost += record.actualApiCost;
    else group.actualComplete = false;
    if (record.missingPrice) group.missingPriceModels.add(record.model);
    group.models.add(record.model);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    totalTokens: group.input + group.output + group.cacheCreate + group.cacheRead,
    models: [...group.models].sort(),
    missingPriceModels: [...group.missingPriceModels].sort(),
    knownListCost: group.listCost,
    knownApiCost: group.actualApiCost,
    listCost: group.listComplete ? group.listCost : null,
    actualApiCost: group.actualComplete ? group.actualApiCost : null,
  })).sort((a, b) => a.period.localeCompare(b.period) || a.source.localeCompare(b.source));
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function buildReportHtml(payload) {
  const safePayload = jsonForHtml(payload);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mytoken — Local Report</title>
<style>
:root{color-scheme:light dark;--ink:#17221c;--muted:#6e7b72;--line:#dce4dd;--green:#1b8152;--paper:#f5f8f4;--white:#fff;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}main{max-width:1200px;margin:0 auto;padding:34px 30px 60px}.head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:23px}.brand{font-size:12px;font-weight:800;letter-spacing:.1em}.stamp{color:var(--muted);font:11px ui-monospace,monospace}.hero{padding:34px 0 23px}.eyebrow{margin:0;color:var(--green);font:11px ui-monospace,monospace;letter-spacing:.1em}.hero h1{margin:10px 0 6px;font-size:clamp(28px,4vw,44px);letter-spacing:-.04em}.hero p{max-width:760px;color:var(--muted);margin:0}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card{padding:16px 17px;background:var(--white);border:1px solid var(--line);border-radius:9px}.card span{display:block;color:var(--muted);font-size:11px}.card strong{display:block;margin-top:7px;font-size:21px;letter-spacing:-.03em}.tabs{display:flex;gap:6px;margin:30px 0 13px;overflow:auto}.tab{padding:8px 13px;border:1px solid var(--line);border-radius:7px;background:var(--white);color:var(--muted);font:600 12px system-ui;cursor:pointer;white-space:nowrap}.tab.active{border-color:#a6d8bd;background:#e9f7ef;color:#176a43}.toolbar{display:grid;grid-template-columns:minmax(180px,2fr) repeat(4,minmax(120px,1fr));gap:8px;margin:0 0 13px}.toolbar input,.toolbar select{min-height:40px;min-width:0;padding:9px 11px;border:1px solid var(--line);border-radius:7px;background:var(--white);color:var(--ink);font:12px system-ui}.panel{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:var(--white);overflow:hidden}.panel h2{margin:0;padding:17px 18px;border-bottom:1px solid var(--line);font-size:15px}.panel-copy{margin:0;padding:0 18px 13px;color:var(--muted);font-size:11px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px}th,td{padding:11px 13px;border-bottom:1px solid #edf0ed;text-align:left;vertical-align:top;font-size:11px}th{position:sticky;top:0;background:#f8faf8;color:#68756d;font:10px ui-monospace,monospace;letter-spacing:.04em}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.models{min-width:220px;color:#6c7971;max-width:330px;overflow-wrap:anywhere}.pagination{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:10px 14px;color:var(--muted);font-size:11px}.pagination button{padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--white);color:var(--ink);cursor:pointer}.pagination button:disabled{opacity:.45;cursor:default}.chart{display:grid;gap:11px;padding:4px 18px 18px}.bar-row{display:grid;grid-template-columns:minmax(145px,1.15fr) minmax(100px,2fr);align-items:center;gap:12px}.bar-label{display:flex;justify-content:space-between;gap:8px;min-width:0;font-size:11px}.bar-label strong{overflow:hidden;text-overflow:ellipsis;white-space:normal}.bar-label small{display:block;color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis}.bar-label span{color:var(--muted);white-space:nowrap}.bar-track{height:12px;border-radius:99px;background:var(--paper);overflow:hidden}.bar-track i{display:block;height:100%;min-width:2px;border-radius:99px;background:var(--green)}.empty{padding:16px 18px;color:var(--muted);font-size:12px}.notes{margin-top:20px;padding:16px 18px;border:1px solid var(--line);border-radius:9px;background:#fbfcfb;color:var(--muted);font-size:11px}.notes strong{color:#33443a}.notes ul{margin:8px 0 0;padding-left:17px}.foot{display:flex;justify-content:space-between;gap:15px;margin-top:20px;color:#87928a;font:10px ui-monospace,monospace}a{color:var(--green)}@media(max-width:760px){main{padding:22px 15px 40px}.cards{grid-template-columns:repeat(2,1fr)}.head{align-items:flex-start;gap:10px;flex-direction:column}.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}.bar-row{grid-template-columns:1fr;gap:5px}.bar-label{justify-content:flex-start;gap:12px}.foot{flex-direction:column}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--ink:#e5eee8;--muted:#9caaa1;--line:#2d3b32;--green:#61d89d;--paper:#111914;--white:#19241d}.tab.active{border-color:#315740;background:#20372a;color:#a1e6bb}th{background:#18221b;color:#b3c0b7}th,td{border-bottom-color:#28352d}td.models{color:#a0ada4}.notes{background:#151e18}.notes strong{color:#d9e5dd}.foot{color:#9aa79f}}</style></head><body><main>
<header class="head"><div class="brand">MYTOKEN / LOCAL REPORT</div><div class="stamp">Generated <span id="generated"></span></div></header>
<section class="hero"><p class="eyebrow">PRIVATE ON THIS DEVICE</p><h1>Your token usage, repriced.</h1><p>This report is assembled and saved locally. mytoken does not receive your usage records or include them in analytics. If you confirm the optional tokenmaxxing sync prompt, its CLI uploads the daily aggregates it normally syncs to your public tokenmaxxing.sh profile; the report may then import that public history. The analyzer fetches public API prices. Contacted services may receive ordinary connection metadata, such as your IP address.</p></section>
<section class="cards" id="cards"></section>
<nav class="tabs" aria-label="Report period" id="tabs"></nav>
<div class="toolbar" aria-label="Report controls"><input id="search" type="search" placeholder="Search periods, sources, models, or providers"><select id="source-filter" aria-label="Filter usage by source"><option value="">All sources</option></select><select id="provider-filter" aria-label="Filter comparisons by provider"><option value="">All providers</option></select><input id="model-filter" type="search" placeholder="Find a model (e.g. Claude Opus)" aria-label="Filter comparison models"><select id="sort-order" aria-label="Sort report rows"><option value="period-desc">Newest period</option><option value="period-asc">Oldest period</option><option value="cost-asc">Lowest API cost</option><option value="cost-desc">Highest API cost</option><option value="tokens-desc">Most tokens</option><option value="source-asc">Source A–Z</option></select></div>
<section class="panel"><h2>Usage by ccusage source</h2><div class="table-wrap" id="usage-table"></div></section>
<section class="panel"><h2>Usage by model</h2><p class="panel-copy">Choose a model row to compare only paid alternatives in the same model class, with matching recorded capabilities and a context window within 100,000 tokens.</p><div class="table-wrap" id="model-usage-table"></div></section>
<section class="panel"><h2>Cheaper comparable paid models</h2><div class="comparison-controls" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 18px 12px;flex-wrap:wrap"><p class="panel-copy" id="compare-copy"></p><label style="font-size:11px">Sort <select id="compare-sort" aria-label="Sort comparable models"><option value="cost-asc">Lowest cost</option><option value="savings-desc">Most saved</option><option value="context-asc">Closest context</option><option value="provider-asc">Provider A–Z</option><option value="model-asc">Model A–Z</option><option value="cost-desc">Highest cost</option></select></label></div><div class="table-wrap" id="comparison-table"></div></section>
<section class="notes"><strong>Reading this estimate</strong><ul id="notes"></ul></section>
<footer class="foot"><span>ccusage aggregates every source supported by the installed version.</span><span>History: <a href="https://tokenmaxxing.sh/">tokenmaxxing.sh</a></span><span>Pricing metadata: <a href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json">LiteLLM</a></span></footer>
</main><script type="application/json" id="ledger-data">${safePayload}</script>
<script>
const data=JSON.parse(document.getElementById('ledger-data').textContent);let active='monthly';let selectedModelKey='';let selectedModelPeriod='';const pages={usage:1,models:1,comparison:1};const pageSize=25;
const fmtInt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(n||0);
const fmtMoney=n=>{const value=Number(n||0);if(value>0&&value<0.01){const exact=value.toFixed(12).replace(/0+$/,'').replace(/\.$/,'');return exact==='0'?'<$0.000000000001':'$'+exact;}return '$'+value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});};
const fmtEstimate=(known,complete)=>complete?(known===0?'Listed $0':fmtMoney(known)):known>0?fmtMoney(known)+'+':'No public rate';
const fmtShort=n=>{const value=Number(n||0);if(value>=1e9)return (value/1e9).toFixed(1).replace(/\.0$/,'')+'B';if(value>=1e6)return (value/1e6).toFixed(1).replace(/\.0$/,'')+'M';if(value>=1e3)return (value/1e3).toFixed(1).replace(/\.0$/,'')+'K';return fmtInt(value);};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const modelRegistry=data.modelCatalog||[];
document.getElementById('generated').textContent=new Date(data.generatedAt).toLocaleString();
document.getElementById('cards').innerHTML=[['TOTAL TOKENS',fmtInt(data.summary.totalTokens)],['INPUT',fmtInt(data.summary.input)],['OUTPUT',fmtInt(data.summary.output)],['ESTIMATED API COST',fmtEstimate(data.summary.estimatedApiCost,data.summary.estimateComplete)]].map(([label,value])=>'<div class="card"><span>'+label+'</span><strong>'+value+'</strong></div>').join('');
const labels={daily:'Day',weekly:'Week',monthly:'Month'};
document.getElementById('tabs').innerHTML=Object.keys(labels).map(key=>'<button class="tab '+(active===key?'active':'')+'" data-period="'+key+'">'+labels[key]+'</button>').join('');
document.getElementById('tabs').addEventListener('click',event=>{const key=event.target.dataset.period;if(!key)return;active=key;Object.keys(pages).forEach(key=>pages[key]=1);selectedModelKey='';selectedModelPeriod='';document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.period===active));render();});
const sourceNames=[...new Set(Object.values(data.periods).flat().map(row=>row.source))].sort();
const providerNames=[...new Set(modelRegistry.filter(model=>model.paid).map(model=>model.provider))].sort();
document.getElementById('source-filter').insertAdjacentHTML('beforeend',sourceNames.map(name=>'<option value="'+esc(name)+'">'+esc(name)+'</option>').join(''));
document.getElementById('provider-filter').insertAdjacentHTML('beforeend',providerNames.map(name=>'<option value="'+esc(name)+'">'+esc(name)+'</option>').join(''));
['search','source-filter','provider-filter','model-filter','sort-order'].forEach(id=>document.getElementById(id).addEventListener(id==='search'||id==='model-filter'?'input':'change',()=>{Object.keys(pages).forEach(key=>pages[key]=1);render();}));
document.getElementById('compare-sort').addEventListener('change',()=>{pages.comparison=1;render();});
function table(headings,rows){return '<table><thead><tr>'+headings.map(head=>'<th>'+head+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table>';}
function paginated(rows,headings,rowHtml,pageKey){const totalPages=Math.max(1,Math.ceil(rows.length/pageSize));pages[pageKey]=Math.min(pages[pageKey],totalPages);const page=pages[pageKey];const visible=rows.slice((page-1)*pageSize,page*pageSize);return (visible.length?table(headings,visible.map(rowHtml).join('')):'<div class="empty">No rows match these filters.</div>')+(rows.length>pageSize?'<div class="pagination"><button data-page="'+pageKey+'" data-step="-1" '+(page===1?'disabled':'')+'>Previous</button><span>Page '+page+' of '+totalPages+' · '+fmtInt(rows.length)+' rows · '+pageSize+'/page</span><button data-page="'+pageKey+'" data-step="1" '+(page===totalPages?'disabled':'')+'>Next</button></div>':'');}
document.addEventListener('click',event=>{const select=event.target.closest('[data-model-key]');if(select){selectedModelKey=select.dataset.modelKey;selectedModelPeriod=select.dataset.period;pages.comparison=1;render();return;}const button=event.target.closest('[data-page]');if(!button||button.disabled)return;const key=button.dataset.page;pages[key]=Math.max(1,pages[key]+Number(button.dataset.step));render();});
function render(){
 const query=document.getElementById('search').value.trim().toLowerCase();
 const sourceFilter=document.getElementById('source-filter').value;
 const providerFilter=document.getElementById('provider-filter').value;
 const modelQuery=document.getElementById('model-filter').value.trim().toLowerCase();
 const sort=document.getElementById('sort-order').value;
 const matches=value=>!query||String(value).toLowerCase().includes(query);
 const comparePeriod=(a,b)=>sort==='period-asc'?a.period.localeCompare(b.period):b.period.localeCompare(a.period);
 const sortUsage=rows=>rows.sort((a,b)=>{
  if(sort==='period-asc'||sort==='period-desc')return comparePeriod(a,b);
  if(sort==='source-asc')return a.source.localeCompare(b.source)||a.period.localeCompare(b.period);
  if(sort==='tokens-desc')return b.totalTokens-a.totalTokens;
  const left=a.actualApiCost,right=b.actualApiCost;if(left==null)return 1;if(right==null)return -1;
  return sort==='cost-asc'?left-right:right-left;
 });
 const rows=sortUsage((data.periods[active]||[]).filter(row=>(!sourceFilter||row.source===sourceFilter)&&matches(row.period+' '+row.source+' '+row.models.join(' '))));
 document.getElementById('usage-table').innerHTML=paginated(rows,['Period','Source','Models','Input','Output','Cache write','Cache read','API equivalent','Estimated API cost'],row=>'<tr><td>'+esc(row.period)+'</td><td>'+esc(row.source)+'</td><td class="models">'+esc(row.models.join(', '))+'</td><td class="num">'+fmtInt(row.input)+'</td><td class="num">'+fmtInt(row.output)+'</td><td class="num">'+fmtInt(row.cacheCreate)+'</td><td class="num">'+fmtInt(row.cacheRead)+'</td><td class="num">'+fmtEstimate(row.knownListCost,row.listComplete)+'</td><td class="num">'+fmtEstimate(row.knownApiCost,row.actualComplete)+'</td></tr>','usage');
 const sourceModelRows=(data.models[active]||[]).filter(row=>(!sourceFilter||row.sources.includes(sourceFilter))&&matches(row.period+' '+row.model+' '+row.provider+' '+row.sources.join(' ')));
 sourceModelRows.sort((a,b)=>sort==='period-asc'?a.period.localeCompare(b.period):sort==='period-desc'?b.period.localeCompare(a.period):sort==='tokens-desc'?b.totalTokens-a.totalTokens:sort==='source-asc'?a.model.localeCompare(b.model):sort==='cost-desc'?b.knownApiCost-a.knownApiCost:a.knownApiCost-b.knownApiCost);
 const paidReferenceRows=sourceModelRows.filter(row=>{const info=modelRegistry.find(model=>model.model===row.pricingModel);return info&&info.paid&&info.modelClass&&info.contextWindow&&Object.keys(info.features).length>0;});
 let selectedRow=sourceModelRows.find(row=>row.pricingModel===selectedModelKey&&row.period===selectedModelPeriod);
 if(!selectedRow)selectedRow=(paidReferenceRows.length?paidReferenceRows:sourceModelRows).slice().sort((a,b)=>b.totalTokens-a.totalTokens)[0]||null;
 if(selectedRow){selectedModelKey=selectedRow.pricingModel;selectedModelPeriod=selectedRow.period;}else{selectedModelKey='';selectedModelPeriod='';}
 document.getElementById('model-usage-table').innerHTML=paginated(sourceModelRows,['Period','Used model','Provider','Input','Output','Cache write','Cache read','Total tokens','Estimated API cost','Compare'],row=>{const selected=row===selectedRow;return '<tr><td>'+esc(row.period)+'</td><td class="models">'+esc(row.model)+'</td><td>'+esc(row.provider||'—')+'</td><td class="num">'+fmtInt(row.input)+'</td><td class="num">'+fmtInt(row.output)+'</td><td class="num">'+fmtInt(row.cacheCreate)+'</td><td class="num">'+fmtInt(row.cacheRead)+'</td><td class="num">'+fmtInt(row.totalTokens)+'</td><td class="num">'+fmtEstimate(row.knownApiCost,row.actualComplete)+'</td><td><button type="button" data-model-key="'+esc(row.pricingModel)+'" data-period="'+esc(row.period)+'">'+(selected?'Selected':'Compare')+'</button></td></tr>';},'models');
 const rateCost=(model,workload)=>workload.input*model.inputRate+workload.output*model.outputRate+workload.cacheCreate*model.cacheCreateRate+workload.cacheRead*model.cacheReadRate;
 let alternatives=[];let baselineCost=null;let sourceInfo=null;
 if(selectedRow)sourceInfo=modelRegistry.find(model=>model.model===selectedRow.pricingModel)||null;
 if(sourceInfo&&sourceInfo.paid)baselineCost=rateCost(sourceInfo,selectedRow);
 const sourceFeatures=sourceInfo?Object.keys(sourceInfo.features):[];
 const comparable=sourceInfo&&sourceInfo.paid&&sourceInfo.modelClass&&sourceInfo.contextWindow&&sourceFeatures.length>0;
 if(comparable&&baselineCost>0)alternatives=modelRegistry.filter(model=>model.paid&&model.model!==sourceInfo.model&&model.modelClass===sourceInfo.modelClass&&model.contextWindow&&Math.abs(model.contextWindow-sourceInfo.contextWindow)<=100000&&sourceFeatures.every(feature=>model.features[feature]===sourceInfo.features[feature])&&(!providerFilter||model.provider===providerFilter)&&(!modelQuery||model.model.toLowerCase().includes(modelQuery)||model.provider.toLowerCase().includes(modelQuery))).map(model=>{const cost=rateCost(model,selectedRow);return {...model,cost,savings:baselineCost-cost,contextDelta:model.contextWindow-sourceInfo.contextWindow,sameSpendTokens:cost>0?selectedRow.totalTokens*baselineCost/cost:null};}).filter(model=>model.cost>0&&model.cost<baselineCost);
 const compareSort=document.getElementById('compare-sort').value;
 alternatives.sort((a,b)=>compareSort==='savings-desc'?b.savings-a.savings:compareSort==='context-asc'?Math.abs(a.contextDelta)-Math.abs(b.contextDelta):compareSort==='provider-asc'?a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model):compareSort==='model-asc'?a.model.localeCompare(b.model):compareSort==='cost-desc'?b.cost-a.cost:a.cost-b.cost);
 const contextLabel=sourceInfo&&sourceInfo.contextWindow?fmtInt(sourceInfo.contextWindow)+' context':'context unknown';
 const classLabel=sourceInfo&&sourceInfo.modelClass?sourceInfo.modelClass+' class':'class unknown';
 const featureLabel=features=>Object.entries(features||{}).map(([name,value])=>name.replace(/^supports_/,'').replace(/_/g,' ')+': '+(value?'yes':'no')).join(', ')||'No capability metadata';
 document.getElementById('compare-copy').textContent=!selectedRow?'No usage model is available in this period.':!sourceInfo?'No public price/model metadata is available for '+selectedRow.model+'.':!sourceInfo.paid?'The used model has no positive public input, output, and cache rates; it is excluded from paid comparisons.':!sourceInfo.modelClass||!sourceInfo.contextWindow||!sourceFeatures.length?'Cannot assess like-for-like alternatives: the used model lacks class, context, or feature metadata.':'Used '+selectedRow.model+' · '+classLabel+' · '+contextLabel+' · '+fmtShort(selectedRow.totalTokens)+' tokens · baseline '+fmtMoney(baselineCost)+' · features: '+featureLabel(sourceInfo.features)+'. Alternatives match these recorded feature flags, stay within ±100,000 context tokens, and cost less.';
 document.getElementById('comparison-table').innerHTML=paginated(alternatives,['Model','Provider','Class','Context','Recorded features','Cost at same usage','Tokens for same spend','Savings'],model=>'<tr><td class="models">'+esc(model.model)+'</td><td>'+esc(model.provider)+'</td><td>'+esc(model.modelClass)+'</td><td class="num">'+fmtInt(model.contextWindow)+' ('+(model.contextDelta>=0?'+':'')+fmtInt(model.contextDelta)+')</td><td>'+esc(featureLabel(model.features))+'</td><td class="num">'+fmtMoney(model.cost)+'</td><td class="num">'+fmtShort(model.sameSpendTokens)+'</td><td class="num">'+fmtMoney(model.savings)+'</td></tr>','comparison');
 if(selectedRow&&comparable&&baselineCost>0&&!alternatives.length)document.getElementById('comparison-table').innerHTML='<div class="empty">No cheaper paid model matches the same class, recorded features, and ±100,000 token context window for this usage.</div>';
}
document.getElementById('notes').innerHTML=data.notes.map(note=>'<li>'+esc(note)+'</li>').join('');render();
</script></body></html>`;
}

function openInBrowser(path) {
  let result;
  if (process.platform === "darwin") result = run("open", [path]);
  else if (process.platform === "win32") result = run("cmd.exe", ["/d", "/s", "/c", `start \"\" \"${path}\"`]);
  else result = run("xdg-open", [path]);
  return !result.error && result.status === 0;
}

async function main() {
  console.log("\nmytoken — local usage and cost comparison\n");
  console.log("[1/5] Reading local usage from ccusage. Usage data stays on this device.");
  const rawUsage = runCcusage(["daily", "--json", "--breakdown", "--by-agent", "--sections", "weekly,monthly", "--no-cost"]);
  let records = parseUsage(parseJsonOutput(rawUsage));
  if (!records.length) throw new Error("ccusage found no daily model usage on this computer.");

  let tokenmaxxingLogin = tokenmaxxingIdentity();
  let tokenmaxxingRows = [];
  let tokenmaxxingSyncRequested = false;
  let tokenmaxxingImportedCount = 0;
  let tokenmaxxingHistoryLoaded = false;
  if (tokenmaxxingLogin) {
    if (await askTokenmaxxingSync(tokenmaxxingLogin)) {
      tokenmaxxingSyncRequested = true;
      console.log("\nSyncing local usage to tokenmaxxing.sh...");
      const sync = run("tokenmaxxing", ["sync"]);
      if (sync.stdout) console.log(sync.stdout.trim());
      if (sync.error || sync.status !== 0) console.log(`tokenmaxxing sync did not complete: ${sync.stderr?.trim() || sync.error?.message || `exit ${sync.status}`}`);
    }
    try {
      tokenmaxxingRows = await importTokenmaxxingHistory(tokenmaxxingLogin);
      tokenmaxxingHistoryLoaded = true;
      const firstLocalDate = records.map((record) => record.date).sort()[0];
      const earlierHistory = tokenmaxxingRows.filter((record) => record.date < firstLocalDate);
      records.push(...earlierHistory);
      tokenmaxxingImportedCount = earlierHistory.length;
      console.log(`Imported ${earlierHistory.length.toLocaleString()} older daily model rows from tokenmaxxing.sh (${tokenmaxxingLogin}); overlapping dates were skipped to prevent double-counting.`);
    } catch (error) {
      console.log(`tokenmaxxing.sh history could not be imported: ${error.message}`);
    }
  }
  const detectedSources = [...new Set(records.map((record) => record.source))].sort();
  console.log(`[1/5] Complete — loaded ${records.length.toLocaleString()} daily source/model rows from ${detectedSources.length} detected sources: ${detectedSources.join(", ")}.`);

  let registry = {};
  let pricingUpdated = false;
  try {
    console.log("[2/5] Fetching the live API price registry...");
    registry = await loadPriceRegistry();
    pricingUpdated = true;
    console.log(`[2/5] Complete — loaded ${Object.keys(registry).length.toLocaleString()} model price entries from LiteLLM.`);
  } catch (error) {
    console.log(`[2/5] Live model pricing could not be loaded: ${error.message}`);
  }

  attachPrices(records, registry);
  console.log("[3/5] Applying public API rates to the detected models...");

  const catalog = modelCatalog(registry);
  const kinds = ["daily", "weekly", "monthly"];
  console.log("[5/5] Building daily, weekly, and monthly report tables...");
  const periods = Object.fromEntries(kinds.map((kind) => [kind, aggregate(records, kind)]));
  const modelPeriods = Object.fromEntries(kinds.map((kind) => [kind, aggregateModelUsage(records, kind)]));
  const usageOnly = records;
  const totalTokens = usageOnly.reduce((sum, record) => sum + record.input + record.output + record.cacheCreate + record.cacheRead, 0);
  const totalInput = usageOnly.reduce((sum, record) => sum + record.input, 0);
  const totalOutput = usageOnly.reduce((sum, record) => sum + record.output, 0);
  const missingPriceModels = [...new Set(usageOnly.filter((record) => record.missingPrice).map((record) => record.model))];
  const estimatedApiCost = usageOnly.reduce((sum, record) => sum + (Number.isFinite(record.actualApiCost) ? record.actualApiCost : 0), 0);
  const estimateComplete = usageOnly.every((record) => Number.isFinite(record.actualApiCost));
  const notes = [
    "Local input, output, cache-write, and cache-read counts come from ccusage daily JSON. Week totals use ccusage's default Monday start; month totals follow calendar months. Only ccusage-supported daily, weekly, and monthly views are shown.",
    pricingUpdated ? "API rates were refreshed from LiteLLM at run time. Model tier, region, prompt length, peak-hour, batch, and provider-specific discounts may change real invoices." : "Live pricing could not be loaded; models without a public rate are excluded from API totals.",
    "No subscription, allowance, or top-up fees are included. Every total is an API-price comparison only.",
    "Usage records are not uploaded to mytoken or included in analytics. Syncing to tokenmaxxing.sh is optional and only runs after confirmation; public profile history may be imported into this local report. The analyzer fetches public pricing. Contacted services may receive ordinary connection metadata such as your IP address.",
    "Paid alternatives are shown only when positive input, output, and listed cache rates are available. Unrated and zero-priced models remain visible in usage by model but are excluded from paid comparisons.",
    "Alternatives are limited to the same name-derived tier class, identical recorded supports_* capability flags, and a listed input context within 100,000 tokens of the used model. Missing class, feature, or context metadata makes a model ineligible; this is a registry-based compatibility filter, not a quality benchmark.",
    ...(tokenmaxxingImportedCount ? [`Imported ${tokenmaxxingImportedCount} older daily model rows from public tokenmaxxing.sh profile ${tokenmaxxingLogin}. Only dates before this computer’s earliest local date were added to avoid double-counting. The public history has total/output tokens but no input/cache breakdown; imported input is estimated as total minus output and repriced using current rates.`] : []),
    ...(tokenmaxxingHistoryLoaded && !tokenmaxxingImportedCount ? [`Checked the authenticated tokenmaxxing.sh profile ${tokenmaxxingLogin}; it had no dates older than this computer’s local ccusage history to add.`] : []),
    ...(missingPriceModels.length ? [`No public API rate was listed for: ${missingPriceModels.join(", ")}. Those rows say “No public rate” and are excluded from totals.`] : []),
    `Sources currently listed by ccusage: ${SUPPORTED_SOURCES_URL}. Newly supported sources are included after ccusage updates.`,
  ];
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceCount: new Set(usageOnly.map((record) => record.source)).size,
    summary: { totalTokens, input: totalInput, output: totalOutput, estimatedApiCost, estimateComplete },
    periods,
    models: modelPeriods,
    modelCatalog: catalog,
    notes,
  };
  const reportPath = join(tmpdir(), `mytoken-report-${Date.now()}.html`);
  await writeFile(reportPath, buildReportHtml(payload), { encoding: "utf8", mode: 0o600 });
  console.log("[5/5] Complete — local report is ready.");
  console.log(`\nReport saved locally to: ${reportPath}`);
  if (openInBrowser(reportPath)) console.log("Opened the local report in your browser.");
  else console.log("Could not open a browser automatically. Open the local HTML path above.");
  console.log(tokenmaxxingSyncRequested
    ? "\nFinished. mytoken received no usage records. The tokenmaxxing sync ran only after your confirmation; no prompts, session details, or credentials are included in this report."
    : "\nFinished. No ccusage logs, tokens, or session details were uploaded.");
}

try {
  await main();
} catch (error) {
  console.error(`\nmytoken stopped: ${error.message}`);
  process.exitCode = 1;
}
