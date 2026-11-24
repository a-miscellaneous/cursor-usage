/**
 * Local monitor for a few Cursor accounts.
 * Keys stay in keys.json on this machine. The page never talks to Cursor itself.
 * Each key is exchanged the way T3 does, then the dashboard RPCs fill the HUD.
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPriceMap,
  bucketAggregations,
  fmtMoney,
  fmtResetLeft,
  fmtTokens,
  indexPrices,
  modelDetail,
  onDemand,
  parsePricingMd,
} from "./usage.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const keysPath = join(root, "keys.json");
// Compose publishes the port from outside the container, so the process must listen beyond loopback there.
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const cursorApi = "https://api2.cursor.sh";
const refreshMs = 8_000;

assertPriceMap();

let priceIndex = null;
let snapshot = { updatedAt: 0, accounts: [], error: "" };
let refreshing = null;
const tokens = new Map();

async function loadKeys() {
  try {
    const parsed = JSON.parse(await readFile(keysPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && typeof row.apiKey === "string" && row.apiKey.trim());
  } catch {
    return [];
  }
}

async function saveKeys(rows) {
  await mkdir(root, { recursive: true });
  await writeFile(keysPath, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
}

async function loadPrices() {
  const response = await fetch("https://cursor.com/docs/models-and-pricing.md");
  if (!response.ok) throw new Error(`prices ${response.status}`);
  priceIndex = indexPrices(parsePricingMd(await response.text()));
}

async function cursorRpc(token, method, body) {
  const response = await fetch(`${cursorApi}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "connect-protocol-version": "1",
      "x-cursor-client-type": "cli",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 180) };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json || {};
}

async function accountEmail(apiKey) {
  const exchanged = await accessToken(apiKey).catch(() => "");
  const bearers = exchanged && exchanged !== apiKey ? [apiKey, exchanged] : [apiKey];
  let last = "account lookup failed";
  for (const bearer of bearers) {
    const response = await fetch("https://api.cursor.com/v1/me", {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!response.ok) {
      last = `account ${response.status}`;
      continue;
    }
    const body = await response.json();
    const email = String(body.userEmail || body.email || "").trim();
    if (email.includes("@")) return email;
    last = "Cursor did not return an email for this key";
  }
  throw new Error(last);
}

async function accessToken(apiKey) {
  const hit = tokens.get(apiKey);
  if (hit && hit.until > Date.now()) return hit.token;
  const response = await fetch(`${cursorApi}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`exchange ${response.status}`);
  const body = await response.json();
  if (!body.accessToken) throw new Error("exchange returned no token");
  tokens.set(apiKey, { token: body.accessToken, until: Date.now() + 30 * 60_000 });
  return body.accessToken;
}

function aggregationList(body) {
  return body.aggregations
    || body.aggregatedUsageEvents
    || body.usageAggregations
    || [];
}

function sumField(bucket, field) {
  return (bucket.models || []).reduce((sum, model) => sum + Number(model[field] || 0), 0);
}

function bits(bucket) {
  const lines = [];
  const input = sumField(bucket, "input");
  const output = sumField(bucket, "output");
  const read = sumField(bucket, "cacheRead");
  const write = sumField(bucket, "cacheWrite");
  if (input) lines.push(`${fmtTokens(input)} in`);
  if (output) lines.push(`${fmtTokens(output)} out`);
  if (read) lines.push(`${fmtTokens(read)} read`);
  if (write) lines.push(`${fmtTokens(write)} write`);
  return lines;
}

function rowFor(key, label, percent, bucket) {
  const hasModels = bucket.models.length > 0;
  return {
    key,
    label,
    pct: Number.isFinite(percent) ? percent : null,
    money: hasModels || bucket.cents ? fmtMoney(bucket.cents) : "—",
    bits: bits(bucket),
    models: bucket.models.map((model) => modelDetail(model, priceIndex)),
  };
}

async function readAccount(entry) {
  const label = String(entry.label || "account").slice(0, 40);
  try {
    const token = await accessToken(entry.apiKey.trim());
    const period = await cursorRpc(token, "GetCurrentPeriodUsage", { includePooledUsage: true });
    let modelsError = "";
    let events = [];
    try {
      const aggregated = await cursorRpc(token, "GetAggregatedUsageEvents", {
        teamId: 0,
        startDate: period.billingCycleStart,
        endDate: period.billingCycleEnd,
      });
      events = aggregationList(aggregated);
    } catch (error) {
      modelsError = error.message || "model breakdown unavailable";
    }
    const buckets = bucketAggregations(events, period.autoBucketModels);
    const plan = period.planUsage || {};
    const demand = onDemand(period.spendLimitUsage);
    const rows = [
      rowFor("auto", "Cursor models", plan.autoPercentUsed, buckets.auto),
      rowFor("api", "API", plan.apiPercentUsed, buckets.api),
    ];
    if (demand) {
      rows.push({
        key: "od",
        label: "On-demand",
        pct: demand.pct,
        money: `${fmtMoney(demand.used)} / ${fmtMoney(demand.limit)}`,
        bits: [],
        models: [],
      });
    }
    return {
      label,
      reset: fmtResetLeft(period.billingCycleEnd),
      resetAt: endIso(period.billingCycleEnd),
      rows,
      modelsError,
      error: "",
    };
  } catch (error) {
    if (error.status === 401) tokens.delete(entry.apiKey.trim());
    return { label, reset: "", resetAt: "", rows: [], modelsError: "", error: error.message || "request failed" };
  }
}

function endIso(end) {
  const n = Number(end);
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const keys = await loadKeys();
    let labeled = false;
    for (const entry of keys) {
      if (String(entry.label || "").includes("@")) continue;
      try {
        entry.label = await accountEmail(entry.apiKey);
        labeled = true;
      } catch {
        // readAccount reports the failed key.
      }
    }
    if (labeled) await saveKeys(keys);
    if (!priceIndex) {
      try {
        await loadPrices();
      } catch (error) {
        snapshot = { ...snapshot, error: error.message || "price table failed" };
      }
    }
    const accounts = [];
    for (const entry of keys) accounts.push(await readAccount(entry));
    snapshot = { updatedAt: Date.now(), accounts, error: snapshot.error && priceIndex ? "" : snapshot.error };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function publicKeys(rows) {
  return rows.map((row) => ({
    label: row.label || "account",
    tail: String(row.apiKey).slice(-4),
  }));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  try {
    if (request.method === "GET" && url.pathname === "/api/usage") {
      if (!snapshot.updatedAt) await refresh();
      const keys = publicKeys(await loadKeys());
      send(response, 200, { ...snapshot, keys });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/keys") {
      const body = await readBody(request);
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) {
        send(response, 400, { error: "apiKey is required" });
        return;
      }
      let label;
      try {
        label = await accountEmail(apiKey);
      } catch (error) {
        const message = error.message === "account 401"
          ? "Cursor rejected this API key"
          : (error.message || "Could not read the account email");
        send(response, 400, { error: message });
        return;
      }
      const keys = await loadKeys();
      const next = keys.filter((row) => row.label !== label);
      next.push({ label, apiKey });
      await saveKeys(next);
      tokens.delete(apiKey);
      await refresh();
      send(response, 200, { keys: publicKeys(next) });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/keys") {
      const body = await readBody(request);
      const keys = (await loadKeys()).filter((row) => row.label !== body.label);
      await saveKeys(keys);
      await refresh();
      send(response, 200, { keys: publicKeys(keys) });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(root, "public", "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, 500, { error: error.message || "failed" });
  }
});

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

server.listen(port, host, () => {
  console.log(`cursor usage http://${host}:${port}`);
  refresh();
  setInterval(refresh, refreshMs);
});
