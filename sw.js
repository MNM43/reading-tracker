/*
 * Ink Drinker 离线服务进程（Service Worker）
 *
 * 目标：页面成功加载过一次后，即使 GitHub Pages 慢/不可达，
 *       再次打开也能秒开并完整可用（数据本就存 localStorage）。
 *
 * 策略：
 * - 同源导航（index.html）：网络优先（3.5s 超时）→ 缓存兜底 → 兜底到缓存的首页
 * - 同源静态资源（带 hash 的 js/css 等）：缓存优先，未命中才走网络并写缓存
 * - 跨域图片（书籍封面）：缓存优先 + 后台更新（stale-while-revalidate）
 * - 跨域 API（Gist 同步等）：完全不拦截，交由应用自身处理失败与提示
 * - 新版本：发 SKIP_WAITING 后立即接管；页面会提示「刷新即可更新」
 */
const VERSION = 'v1'
// 缓存指纹由构建脚本（scripts/patch-sw.mjs）按产物内容注入，每次部署自动换代
const ASSET_HASH = '70243d9f15'
const SHELL_CACHE = `inkdrinker-shell-${ASSET_HASH}`
const RUNTIME_CACHE = `inkdrinker-runtime-${ASSET_HASH}`
const NAV_TIMEOUT = 3500

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
    './assets/index-BdQ4BHNr.css',
  './assets/index-D8AySr2O.js',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('inkdrinker-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

function timeoutFetch(request, ms) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      ctrl.abort()
      reject(new Error('timeout'))
    }, ms)
    fetch(request, { signal: ctrl.signal })
      .then((res) => {
        clearTimeout(timer)
        resolve(res)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const fresh = await timeoutFetch(request, NAV_TIMEOUT)
    cache.put('./index.html', fresh.clone()).catch(() => {})
    return fresh
  } catch {
    const cached =
      (await cache.match(request, { ignoreVary: true })) ||
      (await cache.match('./index.html', { ignoreVary: true }))
    if (cached) return cached
    return new Response('离线且无缓存', { status: 503, statusText: 'offline' })
  }
}

async function handleSameOriginAsset(request) {
  // ignoreVary：预缓存与页面请求的头可能不同（如 Accept-Encoding），按 URL 匹配即可
  const cached = await caches.match(request, { ignoreVary: true })
  if (cached) return cached
  try {
    const res = await fetch(request)
    if (res && res.ok) {
      const cache = await caches.open(RUNTIME_CACHE)
      cache.put(request, res.clone()).catch(() => {})
    }
    return res
  } catch {
    // 网络不可达且未预缓存（理论上构建期已预缓存全部核心产物），给出明确失败
    return new Response('', { status: 504, statusText: 'offline' })
  }
}

async function handleImage(request) {
  const cached = await caches.match(request, { ignoreVary: true })
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) {
        caches.open(RUNTIME_CACHE).then((c) => c.put(request, res.clone()).catch(() => {}))
      }
      return res
    })
    .catch(() => null)
  if (cached) {
    if (0) network.catch(() => {})
    return cached
  }
  const fresh = await network
  return (
    fresh || new Response('', { status: 504, statusText: 'unreachable' })
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  // 跨域：同步 API 绝不拦截；封面图片做缓存优先后台更新
  if (url.origin !== self.location.origin) {
    if (request.destination === 'image') {
      event.respondWith(handleImage(request))
    }
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }
  event.respondWith(handleSameOriginAsset(request))
})
