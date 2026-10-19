export interface Account {
    email: string
    password: string
    totpSecret?: string
    recoveryEmail: string
    geoLocale: string
    /** Clash 地区代码（如 us / hk / cn）；设置后处理该账户前会切换代理节点 */
    region?: string
    /** 可选的 Clash selector 分组名，覆盖全局 CLASH_PROXY_GROUP */
    proxyGroup?: string
    langCode: string
    proxy: AccountProxy
    saveFingerprint: ConfigSaveFingerprint
}

export interface AccountProxy {
    proxyHttp: boolean
    url: string
    port: number
    password: string
    username: string
}

export interface ConfigSaveFingerprint {
    mobile: boolean
    desktop: boolean
}
