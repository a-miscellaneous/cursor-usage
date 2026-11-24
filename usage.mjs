/**
 * Turns Cursor period usage and aggregated events into the spending-HUD view.
 * Pricing follows cursor.com/docs/models-and-pricing the same way the
 * Tampermonkey script does: list price versus what Cursor billed.
 */

export function fmtMoney(cents) {
  const n = Number(cents) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n) / 100;
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}bn`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtResetLeft(end, now = Date.now()) {
  const ms = endMs(end) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "soon";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return `${d}d`;
  if (h >= 1) return `${h}h`;
  if (m >= 1) return `${m}m`;
  return `${s}s`;
}

function endMs(end) {
  if (end == null || end === "") return NaN;
  if (typeof end === "number") return end < 1e12 ? end * 1000 : end;
  const n = Number(end);
  if (Number.isFinite(n) && /^\d+$/.test(String(end).trim())) {
    return n < 1e12 ? n * 1000 : n;
  }
  return new Date(end).getTime();
}

function pct(part, total) {
  return total > 0 ? ((part / total) * 100).toFixed(1) : "0.0";
}

export function tokenParts(event) {
  const usage = event.tokenUsage || event;
  const input = Number(event.inputTokens ?? usage.inputTokens ?? 0);
  const output = Number(event.outputTokens ?? usage.outputTokens ?? 0);
  const cacheRead = Number(event.cacheReadTokens ?? usage.cacheReadTokens ?? 0);
  const cacheWrite = Number(event.cacheWriteTokens ?? usage.cacheWriteTokens ?? 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cache: cacheRead + cacheWrite,
    tokens: input + output + cacheRead + cacheWrite,
  };
}

export function bucketAggregations(events, autoBucketModels) {
  const autoBucketSet = new Set(autoBucketModels || []);
  const buckets = {
    auto: { cents: 0, tokens: 0, models: [] },
    api: { cents: 0, tokens: 0, models: [] },
  };
  for (const event of events || []) {
    const intent = event.modelIntent || event.model || "default";
    const isAuto = event.tier === 2
      || (event.tier == null && (intent === "default" || autoBucketSet.has(intent)));
    const key = isAuto ? "auto" : "api";
    const parts = tokenParts(event);
    const cents = Number(event.totalCents ?? event.tokenUsage?.totalCents ?? 0);
    buckets[key].cents += cents;
    buckets[key].tokens += parts.tokens;
    buckets[key].models.push({
      name: intent === "default" ? "auto" : intent,
      intent,
      cents,
      ...parts,
    });
  }
  for (const bucket of Object.values(buckets)) {
    bucket.models.sort((a, b) => b.cents - a.cents);
  }
  return buckets;
}

function parsePriceCell(cell) {
  const s = String(cell || "").trim();
  if (s === "-" || s === "–" || s === "") return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function aliasKeys(base) {
  const keys = new Set([base]);
  let match = base.match(/^claude (\d+(?:\.\d+)?) (opus|sonnet|haiku|fable)$/);
  if (match) keys.add(`claude ${match[2]} ${match[1]}`);
  match = base.match(/^claude (opus|sonnet|haiku|fable) (\d+(?:\.\d+)?)$/);
  if (match) keys.add(`claude ${match[2]} ${match[1]}`);
  return [...keys];
}

function joinVersion(base) {
  let s = base;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/(\d+) (\d{1,2})\b/g, "$1.$2");
    if (next === s) break;
    s = next;
  }
  return s;
}

function docBase(name) {
  const fast = /\bfast\b/i.test(name);
  const ctx = /\b500k\b/i.test(name) ? "500k" : /\b1m\b/i.test(name) ? "1m" : "";
  let s = name.replace(/\(.*?\)/g, " ");
  s = s.replace(/\bfast mode\b|\bfast\b/gi, " ");
  s = s.replace(/\b500k\b|\b1m\b/gi, " ");
  s = s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
  return { fast, ctx, base: s };
}

function usageBase(modelIntent) {
  let s = String(modelIntent || "").toLowerCase();
  if (!s || s === "default" || s === "auto") return null;
  const ctx = s.includes("500k") ? "500k" : /(?:^|-)1m(?:-|$)/.test(s) ? "1m" : "";
  const fast = /(?:^|-)fast(?:-|$)/.test(s);
  s = s.replace(/^cursor-/, "");
  s = s.replace(/-fast-/g, "-").replace(/-fast$/g, "").replace(/^fast-/, "");
  s = s.replace(/-thinking/g, "");
  s = s.replace(/-(?:1m|500k)/g, "");
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/-(?:low|medium|high|xhigh)$/, "");
    if (next === s) break;
    s = next;
  }
  if (/-max$/.test(s) && (String(modelIntent).includes("thinking") || /^(cursor-)?(claude|grok|composer|vega)/.test(modelIntent))) {
    s = s.replace(/-max$/, "");
  }
  const base = joinVersion(s.replace(/-/g, " ").replace(/\s+/g, " ").trim());
  if (!base) return null;
  return { ctx, fast, base };
}

export function parsePricingMd(md) {
  const rows = [];
  for (const line of String(md).split("\n")) {
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6 || cells[0] === "Model" || cells[2] === "Input") continue;
    const name = cells[0].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
    const input = parsePriceCell(cells[2]);
    if (!name || input == null) continue;
    const doc = docBase(name);
    if (!doc.base) continue;
    rows.push({
      name,
      fast: doc.fast,
      ctx: doc.ctx,
      keys: aliasKeys(doc.base),
      input,
      cacheWrite: parsePriceCell(cells[3]),
      cacheRead: parsePriceCell(cells[4]),
      output: parsePriceCell(cells[5]),
      fastMult: /2x pricing|\bat 2x\b|2x price/i.test(String(cells[6] || "")) ? 2 : null,
    });
  }
  return rows;
}

export function indexPrices(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const key of row.keys) {
      const id = `${row.ctx}|${row.fast ? "fast" : "std"}|${key}`;
      if (!map.has(id)) map.set(id, row);
    }
  }
  return map;
}

function scalePrice(row, mult) {
  const scale = (n) => (n == null ? null : n * mult);
  return {
    ...row,
    fast: true,
    input: scale(row.input),
    cacheWrite: scale(row.cacheWrite),
    cacheRead: scale(row.cacheRead),
    output: scale(row.output),
  };
}

export function lookupPrice(index, intent) {
  if (!index) return null;
  const parsed = usageBase(intent);
  if (!parsed) return null;
  for (const key of aliasKeys(parsed.base)) {
    const hit = index.get(`${parsed.ctx}|${parsed.fast ? "fast" : "std"}|${key}`);
    if (hit) return hit;
  }
  if (!parsed.fast) return null;
  for (const key of aliasKeys(parsed.base)) {
    const standard = index.get(`${parsed.ctx}|std|${key}`);
    if (standard?.fastMult) return scalePrice(standard, standard.fastMult);
  }
  return null;
}

export function estimateCents(model, price) {
  let dollars = 0;
  const items = [
    [model.input, price.input],
    [model.output, price.output],
    [model.cacheRead, price.cacheRead],
    [model.cacheWrite, price.cacheWrite],
  ];
  for (const [tokens, perMillion] of items) {
    if (!tokens || perMillion == null) continue;
    dollars += (tokens / 1e6) * perMillion;
  }
  return dollars * 100;
}

function fmtRate(n) {
  if (n == null) return "";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
}

function vsExpected(estCents, billedCents) {
  const delta = billedCents - estCents;
  const money = fmtMoney(Math.abs(delta));
  if (Math.abs(delta) < 0.5) return money;
  const share = billedCents ? (Math.abs(delta) / billedCents) * 100 : 0;
  const direction = delta < 0 ? "under" : "over";
  return `${money} ${direction} (${share.toFixed(1)}%)`;
}

export function modelDetail(model, priceIndex) {
  const price = lookupPrice(priceIndex, model.intent);
  const shown = [];
  if (model.input) shown.push(["in", model.input, price?.input]);
  if (model.output) shown.push(["out", model.output, price?.output]);
  if (model.cacheRead) shown.push(["read", model.cacheRead, price?.cacheRead]);
  if (model.cacheWrite) shown.push(["write", model.cacheWrite, price?.cacheWrite]);
  const visible = shown.reduce((sum, [, count]) => sum + count, 0);
  const lines = shown.map(([kind, count, rate]) => {
    const body = `${fmtTokens(count)} (${pct(count, visible)}%)`;
    const rateText = rate == null ? "" : ` · ${fmtRate(rate)}`;
    return { kind, text: `${body}${rateText}` };
  });
  lines.push({ kind: "paid", text: fmtMoney(model.cents) });
  if (price) lines.push({ kind: "vs expected", text: vsExpected(estimateCents(model, price), model.cents) });
  return {
    name: model.name,
    cents: model.cents,
    tokens: model.tokens,
    input: model.input,
    output: model.output,
    cache: model.cache,
    lines,
  };
}

export function onDemand(spend) {
  if (!spend) return null;
  const team = spend.limitType === "team" && spend.pooledLimit;
  const limit = Number(team ? spend.pooledLimit : spend.individualLimit);
  if (!limit) return null;
  const remaining = Number(team ? spend.pooledRemaining : spend.individualRemaining);
  const used = Number(team
    ? (spend.pooledUsed ?? spend.totalSpend ?? limit - (remaining || 0))
    : (spend.individualUsed ?? spend.totalSpend ?? limit - (remaining || 0)));
  return { used, limit, pct: (used / limit) * 100 };
}

export function assertPriceMap() {
  const md = [
    "| Model | Provider | Input | Cache write | Cache read | Output | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| Grok 4.6 | Cursor | $2 | - | $0.5 | $6 | |",
    "| Grok 4.6 (Fast) | Cursor | $4 | - | $1 | $12 | |",
    "| [Claude Opus 5](https://example.com) | Anthropic | $5 | $6.25 | $0.5 | $25 | |",
    "| Claude Opus 4.8 | Anthropic | $5 | $6.25 | $0.5 | $25 | |",
    "| [Claude 4.5 Sonnet](https://example.com) | Anthropic | $3 | $3.75 | $0.3 | $15 | |",
    "| [Composer 2.5 (Fast)](https://example.com) | Cursor | $3 | - | $0.5 | $15 | |",
    "| Claude Opus 5.5 | Anthropic | $4 | $5 | $0.2 | $20 | Fast mode is available at 2x pricing |",
    "| GPT-5.6 Sol | OpenAI | $4 | $5 | $0.4 | $20 | Fast mode is available at 2x pricing |",
  ].join("\n");
  const index = indexPrices(parsePricingMd(md));
  const cases = [
    ["cursor-grok-4.6-xhigh-fast", 4, 12],
    ["cursor-grok-4.6-xhigh", 2, 6],
    ["claude-opus-5-thinking-max", 5, 25],
    ["claude-4.5-sonnet", 3, 15],
    ["composer-2.5-fast", 3, 15],
    ["claude-opus-5-5-xhigh", 4, 20],
    ["gpt-5.6-sol-low-fast", 8, 40],
    ["default", null, null],
  ];
  for (const [id, input, output] of cases) {
    const price = lookupPrice(index, id);
    const ok = input == null ? price == null : price && price.input === input && price.output === output;
    if (!ok) throw new Error(`price map failed for ${id}`);
  }
  const cents = estimateCents(
    { input: 54305672, output: 3763437, cacheRead: 620404096, cacheWrite: 0 },
    { input: 2, output: 6, cacheRead: 0.5, cacheWrite: null },
  );
  if (Math.abs(cents - 44139.4014) > 0.02) throw new Error(`estimate failed: ${cents}`);
}
