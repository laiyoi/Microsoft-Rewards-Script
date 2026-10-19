import fs from 'fs/promises';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

type Account = {
  id?: string;
  cookie?: string;
  region?: string;
  proxyGroup?: string;
  panelUrl?: string; // optional: URL to the mihomo control panel for detection
};

type RegionMap = Record<string, string>;

type RegionKeywords = Record<string, string[]>;

const CLASH_API = process.env.CLASH_API || 'http://192.168.1.1:9090';
const CLASH_SECRET = process.env.CLASH_SECRET || '';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || './accounts.json';
const REGION_MAP_JSON = process.env.REGION_MAP || '{}';
const REGION_KEYWORDS_JSON = process.env.REGION_KEYWORDS || '{}';
const GROUP_PREFIX = process.env.GROUP_PREFIX || '微软服务-';
const HTTP_TIMEOUT = Number(process.env.HTTP_TIMEOUT || 5000);

const regionMap: RegionMap = (() => {
  try {
    return JSON.parse(REGION_MAP_JSON);
  } catch (e) {
    console.warn('REGION_MAP is not valid JSON, falling back to empty map');
    return {};
  }
})();

const regionKeywords: RegionKeywords = (() => {
  try {
    return JSON.parse(REGION_KEYWORDS_JSON);
  } catch (e) {
    console.warn('REGION_KEYWORDS is not valid JSON, falling back to empty map');
    return {};
  }
})();

function authHeaders() {
  if (!CLASH_SECRET) return {};
  return { Authorization: `Bearer ${CLASH_SECRET}` };
}

async function loadAccountsFromFile(path: string): Promise<Account[]> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const a = JSON.parse(raw) as Account[];
    return a;
  } catch (e) {
    // file not found or invalid
    return [];
  }
}

function parseAccountLine(line: string): Account | null {
  // line example: "id=acct1;cookie=ltoken=xxx;region=cn;proxyGroup=微软服务-acct1;panelUrl=http://..."
  const parts = line.split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const acct: Account = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim();
    const val = p.slice(eq + 1).trim();
    if (!key) continue;
    switch (key) {
      case 'id': acct.id = val; break;
      case 'cookie': acct.cookie = val; break;
      case 'region': acct.region = val; break;
      case 'proxyGroup': acct.proxyGroup = val; break;
      case 'panelUrl': acct.panelUrl = val; break;
      default:
        // ignore unknown
        break;
    }
  }
  return acct;
}

function loadAccountsFromEnv(): Account[] {
  const accsEnv = process.env.ACCOUNTS; // multiline string with entries separated by \n
  const accounts: Account[] = [];
  if (accsEnv) {
    // support entries separated by literal newlines or '\\n' when embedded in .env single line
    const normalized = accsEnv.replace(/\\r/g, '').split(/\r?\n/).flatMap(s => s.split(/\|/));
    for (const lineRaw of normalized) {
      const line = lineRaw.trim();
      if (!line) continue;
      const acct = parseAccountLine(line);
      if (acct) accounts.push(acct);
    }
  }

  // also support multiple single ACCOUNT_1, ACCOUNT_2 ... env variables
  const envKeys = Object.keys(process.env).filter(k => /^ACCOUNT_\d+$/i.test(k));
  envKeys.sort();
  for (const k of envKeys) {
    const acct = parseAccountLine(process.env[k] as string);
    if (acct) accounts.push(acct);
  }

  return accounts;
}

async function loadAccounts(): Promise<Account[]> {
  // Priority: ACCOUNTS env / ACCOUNT_\d+ env -> ACCOUNTS_FILE
  const envAccounts = loadAccountsFromEnv();
  if (envAccounts.length > 0) return envAccounts;

  const fileAccounts = await loadAccountsFromFile(ACCOUNTS_FILE);
  return fileAccounts;
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await axios.get(url, { timeout: HTTP_TIMEOUT, headers: { 'User-Agent': 'region-sync/1.0' } });
    return String(res.data || '');
  } catch (e) {
    return undefined;
  }
}

