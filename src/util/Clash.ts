import { ensureEnvLoaded } from './Load'

/**
 * 按账户地区切换 Clash / mihomo 代理节点。
 *
 * 所有账户共用同一个 Clash 监听端口（ACCOUNT_N_PROXY_URL）时，脚本会在处理每个账户前
 * 调用 Clash 控制 API（PUT /proxies/{group}）把指定 selector 分组切换到该地区的节点。
 *
 * 相关 .env 配置：
 *   CLASH_API / CLASH_SECRET / CLASH_PROXY_GROUP / REGION_MAP
 *   CLASH_TIMEOUT_MS / CLASH_SWITCH_DELAY_MS / CLASH_VERIFY / CLASH_STRICT
 *   ACCOUNT_N_REGION / ACCOUNT_N_PROXY_GROUP（可选，按账户覆盖分组）
 */

export interface ClashConfig {
    /** 是否启用地区代理切换（默认由 CLASH_API 是否存在决定） */
    enabled: boolean
    /** Clash 控制 API 地址，例如 http://192.168.1.1:9090 */
    apiUrl: string
    /** Clash 控制 API 密钥（未设置则不发送 Authorization） */
    secret: string
    /** 默认 selector 分组名，例如 GLOBAL / 微软服务 */
    group: string
    /** 地区代码 -> 节点名。值为 DIRECT 表示直连；也支持逗号分隔的多个候选/关键字 */
    regionMap: Record<string, string>
    /** 地区代码 -> 节点名匹配关键字（内置别名 + REGION_KEYWORDS 合并） */
    regionAliases: Record<string, string[]>
    /** Clash API 请求超时（毫秒） */
    timeoutMs: number
    /** 切换后等待多久再校验/继续（毫秒） */
    switchDelayMs: number
    /** 切换后回读分组，确认已生效 */
    verify: boolean
    /** 切换失败时是否让该账户直接失败（默认仅告警并继续） */
    strict: boolean
}

export interface ClashSelection {
    region: string
    group: string
    node: string
    /** 切换前的节点，未设置时为空 */
    previous?: string
    /** false 表示当前已经是目标节点，无需调用切换 API */
    changed: boolean
    /** map = 命中 REGION_MAP 中的节点/关键字；keyword = 命中内置或自定义关键字 */
    matchedBy: 'map' | 'keyword'
}

/** applyRegionProxy 只需账号中的这几个字段，便于 CLI 与测试复用 */
export interface ClashAccount {
    email?: string
    region?: string
    proxyGroup?: string
}

interface ClashProxyInfo {
    name?: string
    type?: string
    now?: string
    all?: string[]
}

interface ClashProxiesResponse {
    proxies?: Record<string, ClashProxyInfo>
}

const DEFAULT_GROUP = 'GLOBAL'
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_SWITCH_DELAY_MS = 1000
const MAX_LISTED_OPTIONS = 30

/**
 * 内置地区关键字。节点名通常形如 "🇺🇸 美国W01"、"HK-01"、"香港节点"，
 * 因此同时收录国家/地区代码、英文名和简繁中文名，匹配时忽略大小写。
 * 可通过 REGION_KEYWORDS 追加以适配自定义节点命名。
 */
const REGION_ALIASES: Record<string, string[]> = {
    cn: [
        'cn',
        'china',
        '中国',
        '中國',
        '中国大陆',
        '中國大陸',
        '大陆',
        '大陸',
        '国内',
        '國內',
        '直连',
        '直連',
        '全球直连',
        '全球直連',
        'direct'
    ],
    us: [
        'us',
        'usa',
        'u.s.',
        'united states',
        'united states of america',
        'america',
        '美国',
        '美國',
        '美服',
        '美区',
        '美區',
        '北美',
        'na',
        'north america'
    ],
    hk: ['hk', 'hkg', 'hong kong', 'hongkong', '香港', '港', '深港'],
    jp: ['jp', 'jpn', 'japan', '日本', '东京', '東京'],
    kr: ['kr', 'kor', 'korea', 'south korea', '韩国', '韓國', '南韩', '南韓', '首尔', '首爾'],
    tw: ['tw', 'twn', 'taiwan', '台湾', '臺灣', '台北'],
    sg: ['sg', 'sgp', 'singapore', '新加坡', '狮城', '獅城'],
    gb: ['gb', 'uk', 'united kingdom', 'great britain', 'britain', 'england', '英国', '英國', '伦敦', '倫敦'],
    de: ['de', 'germany', '德国', '德國', '法兰克福', '法蘭克福'],
    fr: ['fr', 'france', '法国', '法國', '巴黎'],
    nl: ['nl', 'netherlands', 'holland', '荷兰', '荷蘭'],
    ca: ['ca', 'canada', '加拿大', '多伦多', '多倫多'],
    au: ['au', 'aus', 'australia', '澳大利亚', '澳洲', '澳大利亞'],
    ru: ['ru', 'russia', '俄罗斯', '俄羅斯'],
    tr: ['tr', 'turkey', 'turkiye', 'türkiye', '土耳其'],
    in: ['in', 'ind', 'india', '印度', '孟买', '孟買'],
    br: ['br', 'brazil', '巴西'],
    ar: ['ar', 'argentina', '阿根廷'],
    ua: ['ua', 'ukraine', '乌克兰', '烏克蘭'],
    vn: ['vn', 'vietnam', 'viet nam', '越南'],
    os: ['os', 'overseas', '海外', '国际', '國際']
}

