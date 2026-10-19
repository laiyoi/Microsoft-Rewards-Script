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

async function loadAccounts(path: string): Promise<Account[]> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const a = JSON.parse(raw) as Account[];
    return a;
  } catch (e) {
    console.error('accounts file not found or invalid at', path);
    return [];
  }
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await axios.get(url, { timeout: HTTP_TIMEOUT, headers: { 'User-Agent': 'region-sync/1.0' } });
    return String(res.data || '');
  } catch (e) {
    // console.warn('Failed to fetch', url, e.message || e);
    return undefined;
  }
}

function detectRegionFromText(body: string): string | undefined {
  const txt = body.toLowerCase();
  for (const [region, keywords] of Object.entries(regionKeywords)) {
    for (const kw of keywords) {
      const k = kw.toLowerCase();
      if (k && txt.includes(k)) return region;
      // also match with non-ascii variants removed to be forgiving
    }
  }
  return undefined;
}

async function getRegionForAccount(account: Account): Promise<string | undefined> {
  // 1) explicit in accounts.json
  if (account.region) return account.region;

  // 2) try to detect from panelUrl if provided
  if (account.panelUrl) {
    const body = await fetchText(account.panelUrl);
    if (body) {
      const r = detectRegionFromText(body);
      if (r) return r;
    }
  }

  // 3) try to infer from cookie/token string (best-effort)
  const cookie = account.cookie || '';
  const lower = cookie.toLowerCase();
  if (lower.includes('region=cn') || lower.includes('region=china') || lower.includes('china') || lower.includes('cn')) return 'cn';
  if (lower.includes('region=tw') || lower.includes('taiwan') || lower.includes('tw')) return 'tw';
  if (lower.includes('region=os') || lower.includes('overseas') || lower.includes('os')) return 'os';
  if (lower.includes('region=us') || lower.includes('usa') || lower.includes('america') || lower.includes('us')) return 'us';
  if (lower.includes('hk') || lower.includes('hongkong') || lower.includes('香港')) return 'hk';
  if (lower.includes('jp') || lower.includes('japan') || lower.includes('日本')) return 'jp';
  if (lower.includes('kr') || lower.includes('korea') || lower.includes('韩国')) return 'kr';

  // 4) give up
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

    // For CN use DIRECT (no proxy) if REGION_MAP maps to 'DIRECT'
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
      const accounts = await loadAccounts(ACCOUNTS_FILE);
      if (accounts.length === 0) {
        console.error('No accounts found. Please provide an accounts.json in', ACCOUNTS_FILE);
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