function detectRegionFromText(body: string): string | undefined {
  const txt = body.toLowerCase();
  for (const [region, keywords] of Object.entries(regionKeywords)) {
    for (const kw of keywords) {
      const k = kw.toLowerCase();
      if (k && txt.includes(k)) return region;
    }
  }
  return undefined;
}

async function getRegionForAccount(account: Account): Promise<string | undefined> {
  if (account.region) return account.region;
  if (account.panelUrl) {
    const body = await fetchText(account.panelUrl);
    if (body) {
      const r = detectRegionFromText(body);
      if (r) return r;
    }
  }

  const cookie = account.cookie || '';
  const lower = cookie.toLowerCase();
  if (lower.includes('region=cn') || lower.includes('region=china') || lower.includes('china') || lower.includes('中华人民共和国') || lower.includes('cn')) return 'cn';
  if (lower.includes('region=tw') || lower.includes('taiwan') || lower.includes('台湾') || lower.includes('tw')) return 'tw';
  if (lower.includes('region=os') || lower.includes('overseas') || lower.includes('os') || lower.includes('海外')) return 'os';
  if (lower.includes('region=us') || lower.includes('usa') || lower.includes('america') || lower.includes('us') || lower.includes('美服') || lower.includes('美国')) return 'us';
  if (lower.includes('hk') || lower.includes('hongkong') || lower.includes('香港')) return 'hk';
  if (lower.includes('jp') || lower.includes('japan') || lower.includes('日本')) return 'jp';
  if (lower.includes('kr') || lower.includes('korea') || lower.includes('韩国')) return 'kr';

  return undefined;
}

async function getClashProxies(baseUrl: string) {
  const url = `${baseUrl.replace(/\/$/, '')}/proxies`;
  const res = await axios.get(url, { headers: { ...authHeaders() }, timeout: HTTP_TIMEOUT });
  return res.data;
}

async function setClashProxy(baseUrl: string, groupName: string, proxyName: string) {
  const url = `${baseUrl.replace(/\/$/, '')}/proxies/${encodeURIComponent(groupName)}`;
  await axios.put(url, { name: proxyName }, { headers: { 'Content-Type': 'application/json', ...authHeaders() }, timeout: HTTP_TIMEOUT });
}

export async function syncAccountsToClash(accounts: Account[]) {
  const proxies = await getClashProxies(CLASH_API);
  console.log('Fetched proxy groups from Clash.');

  for (const acct of accounts) {
    const region = await getRegionForAccount(acct);
    if (!region) {
      console.warn('Cannot determine region for account', acct.id || acct.cookie?.slice(0, 8));
      continue;
    }

    const proxyName = regionMap[region];
    if (!proxyName) {
      console.warn(`No proxy mapping for region ${region} (account ${acct.id || acct.cookie?.slice(0, 8)})`);
      continue;
    }

    if (proxyName === 'DIRECT') {
      console.log(`Account ${acct.id || acct.cookie?.slice(0, 8)} region ${region} uses direct connection (no proxy)`);
      continue;
    }

    const groupName = acct.proxyGroup || (GROUP_PREFIX + (acct.id || acct.cookie?.slice(0, 8) || 'unknown'));

    try {
      await setClashProxy(CLASH_API, groupName, proxyName);
      console.log(`Set group ${groupName} -> ${proxyName} for account ${acct.id || acct.cookie?.slice(0, 8)}`);
    } catch (e: any) {
      console.error('Failed to set proxy for group', groupName, e.message || e);
    }
  }
}

if (require.main === module) {
  (async () => {
    try {
      const accounts = await loadAccounts();
      if (accounts.length === 0) {
        console.error('No accounts found. Provide ACCOUNTS env or ACCOUNTS_FILE pointing to a JSON file.');
        process.exit(2);
      }
      await syncAccountsToClash(accounts);
      console.log('Sync finished.');
    } catch (e) {
      console.error('Error', e);
      process.exit(1);
    }
  })();
}