let cachedConfig: ClashConfig | undefined

function envValue(key: string): string | undefined {
    const value = process.env[key]
    if (value === undefined) return undefined
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
}

function envBool(key: string, fallback: boolean): boolean {
    const value = envValue(key)
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function envInt(key: string, fallback: number): number {
    const value = envValue(key)
    if (value === undefined) return fallback
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseRegionMap(raw: string | undefined): Record<string, string> {
    if (!raw) return {}

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        throw new Error(
            `REGION_MAP 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。` +
                '示例: REGION_MAP={"cn":"DIRECT","us":"US-Node"}'
        )
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('REGION_MAP 必须是 JSON 对象，例如 {"cn":"DIRECT","us":"US-Node"}')
    }

    const map: Record<string, string> = {}
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
        if (typeof rawValue !== 'string') continue
        const key = rawKey.trim().toLowerCase()
        const value = rawValue.trim()
        if (key && value) map[key] = value
    }
    return map
}

function parseRegionKeywords(raw: string | undefined): Record<string, string[]> {
    if (!raw) return {}

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        throw new Error(
            `REGION_KEYWORDS 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。` +
                '示例: REGION_KEYWORDS={"us":["美国","USA"],"hk":["香港","Hong Kong"]}'
        )
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('REGION_KEYWORDS 必须是 JSON 对象，例如 {"us":["美国","USA"]}')
    }

    const map: Record<string, string[]> = {}
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
        const key = rawKey.trim().toLowerCase()
        if (!key) continue

        let values: unknown[]
        if (Array.isArray(rawValue)) values = rawValue
        else if (typeof rawValue === 'string') values = rawValue.split(',')
        else continue

        const keywords = values
            .filter((value): value is string => typeof value === 'string')
            .map(value => value.trim())
            .filter(Boolean)
        if (keywords.length) map[key] = keywords
    }
    return map
}

function buildRegionAliases(custom: Record<string, string[]>): Record<string, string[]> {
    const merged: Record<string, string[]> = {}
    for (const [region, keywords] of Object.entries(REGION_ALIASES)) {
        merged[region] = [...keywords]
    }
    for (const [region, keywords] of Object.entries(custom)) {
        merged[region] = [...new Set([...(merged[region] ?? []), ...keywords])]
    }
    return merged
}

