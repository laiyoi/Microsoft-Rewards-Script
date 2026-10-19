import fs from 'fs/promises';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

type Account = {
  id?: string;
  cookie?: string;
  region?: string;
  proxyGroup?: string;
};

type RegionMap = Record<string, string>;

const CLASH_API = process.env.CLASH_API || 'http://192.168.1.1:9090';
const CLASH_SECRET = process.env.CLASH_SECRET || '';
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || './accounts.json';
const SUB_URL = process.env.MIHOMO_SUB || '';
const REGION_MAP_JSON = process.env.REGION_MAP || '{}';
const GROUP_PREFIX = process.env.GROUP_PREFIX || '微软服务-';

const regionMap: RegionMap = (() => {
  try {
    return JSON.parse(REGION_MAP_JSON);
  } catch (e) {
    console.warn('REGION_MAP is not valid JSON, falling back to empty map');
    return {};
  }
})();

function authHeaders() {
  if (!CLASH_SECRET) return {};
  // Some Clash/OpenClash setups expect Authorization: Bearer <secret>
  return { Authorization: `Bearer ${CLASH_SECRET}` };
}

async function fetchSubscription(subUrl: string): Promise<string[]> {
  const res = await axios.get(subUrl, { timeout: 15000 });
  const body = String(res.data).trim();

  // try base64 decode if looks like a base64 blob
  if (/^[A-Za-z0-9+/=\s]+$/.test(body) && body.length % 4 === 0 && body.length > 100) {
    try {
      const buf = Buffer.from(body, 'base64');
      const decoded = buf.toString('utf8').trim();
      return decoded.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch (e) {
      // not base64
    }
  }
  return body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function parseLineToAccount(line: string): Account {
  // Default: treat the whole line as cookie/token. Adjust if your subscription format differs.
  return { cookie: line };
}

async function loadAccounts(path: string): Promise<Account[]> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const a = JSON.parse(raw) as Account[];
    return a;
  } catch (e) {
    console.warn('accounts file not found or invalid, will build from subscription if available');
    if (SUB_URL) {
      const lines = await fetchSubscription(SUB_URL);
      return lines.map(parseLineToAccount);
    }
    return [];
  }
}

async function getRegionForAccount(account: Account): Promise<string | undefined> {
  // Best-effort inference:
  // 1) If account.region present, use it
  if (account.region) return account.region;

  // 2) Try to infer from cookie/token string
  const cookie = account.cookie || '';
  if (cookie.includes('region=cn')) return 'cn';
  if (cookie.includes('region=tw')) return 'tw';
  if (cookie.includes('region=os')) return 'os';
  if (cookie.includes('region=us')) return 'us';

  // 3) Unable to infer: caller can extend this to call mihomo/hoyolab APIs using the cookie
  return undefined;
}

async function getClashProxies(baseUrl: string) {
  const url = `${baseUrl.replace(/\/$/, '')}/proxies`;
  const res = await axios.get(url, { headers: { ...authHeaders() }, timeout: 5000 });
  return res.data;
}

async function setClashProxy(baseUrl: string, groupName: string, proxyName: string) {
  const url = `${baseUrl.replace(/\/$/, '')}/proxies/${encodeURIComponent(groupName)}`;
  await axios.put(url, { name: proxyName }, { headers: { 'Content-Type': 'application/json', ...authHeaders() }, timeout: 5000 });
}

export async function syncAccountsToClash(accounts: Account[]) {
  const proxies = await getClashProxies(CLASH_API);
  console.log('Fetched proxy groups from Clash.');

  for (const acct of accounts) {
    const region = await getRegionForAccount(acct);
    if (!region) {
      console.warn('Cannot determine region for account', acct.id || acct.cookie);
      continue;
    }
    const proxyName = regionMap[region];
    if (!proxyName) {
      console.warn(`No proxy mapping for region ${region} (account ${acct.id || acct.cookie})`);
      continue;
    }
    const groupName = acct.proxyGroup || (GROUP_PREFIX + (acct.id || acct.cookie?.slice(0, 8) || 'unknown'));

    // Ensure the group exists in Clash
    if (!proxies['proxy-groups'] && !proxies['Proxy']) {
      // some Clash versions return keys differently; try to find group by scanning
    }

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
        console.error('No accounts found. Please provide an accounts.json or set MIHOMO_SUB.');
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
