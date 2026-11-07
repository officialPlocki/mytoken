import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRICE_REGISTRY_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENCODE_GO_DOCS_URL = "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/site/src/docs/content/console/go.mdx";
const SUPPORTED_SOURCES_URL = "https://ccusage.com/guide/all-reports";
const GO_DOCS_URL = "https://opencode.ai/docs/go/";
const prompt = createInterface({ input: stdin, output: stdout });

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
          isSubscription: false,
        });
      }
    }
  }
  return records;
}

async function fetchText(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.text();
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

function usdNumber(value) {
  const clean = String(value).replace(/~~[^~]*~~/g, "").replace(/\*\*/g, "");
  if (/unlimited/i.test(clean)) return Infinity;
  const matches = [...clean.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)];
  if (matches.length) return Number(matches.at(-1)[1]);
  if (/\bfree\b/i.test(clean)) return 0;
  return null;
}

function parseGoTables(markdown) {
  const sectionStart = markdown.indexOf("## Usage limits");
  if (sectionStart < 0) return [];
  const lines = markdown.slice(sectionStart).split(/\r?\n/);
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\|\s*Model\s*\|\s*Input\s*\|/i.test(lines[index])) continue;
    const rows = [];
    index += 1;
    while (index < lines.length && /^\|/.test(lines[index])) {
      const cells = lines[index].split("|").slice(1, -1).map((cell) => cell.trim());
      if (!cells.every((cell) => /^[-:\s]+$/.test(cell))) rows.push(cells);
      index += 1;
    }
    const models = new Map();
    for (const cells of rows) {
      if (cells.length < 6) continue;
      const modelName = cells[0];
      const monthlyLimit = usdNumber(cells[5]);
      if (monthlyLimit == null) continue;
      const baseName = modelName.split("(")[0].trim();
      const inputRate = usdNumber(cells[1]);
      const outputRate = usdNumber(cells[2]);
      const cachedReadRate = usdNumber(cells[3]);
      const cachedWriteRate = usdNumber(cells[4]);
      const key = normalized(baseName);
      if (!models.has(key)) models.set(key, { names: new Set(), rows: [] });
      const model = models.get(key);
      model.names.add(baseName);
      model.rows.push({
        input: inputRate,
        output: outputRate,
        cacheRead: cachedReadRate,
        cacheCreate: cachedWriteRate,
        monthlyLimit,
      });
    }
    if (models.size) tables.push(models);
  }
  return tables;
}

async function loadGoPlans() {
  try {
    const markdown = await fetchText(OPENCODE_GO_DOCS_URL, "OpenCode Go plan source");
    return parseGoTables(markdown);
  } catch (error) {
    console.log(`OpenCode Go allowance data could not be refreshed: ${error.message}`);
    return [];
  }
}

function findGoPlanModel(plans, planIndex, modelId) {
  const plan = plans[planIndex];
  if (!plan) return null;
  const suffix = String(modelId).split("/").at(-1);
  const key = normalized(suffix);
  let match = plan.get(key);
  if (!match) {
    for (const [candidateKey, candidate] of plan.entries()) {
      if (candidateKey === key || candidateKey.startsWith(key) || key.startsWith(candidateKey)) {
        match = candidate;
        break;
      }
    }
  }
  if (!match) return null;
  const rows = match.rows;
  const finite = (values) => values.filter(Number.isFinite);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const limits = finite(rows.map((row) => row.monthlyLimit));
  const monthlyLimit = rows.some((row) => row.monthlyLimit === Infinity) ? Infinity : average(limits);
  const rate = (field) => {
    const values = finite(rows.map((row) => row[field]));
    return values.length ? average(values) / 1_000_000 : null;
  };
  return {
    input_cost_per_token: rate("input"),
    output_cost_per_token: rate("output"),
    cache_read_input_token_cost: rate("cacheRead"),
    cache_creation_input_token_cost: rate("cacheCreate"),
    monthlyLimit,
    displayName: [...match.names].join(" / "),
  };
}