export function getClashConfig(): ClashConfig {
    if (cachedConfig) return cachedConfig

    const apiUrl = (envValue('CLASH_API') ?? '').replace(/\/+$/, '')
    const enabled = envBool('CLASH_ENABLED', apiUrl.length > 0)

    if (enabled && !apiUrl) {
        throw new Error('CLASH_ENABLED=true 但未配置 CLASH_API（例如 CLASH_API=http://192.168.1.1:9090）')
    }

    if (apiUrl) {
        try {
            new URL(apiUrl)
        } catch {
            throw new Error(`CLASH_API 不是合法 URL: ${apiUrl}（示例: http://192.168.1.1:9090）`)
        }
    }

    const customKeywords = enabled ? parseRegionKeywords(envValue('REGION_KEYWORDS')) : {}

    cachedConfig = {
        enabled,
        apiUrl,
        secret: envValue('CLASH_SECRET') ?? '',
        group: envValue('CLASH_PROXY_GROUP') ?? DEFAULT_GROUP,
        regionMap: enabled ? parseRegionMap(envValue('REGION_MAP')) : {},
        regionAliases: buildRegionAliases(customKeywords),
        timeoutMs: Math.max(1, envInt('CLASH_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)),
        switchDelayMs: envInt('CLASH_SWITCH_DELAY_MS', DEFAULT_SWITCH_DELAY_MS),
        verify: envBool('CLASH_VERIFY', true),
        strict: envBool('CLASH_STRICT', false)
    }

    return cachedConfig
}

function proxyGroupForAccount(account: ClashAccount, config: ClashConfig): string {
    const group = account.proxyGroup?.trim()
    return group && group.length > 0 ? group : config.group
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 归一化分组名：忽略大小写、emoji、空格和标点，只保留文字/数字。
 * 例如 "Ⓜ️ 微软服务" -> "微软服务"、"🚀 手动切换" -> "手动切换"。
 */
function normalizeGroupName(name: string): string {
    return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 查找分组：
 * 1. 原始名称精确匹配
 * 2. 忽略大小写精确匹配
 * 3. 弱匹配：去 emoji/空格/标点后，按完全相等 > 前缀 > 后缀 > 包含打分，
 *    因此 CLASH_PROXY_GROUP=微软服务 也能命中 "Ⓜ️ 微软服务"。
 */
function findGroup(proxies: Record<string, ClashProxyInfo>, name: string): ClashProxyInfo | undefined {
    const exact = proxies[name]
    if (exact) return exact

    const match = Object.keys(proxies).find(key => key.toLowerCase() === name.toLowerCase())
    if (match) return proxies[match]

    const target = normalizeGroupName(name)
    if (!target) return undefined

    let best: { info: ClashProxyInfo; score: number; length: number } | undefined

    for (const [groupName, info] of Object.entries(proxies)) {
        if (!Array.isArray(info.all) || info.all.length === 0) continue

        const candidate = normalizeGroupName(groupName)
        if (!candidate) continue

        let score = 0
        if (candidate === target) score = 10000
        else if (candidate.startsWith(target)) score = 5000 + target.length
        else if (candidate.endsWith(target)) score = 4000 + target.length
        else if (candidate.includes(target)) score = 3000 + target.length
        else if (target.includes(candidate)) score = 2000 + candidate.length

        if (score === 0) continue

        // 同分时优先更短的分组名，避免命中 "微软服务备用" 之类
        if (!best || score > best.score || (score === best.score && groupName.length < best.length)) {
            best = { info, score, length: groupName.length }
        }
    }

    return best?.info
}

function listGroupNames(proxies: Record<string, ClashProxyInfo>): string {
    const names = Object.entries(proxies)
        .filter(([, info]) => Array.isArray(info.all) && info.all.length > 0)
        .map(([name]) => name)

    if (!names.length) return '（无 selector 分组）'
    const shown = names.slice(0, MAX_LISTED_OPTIONS).join(', ')
    return names.length > MAX_LISTED_OPTIONS ? `${shown} …（共 ${names.length} 个）` : shown
}

function listNodes(options: string[]): string {
    if (!options.length) return '（分组未返回节点列表）'
    const shown = options.slice(0, MAX_LISTED_OPTIONS).join(', ')
    return options.length > MAX_LISTED_OPTIONS ? `${shown} …（共 ${options.length} 个）` : shown
}

function findExactNode(target: string, options: string[]): string | undefined {
    const exact = options.find(option => option === target)
    if (exact) return exact

    const insensitive = options.find(option => option.toLowerCase() === target.toLowerCase())
    if (insensitive) return insensitive

    const upper = target.toUpperCase()
    if (upper === 'DIRECT' || upper === 'REJECT') {
        return options.find(option => option.toUpperCase() === upper)
    }

    return undefined
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 计算关键字的匹配得分：
 * - 节点名与关键字完全一致：最高分
 * - ASCII 关键字按"非字母"边界匹配：us 命中 "US01"/"US-Node"/"🇺🇸 US"，
 *   但不会误中 "Russia"/"Australia"；ca 同理不会误中 "Canada"（由 canada 关键字命中）
 * - 中文关键字按子串匹配（如 "美国" 命中 "🇺🇸 美国W01"）
 * - 关键字越长、越靠前，得分越高
 */
function keywordScore(name: string, keyword: string): number {
    const lowerName = name.toLowerCase()
    const lowerKeyword = keyword.toLowerCase()
    if (!lowerKeyword) return 0
    if (lowerName === lowerKeyword) return 10000

    let index: number
    if (/^[\x20-\x7e]+$/.test(lowerKeyword)) {
        const pattern = new RegExp(`(^|[^a-z])${escapeRegExp(lowerKeyword)}(?=$|[^a-z])`)
        const match = pattern.exec(lowerName)
        if (!match) return 0
        index = match.index + (match[1]?.length ?? 0)
    } else {
        index = lowerName.indexOf(lowerKeyword)
        if (index < 0) return 0
    }

    return 1000 + lowerKeyword.length * 10 + (index === 0 ? 100 : 0)
}

function findKeywordNode(keywords: string[], options: string[]): string | undefined {
    let best: { node: string; score: number } | undefined

    for (const option of options) {
        for (const keyword of keywords) {
            const score = keywordScore(option, keyword)
            if (score > 0 && (!best || score > best.score)) best = { node: option, score }
        }
    }

    return best?.node
}

function splitTargets(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
}

interface NodeMatch {
    node: string
    matchedBy: 'map' | 'keyword'
}

/**
 * 解析地区对应节点：
 * 1. REGION_MAP 的完整值先按节点名精确匹配（保留节点名内含逗号的情况）
 * 2. REGION_MAP 中以逗号分隔的候选逐个精确匹配
 * 3. 用 REGION_MAP 候选 + 内置/自定义关键字做模糊匹配（支持"美国"/"US"等）
 * 4. 分组未返回节点列表（all 为空）时按原样提交，交由 Clash 校验
 */
function resolveNode(
    region: string,
    mapped: string | undefined,
    options: string[],
    aliases: Record<string, string[]>
): NodeMatch | undefined {
    const mappedValue = mapped?.trim()
    if (mappedValue) {
        const exact = findExactNode(mappedValue, options)
        if (exact) return { node: exact, matchedBy: 'map' }
    }

    const mapTargets = splitTargets(mappedValue)
    for (const target of mapTargets) {
        const exact = findExactNode(target, options)
        if (exact) return { node: exact, matchedBy: 'map' }
    }

    const mappedKeywordNode = findKeywordNode(mapTargets, options)
    if (mappedKeywordNode) return { node: mappedKeywordNode, matchedBy: 'map' }

    const keywordNode = findKeywordNode(aliases[region] ?? [], options)
    if (keywordNode) return { node: keywordNode, matchedBy: 'keyword' }

    if (!options.length) {
        return { node: mapTargets[0] ?? region, matchedBy: mapTargets.length ? 'map' : 'keyword' }
    }

    return undefined
}

async function clashRequest<T>(
    config: ClashConfig,
    path: string,
    init: { method?: string; body?: unknown } = {}
): Promise<T> {
    const url = `${config.apiUrl}${path}`
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'microsoft-rewards-script'
    }
    if (config.secret) headers.Authorization = `Bearer ${config.secret}`

    let body: string | undefined
    if (init.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(init.body)
    }

    let response: Response
    try {
        response = await fetch(url, {
            method: init.method ?? 'GET',
            headers,
            body,
            signal: AbortSignal.timeout(config.timeoutMs)
        })
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`无法连接 Clash API（${url}，超时 ${config.timeoutMs}ms）: ${reason}`)
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
            `Clash API ${init.method ?? 'GET'} ${path} 返回 ${response.status} ${response.statusText}` +
                (detail ? `: ${detail.slice(0, 200)}` : '')
        )
    }

    const text = await response.text()
    if (!text) return undefined as unknown as T

    try {
        return JSON.parse(text) as T
    } catch {
        throw new Error(`Clash API ${path} 返回了非 JSON 内容: ${text.slice(0, 120)}`)
    }
}

async function fetchProxies(config: ClashConfig): Promise<Record<string, ClashProxyInfo>> {
    const data = await clashRequest<ClashProxiesResponse>(config, '/proxies')
    if (!data?.proxies) throw new Error('Clash API /proxies 返回格式异常，请确认 CLASH_API 指向 mihomo/Clash 控制端口')
    return data.proxies
}

async function selectNode(config: ClashConfig, group: string, node: string): Promise<void> {
    await clashRequest(config, `/proxies/${encodeURIComponent(group)}`, {
        method: 'PUT',
        body: { name: node }
    })
}

/**
 * 将账户对应的 selector 分组切换到其地区节点。
 * 未配置 region、或未启用 Clash 时返回 undefined。
 */
export async function applyRegionProxy(
    account: ClashAccount,
    config: ClashConfig = getClashConfig(),
    opts: { dryRun?: boolean } = {}
): Promise<ClashSelection | undefined> {
    const region = account.region?.trim().toLowerCase()
    if (!region) return undefined
    if (!config.enabled) return undefined

    const requestedGroup = proxyGroupForAccount(account, config)
    const proxies = await fetchProxies(config)
    const groupInfo = findGroup(proxies, requestedGroup)
    if (!groupInfo) {
        throw new Error(`未找到 Clash 代理分组 "${requestedGroup}"。可用分组: ${listGroupNames(proxies)}`)
    }

    // findGroup 支持弱匹配，这里回查实际分组名，PUT 和日志都使用真实名称
    const group = Object.keys(proxies).find(key => proxies[key] === groupInfo) ?? requestedGroup

    if (groupInfo.type && groupInfo.type !== 'Selector') {
        throw new Error(`Clash 分组 "${group}" 的类型是 "${groupInfo.type}"，只有 Selector 分组可以手动切换节点`)
    }

    const options = Array.isArray(groupInfo.all) ? groupInfo.all : []
    const mapped = config.regionMap[region]
    const match = resolveNode(region, mapped, options, config.regionAliases)
    if (!match) {
        const target = mapped ?? region
        throw new Error(
            `Clash 分组 "${group}" 中没有地区 "${region}" 对应的节点（候选: ${target}）。可用节点: ${listNodes(options)}`
        )
    }

    const { node, matchedBy } = match
    const previous = groupInfo.now
    if (previous === node) {
        return { region, group, node, previous, changed: false, matchedBy }
    }
    if (opts.dryRun) {
        return { region, group, node, previous, changed: true, matchedBy }
    }

    await selectNode(config, group, node)

    if (config.switchDelayMs > 0) await sleep(config.switchDelayMs)

    if (config.verify) {
        const after = await fetchProxies(config)
        const actual = findGroup(after, group)?.now
        if (actual !== node) {
            throw new Error(
                `Clash 代理切换未生效：分组 "${group}" 当前节点为 "${actual ?? '未知'}"，期望 "${node}"。` +
                    '请确认分组是可手动选择的 selector，且 Clash API 有写入权限'
            )
        }
    }

    return { region, group, node, previous, changed: true, matchedBy }
}

async function runCli(): Promise<void> {
    ensureEnvLoaded()

    const args = process.argv.slice(2)
    const usage = `用法:
  node dist/util/Clash.js --list                          # 查看分组与当前节点
  node dist/util/Clash.js <region> [--group G] [--dry-run]  # 切换地区节点，例如 us / hk / cn
  node dist/util/Clash.js <region> --group G --dry-run      # 只解析节点，不实际切换`

    if (args.includes('--help') || args.includes('-h')) {
        console.log(usage)
        return
    }

    const groupIndex = args.findIndex(arg => arg === '--group' || arg === '-g')
    const groupOverride = groupIndex >= 0 ? args[groupIndex + 1] : undefined
    if (groupIndex >= 0 && (!groupOverride || groupOverride.startsWith('-'))) {
        throw new Error(`--group 需要分组名。\n${usage}`)
    }

    const config = getClashConfig()
    if (!config.enabled) {
        throw new Error('Clash 地区代理未启用：请在 .env 中设置 CLASH_API（或 CLASH_ENABLED=true）')
    }

    if (args.includes('--list') || args.includes('-l')) {
        const proxies = await fetchProxies(config)
        const groups = Object.entries(proxies).filter(([, info]) => Array.isArray(info.all) && info.all.length > 0)
        if (!groups.length) {
            console.log('未找到 selector 分组')
            return
        }
        for (const [name, info] of groups) {
            console.log(
                `${name} | type=${info.type ?? 'unknown'} | now=${info.now ?? '未选择'} | nodes=${info.all?.length ?? 0}`
            )
        }
        return
    }

    const groupOverrideIndex = groupIndex >= 0 ? groupIndex + 1 : -1
    const region = args.find((arg, index) => !arg.startsWith('-') && index !== groupOverrideIndex)
    if (!region) throw new Error(usage)

    const dryRun = args.includes('--dry-run') || args.includes('-n')
    const selection = await applyRegionProxy({ region, proxyGroup: groupOverride }, config, { dryRun })
    if (!selection) {
        console.log(`地区 "${region}" 未配置 proxyGroup，已跳过`)
        return
    }

    const matchSource = selection.matchedBy === 'map' ? '映射' : '关键字'
    const prefix = dryRun ? '[dry-run] 将切换: ' : '已切换: '
    console.log(
        selection.changed
            ? `${prefix}分组 "${selection.group}" | 地区 "${selection.region}" | ${selection.previous ?? '未设置'} -> ${selection.node} | 匹配: ${matchSource}`
            : `已是目标节点: 分组 "${selection.group}" | 地区 "${selection.region}" | ${selection.node} | 匹配: ${matchSource}`
    )
}

if (require.main === module) {
    runCli().catch(error => {
        console.error(`[clash] ERROR: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
    })
}
