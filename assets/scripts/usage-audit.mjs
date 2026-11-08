import { spawnSync } from "node:child_process";
import { stderr } from "node:process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRICE_REGISTRY_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const SUPPORTED_SOURCES_URL = "https://ccusage.com/guide/all-reports";

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
      && info.litellm_provider && info.input_cost_per_token != null && info.output_cost_per_token != null)
    .map(([key, info]) => ({ key, info }));
}

function workloadTotals(records) {
  return records.reduce((totals, record) => {
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheCreate += record.cacheCreate;
    totals.cacheRead += record.cacheRead;
    return totals;
  }, { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
}

function bestModelForProvider(provider, entries, workload) {
  let best = null;
  for (const entry of entries.filter((candidate) => String(candidate.info.litellm_provider).toLowerCase() === provider.toLowerCase())) {
    const cost = costFromRateEntry(workload, entry.info);
    if (cost == null) continue;
    if (!best || cost < best.cost) best = { key: entry.key, info: entry.info, cost };
  }
  return best;
}

function chooseComparisons(registry, records) {
  const entries = flattenRegistry(registry);
  const providers = [...new Set(entries.map((entry) => String(entry.info.litellm_provider).toLowerCase()))].sort();
  if (!providers.length) {
    console.log("[4/5] No providers with priced chat models were available to compare.");
    return [];
  }
  const workload = workloadTotals(records);
  const comparisons = [];
  const progressWidth = 22;
  if (stderr.isTTY) {
    stderr.write(`[4/5] Comparing every priced provider: 0/${providers.length} [${" ".repeat(progressWidth)}]`);
  } else {
    console.log(`[4/5] Comparing every priced provider (${providers.length})...`);
  }
  for (const [index, provider] of providers.entries()) {
    const model = bestModelForProvider(provider, entries, workload);
    if (model) comparisons.push(model);
    if (stderr.isTTY) {
      const completed = index + 1;
      const filled = Math.round((completed / providers.length) * progressWidth);
      const bar = `${"=".repeat(filled)}${".".repeat(progressWidth - filled)}`;
      stderr.write(`\r[4/5] Comparing every priced provider: ${completed}/${providers.length} [${bar}]`);
    }
  }
  comparisons.sort((left, right) => left.cost - right.cost || left.info.litellm_provider.localeCompare(right.info.litellm_provider));
  const skipped = providers.length - comparisons.length;
  const completion = `[4/5] Compared ${comparisons.length} priced providers${skipped ? `; skipped ${skipped} without a usable model` : ""}.`;
  if (stderr.isTTY) stderr.write(`\r${completion}${" ".repeat(progressWidth + 32)}\n`);
  else console.log(completion);
  return comparisons;
}

function attachPrices(records, registry) {
  for (const record of records) {
    const match = findPriceEntry(record.model, registry);
    const cost = match ? costFromRateEntry(record, match.value) : null;
    record.priceKey = match?.key ?? null;
    record.priceProvider = match?.value?.litellm_provider ?? null;
    record.missingPrice = cost == null && record.input + record.output + record.cacheCreate + record.cacheRead > 0;
    record.listCost = cost ?? 0;
    record.actualApiCost = cost ?? 0;
  }
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
        actualApiCost: 0,
        models: new Set(),
        missingPriceModels: new Set(),
      });
    }
    const group = groups.get(key);
    group.input += record.input;
    group.output += record.output;
    group.cacheCreate += record.cacheCreate;
    group.cacheRead += record.cacheRead;
    group.listCost += record.listCost ?? 0;
    group.actualApiCost += record.actualApiCost ?? 0;
    if (record.missingPrice) group.missingPriceModels.add(record.model);
    group.models.add(record.model);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    totalTokens: group.input + group.output + group.cacheCreate + group.cacheRead,
    models: [...group.models].sort(),
    missingPriceModels: [...group.missingPriceModels].sort(),
  })).sort((a, b) => a.period.localeCompare(b.period) || a.source.localeCompare(b.source));
}