async function ask(label, fallback = "") {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = (await prompt.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

async function askYes(label, defaultValue = false) {
  const response = (await ask(`${label} (y/n)`, defaultValue ? "y" : "n")).toLowerCase();
  return ["y", "yes", "true", "1"].includes(response);
}

function parseMoney(value, fallback = 0) {
  if (/^all$/i.test(value)) return Infinity;
  const parsed = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sourceHasGoModels(records) {
  return records.some((record) => /(?:^|\/)opencode-go\//i.test(record.model) || /opencode-go/i.test(record.model));
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

function monthKey(date) {
  return date.slice(0, 7);
}

function daysInMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function addMonthDays(records, plan) {
  const activeMonths = new Set(records.filter((record) => plan.matches(record)).map((record) => monthKey(record.date)));
  for (const month of activeMonths) {
    const days = daysInMonth(month);
    for (let day = 1; day <= days; day += 1) {
      const date = `${month}-${String(day).padStart(2, "0")}`;
      records.push({
        date,
        source: `Subscription: ${plan.label}`,
        model: plan.label,
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
        listCost: 0,
        actualApiCost: 0,
        subscriptionCost: plan.monthlyFee / days,
        isSubscription: true,
      });
    }
  }
}

function applyGenericSubscription(records, plan) {
  const months = new Map();
  for (const record of records) {
    if (record.isSubscription || !plan.matches(record)) continue;
    if (!months.has(monthKey(record.date))) months.set(monthKey(record.date), []);
    months.get(monthKey(record.date)).push(record);
  }
  for (const recordsInMonth of months.values()) {
    const known = recordsInMonth.filter((record) => Number.isFinite(record.actualApiCost));
    const total = known.reduce((sum, record) => sum + record.actualApiCost, 0);
    const allowance = plan.monthlyAllowance;
    if (allowance === Infinity) {
      for (const record of known) record.actualApiCost = 0;
      continue;
    }
    const left = Math.max(0, total - allowance);
    const ratio = total > 0 ? left / total : 1;
    for (const record of known) record.actualApiCost *= ratio;
  }
  addMonthDays(records, plan);
}

function applyGoPlan(records, plan) {
  const monthlyModels = new Map();
  for (const record of records) {
    if (record.isSubscription || !plan.matches(record)) continue;
    const model = String(record.model).split("/").at(-1);
    const key = `${monthKey(record.date)}\u0000${model}`;
    if (!monthlyModels.has(key)) monthlyModels.set(key, { model, rows: [] });
    monthlyModels.get(key).rows.push(record);
  }
  for (const { model, rows } of monthlyModels.values()) {
    const details = findGoPlanModel(plan.goTables, plan.goPlanIndex, model);
    if (!details) {
      for (const record of rows) record.actualApiCost = null;
      continue;
    }
    const costs = rows.map((record) => costFromRateEntry(record, details));
    const total = costs.some((value) => value == null) ? null : costs.reduce((sum, value) => sum + value, 0);
    if (total == null) {
      for (const record of rows) record.actualApiCost = null;
      continue;
    }
    const covered = Math.min(total, details.monthlyLimit);
    const overage = plan.extraUsage ? Math.max(0, total - covered) : 0;
    const ratio = total > 0 ? overage / total : 0;
    rows.forEach((record, index) => {
      record.listCost = costs[index];
      record.actualApiCost = costs[index] * ratio;
    });
  }
  addMonthDays(records, plan);
}

function flattenRegistry(registry) {
  return Object.entries(registry)
    .filter(([, info]) => info && typeof info === "object" && info.mode === "chat"
      && info.litellm_provider && info.input_cost_per_token != null && info.output_cost_per_token != null)
    .map(([key, info]) => ({ key, info }));
}

function workloadTotals(records) {
  return records.filter((record) => !record.isSubscription).reduce((totals, record) => {
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

async function chooseComparisons(registry, records) {
  const entries = flattenRegistry(registry);
  const providers = [...new Set(entries.map((entry) => String(entry.info.litellm_provider).toLowerCase()))].sort();
  if (!providers.length) return [];
  const defaults = ["deepseek", "anthropic", "openai", "google", "xai", "mistral", "moonshot"].filter((id) => providers.includes(id));
  console.log("\nAvailable API provider IDs in the live pricing registry:");
  console.log(providers.join(", "));
  console.log("Enter provider IDs (the lowest listed chat-model cost is selected) or exact LiteLLM model IDs.");
  const selected = await ask("Compare models", defaults.join(","));
  const workload = workloadTotals(records);
  const comparisons = [];
  for (const input of selected.split(",").map((item) => item.trim()).filter(Boolean)) {
    let model = null;
    const exact = findPriceEntry(input, registry);
    if (exact && exact.value.mode === "chat") {
      model = { key: exact.key, info: exact.value, cost: costFromRateEntry(workload, exact.value) };
    } else {
      model = bestModelForProvider(input, entries, workload);
    }
    if (!model || model.cost == null) {
      console.log(`Skipping '${input}': no priced chat model matched.`);
      continue;
    }
    if (!comparisons.some((item) => item.key === model.key)) comparisons.push(model);
  }
  return comparisons;
}

async function collectSubscriptions(records, goTables) {
  const plans = [];
  const goModels = [...new Set(records.filter((record) => /opencode-go/i.test(record.model)).map((record) => String(record.model).split("/").at(-1)))];
  if (goModels.length) {
    console.log(`\nOpenCode Go model IDs detected: ${goModels.join(", ")}`);
    const hasGo = await askYes("Do you have an OpenCode Go subscription?", true);
    if (hasGo) {
      console.log("Plan: 1 = Go ($10/month), 2 = Go Plus ($40/month), 3 = Go Teams ($20 per member/month).");
      const planChoice = await ask("Choose your plan (1/2/3)", "1");
      const goPlanIndex = Math.max(0, Math.min(2, Number(planChoice) - 1 || 0));
      const teamMembers = goPlanIndex === 2 ? Math.max(1, Number(await ask("Number of billed Go Teams members", "1")) || 1) : 1;
      const feeDefaults = [10, 40, 20 * teamMembers];
      const monthlyFee = parseMoney(await ask("Actual monthly subscription price in USD", String(feeDefaults[goPlanIndex])), feeDefaults[goPlanIndex]);
      const extraUsage = await askYes("Is Extra Usage / paid top-up enabled?", false);
      plans.push({
        label: ["OpenCode Go", "OpenCode Go Plus", "OpenCode Go Teams"][goPlanIndex],
        monthlyFee,
        monthlyAllowance: 0,
        goPlanIndex,
        goTables,
        extraUsage,
        matcher: "opencode-go",
        matches: (record) => /opencode-go/i.test(record.model),
        type: "opencode-go",
      });
      if (!goTables[goPlanIndex]) {
        console.log(`Official model caps were unavailable. Review ${GO_DOCS_URL} and enter a monthly API-equivalent included amount for each detected Go model.`);
        for (const model of goModels) {
          const amount = await ask(`Included monthly USD value for ${model} (use 'all' if it fits the plan)`, "all");
          const allowance = parseMoney(amount, Infinity);
          plans.at(-1).manualAllowances ??= {};
          plans.at(-1).manualAllowances[model] = allowance;
        }
        plans.at(-1).type = "opencode-go-manual";
      }
    }
  }

  while (await askYes("Add another subscription such as Claude Pro, ChatGPT Plus, Gemini, or Copilot?", false)) {
    const label = await ask("Subscription name", "AI subscription");
    const monthlyFee = parseMoney(await ask("Actual monthly subscription price in USD", "0"), 0);
    const matcher = await ask("Source or model text covered by this plan (e.g. claude, codex, copilot)");
    if (!matcher) {
      console.log("A match string is required; this subscription was skipped.");
      continue;
    }
    const allowanceText = await ask("Monthly included API-equivalent USD value ('all' covers every matched row)", "all");
    const monthlyAllowance = parseMoney(allowanceText, Infinity);
    plans.push({
      label,
      monthlyFee,
      monthlyAllowance,
      matcher,
      matches: (record) => `${record.source} ${record.model}`.toLowerCase().includes(matcher.toLowerCase()),
      type: "generic",
    });
  }
  return plans;
}

function attachPrices(records, registry, goTables) {
  for (const record of records) {
    const goModel = /opencode-go/i.test(record.model);
    const publicEntry = findPriceEntry(record.model, registry);
    if (goModel) {
      record.goPublicEntry = publicEntry?.value ?? null;
      record.listCost = null;
      record.actualApiCost = null;
      continue;
    }
    record.priceKey = publicEntry?.key ?? null;
    record.priceProvider = publicEntry?.value?.litellm_provider ?? null;
    record.listCost = publicEntry ? costFromRateEntry(record, publicEntry.value) : null;
    record.actualApiCost = record.listCost;
  }
}

function applyManualGoPlan(records, plan) {
  const months = new Map();
  for (const record of records) {
    if (record.isSubscription || !plan.matches(record)) continue;
    const model = String(record.model).split("/").at(-1);
    const key = `${monthKey(record.date)}\u0000${model}`;
    if (!months.has(key)) months.set(key, { model, rows: [] });
    months.get(key).rows.push(record);
  }
  for (const { model, rows } of months.values()) {
    const total = rows.reduce((sum, record) => sum + asNumber(record.goPublicEntry && costFromRateEntry(record, record.goPublicEntry)), 0);
    const allowance = plan.manualAllowances?.[model] ?? Infinity;
    const uncovered = Math.max(0, total - allowance);
    const ratio = total > 0 ? uncovered / total : 0;
    rows.forEach((record) => {
      const rate = record.goPublicEntry ? costFromRateEntry(record, record.goPublicEntry) : null;
      record.listCost = rate;
      record.actualApiCost = rate == null ? null : rate * (plan.extraUsage ? ratio : 0);
    });
  }
  addMonthDays(records, plan);
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
        listKnown: true,
        actualApiCost: 0,
        actualKnown: true,
        subscriptionCost: 0,
        models: new Set(),
      });
    }
    const group = groups.get(key);
    group.input += record.input;
    group.output += record.output;
    group.cacheCreate += record.cacheCreate;
    group.cacheRead += record.cacheRead;
    if (Number.isFinite(record.listCost)) group.listCost += record.listCost;
    else if (!record.isSubscription && record.input + record.output + record.cacheCreate + record.cacheRead > 0) group.listKnown = false;
    if (Number.isFinite(record.actualApiCost)) group.actualApiCost += record.actualApiCost;
    else if (!record.isSubscription && record.input + record.output + record.cacheCreate + record.cacheRead > 0) group.actualKnown = false;
    group.subscriptionCost += record.subscriptionCost ?? 0;
    group.models.add(record.model);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    totalTokens: group.input + group.output + group.cacheCreate + group.cacheRead,
    models: [...group.models].sort(),
    listCost: group.listKnown ? group.listCost : null,
    actualApiCost: group.actualKnown ? group.actualApiCost : null,
    outlay: group.actualKnown ? group.actualApiCost + group.subscriptionCost : null,
  })).sort((a, b) => a.period.localeCompare(b.period) || a.source.localeCompare(b.source));
}

function aggregateComparisons(records, kind, models) {
  const periods = new Map();
  for (const record of records) {
    if (record.isSubscription) continue;
    const period = periodFromDate(record.date, kind);
    if (!periods.has(period)) periods.set(period, { period, input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
    const entry = periods.get(period);
    entry.input += record.input;
    entry.output += record.output;
    entry.cacheCreate += record.cacheCreate;
    entry.cacheRead += record.cacheRead;
  }
  return [...periods.values()].map((entry) => {
    const original = records.filter((record) => !record.isSubscription && periodFromDate(record.date, kind) === entry.period);
    const originalKnown = original.filter((record) => Number.isFinite(record.listCost)).length === original.length;
    const originalCost = originalKnown ? original.reduce((sum, record) => sum + record.listCost, 0) : null;
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
:root{color-scheme:light dark;--ink:#17221c;--muted:#6e7b72;--line:#dce4dd;--green:#1b8152;--paper:#f5f8f4;--white:#fff;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}main{max-width:1200px;margin:0 auto;padding:34px 30px 60px}.head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:23px}.brand{font-size:12px;font-weight:800;letter-spacing:.1em}.stamp{color:var(--muted);font:11px ui-monospace,monospace}.hero{padding:34px 0 23px}.eyebrow{margin:0;color:var(--green);font:11px ui-monospace,monospace;letter-spacing:.1em}.hero h1{margin:10px 0 6px;font-size:clamp(28px,4vw,44px);letter-spacing:-.04em}.hero p{max-width:760px;color:var(--muted);margin:0}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card{padding:16px 17px;background:var(--white);border:1px solid var(--line);border-radius:9px}.card span{display:block;color:var(--muted);font-size:11px}.card strong{display:block;margin-top:7px;font-size:21px;letter-spacing:-.03em}.tabs{display:flex;gap:6px;margin:30px 0 13px}.tab{padding:8px 13px;border:1px solid var(--line);border-radius:7px;background:var(--white);color:var(--muted);font:600 12px system-ui;cursor:pointer}.tab.active{border-color:#a6d8bd;background:#e9f7ef;color:#176a43}.panel{margin-top:12px;border:1px solid var(--line);border-radius:9px;background:var(--white);overflow:hidden}.panel h2{margin:0;padding:17px 18px;border-bottom:1px solid var(--line);font-size:15px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:850px}th,td{padding:11px 13px;border-bottom:1px solid #edf0ed;text-align:left;vertical-align:top;font-size:11px}th{position:sticky;top:0;background:#f8faf8;color:#68756d;font:10px ui-monospace,monospace;letter-spacing:.04em}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.models{min-width:220px;color:#6c7971;max-width:330px;overflow-wrap:anywhere}.notes{margin-top:20px;padding:16px 18px;border:1px solid var(--line);border-radius:9px;background:#fbfcfb;color:var(--muted);font-size:11px}.notes strong{color:#33443a}.notes ul{margin:8px 0 0;padding-left:17px}.foot{display:flex;justify-content:space-between;gap:15px;margin-top:20px;color:#87928a;font:10px ui-monospace,monospace}a{color:var(--green)}@media(max-width:700px){main{padding:22px 15px 40px}.cards{grid-template-columns:repeat(2,1fr)}.head{align-items:flex-start;gap:10px;flex-direction:column}.foot{flex-direction:column}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--ink:#e5eee8;--muted:#9caaa1;--line:#2d3b32;--green:#61d89d;--paper:#111914;--white:#19241d}.tab.active{border-color:#315740;background:#20372a;color:#a1e6bb}th{background:#18221b;color:#b3c0b7}th,td{border-bottom-color:#28352d}td.models{color:#a0ada4}.notes{background:#151e18}.notes strong{color:#d9e5dd}.foot{color:#9aa79f}}</style></head><body><main>
<header class="head"><div class="brand">MYTOKEN / LOCAL REPORT</div><div class="stamp">Generated <span id="generated"></span></div></header>
<section class="hero"><p class="eyebrow">PRIVATE ON THIS DEVICE</p><h1>Your token usage, repriced.</h1><p>This report was assembled from local ccusage JSON and current public price registries. Your usage stays in this local report; it is not sent to mytoken, saved on its servers, or included in anonymous analytics.</p></section>
<section class="cards" id="cards"></section>
<nav class="tabs" aria-label="Report period" id="tabs"></nav>
<section class="panel"><h2>Usage by ccusage source</h2><div class="table-wrap" id="usage-table"></div></section>
<section class="panel"><h2>Same token mix at other API models</h2><div class="table-wrap" id="comparison-table"></div></section>
<section class="notes"><strong>Reading this estimate</strong><ul id="notes"></ul></section>
<footer class="foot"><span>ccusage aggregates every source supported by the installed version.</span><span>Theme follows your system appearance.</span><span>Pricing metadata: <a href="https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json">LiteLLM</a> · <a href="${GO_DOCS_URL}">OpenCode Go plans</a></span></footer>
</main><script type="application/json" id="ledger-data">${safePayload}</script>
<script>
const data=JSON.parse(document.getElementById('ledger-data').textContent);let active='monthly';
const fmtInt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(n||0);
const fmtMoney=n=>n==null?'Unpriced':'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
document.getElementById('generated').textContent=new Date(data.generatedAt).toLocaleString();
document.getElementById('cards').innerHTML=[['TOTAL TOKENS',fmtInt(data.summary.totalTokens)],['INPUT',fmtInt(data.summary.input)],['OUTPUT',fmtInt(data.summary.output)],['MODELED API OUTLAY',fmtMoney(data.summary.outlay)]].map(([label,value])=>'<div class="card"><span>'+label+'</span><strong>'+value+'</strong></div>').join('');
const labels={daily:'Day',weekly:'Week',monthly:'Month'};
document.getElementById('tabs').innerHTML=Object.keys(labels).map(key=>'<button class="tab '+(active===key?'active':'')+'" data-period="'+key+'">'+labels[key]+'</button>').join('');
document.getElementById('tabs').addEventListener('click',event=>{const key=event.target.dataset.period;if(!key)return;active=key;document.querySelectorAll('.tab').forEach(button=>button.classList.toggle('active',button.dataset.period===active));render();});
function table(headings,rows){return '<table><thead><tr>'+headings.map(head=>'<th>'+head+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table>';}
function render(){const rows=data.periods[active]||[];document.getElementById('usage-table').innerHTML=table(['Period','Source','Models','Input','Output','Cache write','Cache read','API equivalent','Subscription','Estimated outlay'],rows.map(row=>'<tr><td>'+esc(row.period)+'</td><td>'+esc(row.source)+'</td><td class="models">'+esc(row.models.join(', '))+'</td><td class="num">'+fmtInt(row.input)+'</td><td class="num">'+fmtInt(row.output)+'</td><td class="num">'+fmtInt(row.cacheCreate)+'</td><td class="num">'+fmtInt(row.cacheRead)+'</td><td class="num">'+fmtMoney(row.listCost)+'</td><td class="num">'+fmtMoney(row.subscriptionCost)+'</td><td class="num">'+fmtMoney(row.outlay)+'</td></tr>').join(''));
const comparisonRows=data.comparisons[active]||[];document.getElementById('comparison-table').innerHTML=table(['Period','Target model','Provider','Estimated API cost','Ratio vs source model rates'],comparisonRows.flatMap(row=>row.models.map(model=>'<tr><td>'+esc(row.period)+'</td><td>'+esc(model.model)+'</td><td>'+esc(model.provider)+'</td><td class="num">'+fmtMoney(model.cost)+'</td><td class="num">'+(model.ratio==null?'—':(model.ratio*100).toFixed(1)+'%')+'</td></tr>')).join(''));
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
  console.log("Reading all available ccusage sources from this computer. Usage data stays local.\n");
  const rawUsage = runCcusage(["daily", "--json", "--breakdown", "--by-agent", "--sections", "weekly,monthly", "--no-cost"]);
  let records = parseUsage(parseJsonOutput(rawUsage));
  if (!records.length) throw new Error("ccusage found no daily model usage on this computer.");
  console.log(`Loaded ${records.length.toLocaleString()} daily source/model rows from ccusage.`);

  let registry = {};
  let pricingUpdated = false;
  try {
    registry = await loadPriceRegistry();
    pricingUpdated = true;
    console.log(`Loaded current pricing for ${Object.keys(registry).length.toLocaleString()} model entries from LiteLLM.`);
  } catch (error) {
    console.log(`Live model pricing could not be loaded: ${error.message}`);
  }

  const goTables = sourceHasGoModels(records) ? await loadGoPlans() : [];
  attachPrices(records, registry, goTables);
  const plans = await collectSubscriptions(records, goTables);
  for (const plan of plans) {
    if (plan.type === "opencode-go") applyGoPlan(records, plan);
    else if (plan.type === "opencode-go-manual") applyManualGoPlan(records, plan);
    else applyGenericSubscription(records, plan);
  }

  const comparisons = await chooseComparisons(registry, records);
  const kinds = ["daily", "weekly", "monthly"];
  const periods = Object.fromEntries(kinds.map((kind) => [kind, aggregate(records, kind)]));
  const comparisonPeriods = Object.fromEntries(kinds.map((kind) => [kind, aggregateComparisons(records, kind, comparisons)]));
  const usageOnly = records.filter((record) => !record.isSubscription);
  const totalTokens = usageOnly.reduce((sum, record) => sum + record.input + record.output + record.cacheCreate + record.cacheRead, 0);
  const totalInput = usageOnly.reduce((sum, record) => sum + record.input, 0);
  const totalOutput = usageOnly.reduce((sum, record) => sum + record.output, 0);
  const unpricedModels = [...new Set(usageOnly.filter((record) => record.listCost == null && record.input + record.output + record.cacheCreate + record.cacheRead > 0).map((record) => record.model))];
  const outlayIsComplete = usageOnly.every((record) => Number.isFinite(record.actualApiCost));
  const outlay = outlayIsComplete
    ? records.reduce((sum, record) => sum + (Number.isFinite(record.actualApiCost) ? record.actualApiCost : 0) + (record.subscriptionCost ?? 0), 0)
    : null;
  const notes = [
    "Input, output, cache-write, and cache-read tokens come from ccusage daily JSON. Week totals use ccusage's default Monday start; month totals follow calendar months. Only ccusage-supported daily, weekly, and monthly views are shown.",
    pricingUpdated ? "API rates were refreshed from LiteLLM at run time. Model tier, region, prompt length, peak-hour, batch, and provider-specific discounts may change real invoices." : "Live pricing was unavailable. Any model without an available rate is marked Unpriced and is not assumed to cost zero.",
    "Subscription fees are allocated evenly across every calendar day of each month with matching local usage. Plan coverage assumptions are the answers entered in this terminal.",
    "No usage data is uploaded, saved on mytoken servers, or included in anonymous analytics; only this local HTML report is written.",
    "A provider ID selects its lowest listed priced chat model for the recorded token mix. This is a price baseline, not a quality-equivalent model recommendation.",
    ...(unpricedModels.length ? [`No matching public API rate was found for: ${unpricedModels.join(", ")}. Token counts remain visible; these rows are not assumed to be free.`] : []),
    ...(sourceHasGoModels(usageOnly) ? [`OpenCode Go is detected from its opencode-go model IDs. Per-model plan limits use the current official Go documentation when available (${GO_DOCS_URL}).`] : []),
    `Sources currently listed by ccusage: ${SUPPORTED_SOURCES_URL}. Newly supported sources are included after ccusage updates.`,
  ];
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceCount: new Set(usageOnly.map((record) => record.source)).size,
    summary: { totalTokens, input: totalInput, output: totalOutput, outlay },
    periods,
    comparisons: comparisonPeriods,
    notes,
  };
  const reportPath = join(tmpdir(), `mytoken-report-${Date.now()}.html`);
  await writeFile(reportPath, buildReportHtml(payload), { encoding: "utf8", mode: 0o600 });
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
} finally {
  prompt.close();
}