function aggregateComparisons(records, kind, models) {
  const periods = new Map();
  for (const record of records) {
    const period = periodFromDate(record.date, kind);
    if (!periods.has(period)) periods.set(period, { period, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    const entry = periods.get(period);
    entry.input += record.input;
    entry.output += record.output;
    entry.cacheCreate += record.cacheCreate;
    entry.cacheRead += record.cacheRead;
  }
  return [...periods.values()].map((entry) => {
    const original = records.filter((record) => periodFromDate(record.date, kind) === entry.period);
    const originalCost = original.reduce((sum, record) => sum + (record.listCost ?? 0), 0);
    const comparisonCosts = models.map((model) => ({
      model: model.key,
      provider: model.info.litellm_provider,
      cost: costFromRateEntry(entry, model.info),
      ratio: originalCost && originalCost > 0 ? costFromRateEntry(entry, model.info) / originalCost : null,
    }));
    return { period: entry.period, input: entry.input, output: entry.output, cacheCreate: entry.cacheCreate, cacheRead: entry.cacheRead, originalCost, comparisons: comparisonCosts };
  }).sort((a, b) => a.period.localeCompare(b.period));
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function buildReportHtml(payload) {
  const safePayload = jsonForHtml(payload);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mytoken — Local Report</title>
<style>
:root{color-scheme:light dark;--ink:#17221c;--muted:#6e7b72;--line:#dce4dd;--green:#1b8152;--paper:#f5f8f4;--white:#fff;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}main{max-width:1200px;margin:0 auto;padding:34px 30px 60px}.head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:23px}.brand{font-size:12px;font-weight:800;letter-spacing:.1em}.stamp{color:var(--muted);font:11px ui-monospace,monospace}.hero{padding:34px 0 23px}.eyebrow{margin:0;color:var(--green);font:11px ui-monospace,monospace;letter-spacing:.1em}.hero h1{margin:10px 0 6px;font-size:clamp(28px,4vw,44px);letter-spacing:-.04em}.hero p{max-width:760px;color:var(--muted);margin:0}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card{padding:16px 17px;background:var(--white);border:1px solid var(--line);border-radius:9px}.card span{display:block;color:var(--muted);font-size:11px}.card strong{display:block;margin-top:7px;font-size:21px;letter-spacing:-.03em}.tabs{display:flex;gap:6px;margin:30px 0 13px;overflow:auto}.tab{padding:8px 13px;border:1px solid var(--line);border-radius:7px;background:var(--white);color:var(--muted);font:600 12px system-ui;cursor:pointer;white-space:nowrap}.tab.active{border-color:#a6d8bd;background:#e9f7ef;color:#176a43}.toolbar{display:grid;grid-template-columns:minmax(200px,2fr) repeat(3,minmax(140px,1fr));gap:8px;margin:0 0 13px}.toolbar input,.toolbar select{min-height:40px;min-width:0;padding:9px 11px;border:1px solid var(--line);border-radius:7px;background:var(--white);color:var(--ink);font:12px system-ui}.panel{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:var(--white);overflow:hidden}.panel h2{margin:0;padding:17px 18px;border-bottom:1px solid var(--line);font-size:15px}.panel-copy{margin:0;padding:0 18px 13px;color:var(--muted);font-size:11px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px}th,td{padding:11px 13px;border-bottom:1px solid #edf0ed;text-align:left;vertical-align:top;font-size:11px}th{position:sticky;top:0;background:#f8faf8;color:#68756d;font:10px ui-monospace,monospace;letter-spacing:.04em}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.models{min-width:220px;color:#6c7971;max-width:330px;overflow-wrap:anywhere}.chart{display:grid;gap:11px;padding:4px 18px 18px}.bar-row{display:grid;grid-template-columns:minmax(145px,1.15fr) minmax(100px,2fr);align-items:center;gap:12px}.bar-label{display:flex;justify-content:space-between;gap:8px;min-width:0;font-size:11px}.bar-label strong{overflow:hidden;text-overflow:ellipsis;white-space:normal}.bar-label small{display:block;color:var(--muted);font-weight:400;overflow:hidden;text-overflow:ellipsis}.bar-label span{color:var(--muted);white-space:nowrap}.bar-track{height:12px;border-radius:99px;background:var(--paper);overflow:hidden}.bar-track i{display:block;height:100%;min-width:2px;border-radius:99px;background:var(--green)}.empty{padding:16px 18px;color:var(--muted);font-size:12px}.notes{margin-top:20px;padding:16px 18px;border:1px solid var(--line);border-radius:9px;background:#fbfcfb;color:var(--muted);font-size:11px}.notes strong{color:#33443a}.notes ul{margin:8px 0 0;padding-left:17px}.foot{display:flex;justify-content:space-between;gap:15px;margin-top:20px;color:#87928a;font:10px ui-monospace,monospace}a{color:var(--green)}@media(max-width:760px){main{padding:22px 15px 40px}.cards{grid-template-columns:repeat(2,1fr)}.head{align-items:flex-start;gap:10px;flex-direction:column}.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}.bar-row{grid-template-columns:1fr;gap:5px}.bar-label{justify-content:flex-start;gap:12px}.foot{flex-direction:column}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--ink:#e5eee8;--muted:#9caaa1;--line:#2d3b32;--green:#61d89d;--paper:#111914;--white:#19241d}.tab.active{border-color:#315740;background:#20372a;color:#a1e6bb}th{background:#18221b;color:#b3c0b7}th,td{border-bottom-color:#28352d}td.models{color:#a0ada4}.notes{background:#151e18}.notes strong{color:#d9e5dd}.foot{color:#9aa79f}}</style></head><body><main>
<header class="head"><div class="brand">MYTOKEN / LOCAL REPORT</div><div class="stamp">Generated <span id="generated"></span></div></header>
<section class="hero"><p class="eyebrow">PRIVATE ON THIS DEVICE</p><h1>Your token usage, repriced.</h1><p>This report was assembled from local ccusage JSON and current public API price data. Usage records stay on this device. The analyzer writes the report locally and does not upload records to mytoken or include them in anonymous analytics. The launcher downloads ccusage; the analyzer fetches public API prices. The site host and contacted services may receive ordinary connection metadata, such as your IP address.</p></section>
<section class="cards" id="cards"></section>
<nav class="tabs" aria-label="Report period" id="tabs"></nav>
<section class="panel"><h2>Top 10 lowest API equivalents</h2><p class="panel-copy">Providers use their lowest priced chat model for the visible token mix. This compares price, not model quality.</p><div class="chart" id="top-chart"></div></section>
<div class="toolbar" aria-label="Report controls"><input id="search" type="search" placeholder="Search periods, sources, models, or providers"><select id="source-filter" aria-label="Filter usage by source"><option value="">All sources</option></select><select id="provider-filter" aria-label="Filter comparisons by provider"><option value="">All providers</option></select><select id="sort-order" aria-label="Sort report rows"><option value="period-desc">Newest period</option><option value="period-asc">Oldest period</option><option value="cost-asc">Lowest API cost</option><option value="cost-desc">Highest API cost</option><option value="tokens-desc">Most tokens</option><option value="source-asc">Source A–Z</option></select></div>
<section class="panel"><h2>Usage by ccusage source</h2><div class="table-wrap" id="usage-table"></div></section>
<section class="panel"><h2>Same token mix at other API models</h2><div class="table-wrap" id="comparison-table"></div></section>
<section class="notes"><strong>Reading this estimate</strong><ul id="notes"></ul></section>
<footer class="foot"><span>ccusage aggregates every source supported by the installed version.</span><span>Pricing metadata: <a href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json">LiteLLM</a></span></footer>
</main><script type="application/json" id="ledger-data">${safePayload}</script>
<script>
const data=JSON.parse(document.getElementById('ledger-data').textContent);let active='monthly';
const fmtInt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(n||0);
const fmtMoney=n=>'$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.getElementById('generated').textContent=new Date(data.generatedAt).toLocaleString();
document.getElementById('cards').innerHTML=[['TOTAL TOKENS',fmtInt(data.summary.totalTokens)],['INPUT',fmtInt(data.summary.input)],['OUTPUT',fmtInt(data.summary.output)],['ESTIMATED API COST',fmtMoney(data.summary.estimatedApiCost)]].map(([label,value])=>'<div class="card"><span>'+label+'</span><strong>'+value+'</strong></div>').join('');
const labels={daily:'Day',weekly:'Week',monthly:'Month'};
document.getElementById('tabs').innerHTML=Object.keys(labels).map(key=>'<button class="tab '+(active===key?'active':'')+'" data-period="'+key+'">'+labels[key]+'</button>').join('');
document.getElementById('tabs').addEventListener('click',event=>{const key=event.target.dataset.period;if(!key)return;active=key;document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.period===active));render();});
const sourceNames=[...new Set(Object.values(data.periods).flat().map(row=>row.source))].sort();
const providerNames=[...new Set(Object.values(data.comparisons).flat().flatMap(row=>row.comparisons.map(model=>model.provider)))].sort();
document.getElementById('source-filter').insertAdjacentHTML('beforeend',sourceNames.map(name=>'<option value="'+esc(name)+'">'+esc(name)+'</option>').join(''));
document.getElementById('provider-filter').insertAdjacentHTML('beforeend',providerNames.map(name=>'<option value="'+esc(name)+'">'+esc(name)+'</option>').join(''));
['search','source-filter','provider-filter','sort-order'].forEach(id=>document.getElementById(id).addEventListener(id==='search'?'input':'change',render));
function table(headings,rows){return '<table><thead><tr>'+headings.map(head=>'<th>'+head+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table>';}
function render(){
 const query=document.getElementById('search').value.trim().toLowerCase();
 const sourceFilter=document.getElementById('source-filter').value;
 const providerFilter=document.getElementById('provider-filter').value;
 const sort=document.getElementById('sort-order').value;
 const matches=value=>!query||String(value).toLowerCase().includes(query);
 const comparePeriod=(a,b)=>sort==='period-asc'?a.period.localeCompare(b.period):b.period.localeCompare(a.period);
 const sortUsage=rows=>rows.sort((a,b)=>{
  if(sort==='period-asc'||sort==='period-desc')return comparePeriod(a,b);
  if(sort==='source-asc')return a.source.localeCompare(b.source)||a.period.localeCompare(b.period);
  if(sort==='tokens-desc')return b.totalTokens-a.totalTokens;
  const left=a.actualApiCost,right=b.actualApiCost;
  return sort==='cost-asc'?left-right:right-left;
 });
 const rows=sortUsage((data.periods[active]||[]).filter(row=>(!sourceFilter||row.source===sourceFilter)&&matches(row.period+' '+row.source+' '+row.models.join(' '))));
 document.getElementById('usage-table').innerHTML=rows.length?table(['Period','Source','Models','Input','Output','Cache write','Cache read','API equivalent','Estimated API cost'],rows.map(row=>'<tr><td>'+esc(row.period)+'</td><td>'+esc(row.source)+'</td><td class="models">'+esc(row.models.join(', '))+'</td><td class="num">'+fmtInt(row.input)+'</td><td class="num">'+fmtInt(row.output)+'</td><td class="num">'+fmtInt(row.cacheCreate)+'</td><td class="num">'+fmtInt(row.cacheRead)+'</td><td class="num">'+fmtMoney(row.listCost)+'</td><td class="num">'+fmtMoney(row.actualApiCost)+'</td></tr>').join('')):'<div class="empty">No usage rows match these filters.</div>';
 const comparisonRows=(data.comparisons[active]||[]).flatMap(row=>row.comparisons.map(model=>({...model,period:row.period}))).filter(row=>(!providerFilter||row.provider===providerFilter)&&matches(row.period+' '+row.model+' '+row.provider));
 comparisonRows.sort((a,b)=>{
  if(sort==='period-asc'||sort==='period-desc')return comparePeriod(a,b)||a.provider.localeCompare(b.provider);
  if(sort==='source-asc')return a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model);
  const left=a.cost,right=b.cost;
  return sort==='cost-desc'?right-left:left-right;
 });
 document.getElementById('comparison-table').innerHTML=comparisonRows.length?table(['Period','Target model','Provider','Estimated API cost','Ratio vs source model rates'],comparisonRows.map(model=>'<tr><td>'+esc(model.period)+'</td><td>'+esc(model.model)+'</td><td>'+esc(model.provider)+'</td><td class="num">'+fmtMoney(model.cost)+'</td><td class="num">'+(model.ratio==null?'—':(model.ratio*100).toFixed(1)+'%')+'</td></tr>').join('')):'<div class="empty">No provider comparisons match these filters.</div>';
 const totals=new Map();
 for(const row of data.comparisons[active]||[])for(const model of row.comparisons){
  if(!Number.isFinite(model.cost)||providerFilter&&model.provider!==providerFilter||!matches(model.model+' '+model.provider))continue;
  const key=model.provider;const current=totals.get(key)||{provider:key,model:model.model,cost:0};current.cost+=model.cost;totals.set(key,current);
 }
 const top=[...totals.values()].sort((a,b)=>a.cost-b.cost).slice(0,10);const max=top[0]?Math.max(...top.map(row=>row.cost)):0;
 document.getElementById('top-chart').innerHTML=top.length?top.map((row,index)=>'<div class="bar-row" role="img" aria-label="'+esc(row.provider+' '+row.model+' '+fmtMoney(row.cost))+'"><div class="bar-label"><strong>'+String(index+1).padStart(2,'0')+' · '+esc(row.provider)+'<small>'+esc(row.model)+'</small></strong><span>'+fmtMoney(row.cost)+'</span></div><div class="bar-track"><i style="width:'+Math.max(1,max?row.cost/max*100:0)+'%"></i></div></div>').join(''):'<div class="empty">No priced comparisons match these filters.</div>';
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
  console.log("[3/5] Applying API rates to the detected models; models without a listed rate are counted as $0.");

  const comparisons = chooseComparisons(registry, records);
  const kinds = ["daily", "weekly", "monthly"];
  console.log("[5/5] Building daily, weekly, and monthly report tables...");
  const periods = Object.fromEntries(kinds.map((kind) => [kind, aggregate(records, kind)]));
  const comparisonPeriods = Object.fromEntries(kinds.map((kind) => [kind, aggregateComparisons(records, kind, comparisons)]));
  const usageOnly = records;
  const totalTokens = usageOnly.reduce((sum, record) => sum + record.input + record.output + record.cacheCreate + record.cacheRead, 0);
  const totalInput = usageOnly.reduce((sum, record) => sum + record.input, 0);
  const totalOutput = usageOnly.reduce((sum, record) => sum + record.output, 0);
  const missingPriceModels = [...new Set(usageOnly.filter((record) => record.missingPrice).map((record) => record.model))];
  const estimatedApiCost = usageOnly.reduce((sum, record) => sum + record.actualApiCost, 0);
  const notes = [
    "Input, output, cache-write, and cache-read tokens come from ccusage daily JSON. Week totals use ccusage's default Monday start; month totals follow calendar months. Only ccusage-supported daily, weekly, and monthly views are shown.",
    pricingUpdated ? "API rates were refreshed from LiteLLM at run time. Model tier, region, prompt length, peak-hour, batch, and provider-specific discounts may change real invoices." : "Live pricing could not be loaded; models without a price entry were counted as $0.",
    "No subscription, allowance, or top-up fees are included. Every total is an API-price comparison only.",
    "Usage records remain local and are not uploaded to mytoken or included in anonymous analytics. The launcher downloads ccusage, and the analyzer fetches public pricing. The site host and contacted services may receive ordinary connection metadata such as your IP address.",
    "Every provider with a priced chat model in the live registry is compared automatically. For each provider, the lowest-cost model for this token mix is used as a price baseline, not a quality-equivalent recommendation.",
    ...(missingPriceModels.length ? [`No LiteLLM rate was listed for: ${missingPriceModels.join(", ")}. These models are shown as $0 until a public rate is available.`] : []),
    `Sources currently listed by ccusage: ${SUPPORTED_SOURCES_URL}. Newly supported sources are included after ccusage updates.`,
  ];
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceCount: new Set(usageOnly.map((record) => record.source)).size,
    summary: { totalTokens, input: totalInput, output: totalOutput, estimatedApiCost },
    periods,
    comparisons: comparisonPeriods,
    notes,
  };
  const reportPath = join(tmpdir(), `mytoken-report-${Date.now()}.html`);
  await writeFile(reportPath, buildReportHtml(payload), { encoding: "utf8", mode: 0o600 });
  console.log("[5/5] Complete — local report is ready.");
  console.log(`\nReport saved locally to: ${reportPath}`);
  if (openInBrowser(reportPath)) console.log("Opened the local report in your browser.");
  else console.log("Could not open a browser automatically. Open the local HTML path above.");
  console.log("\nFinished. No ccusage logs, tokens, or session details were uploaded.");
}

try {
  await main();
} catch (error) {
  console.error(`\nmytoken stopped: ${error.message}`);
  process.exitCode = 1;
}
