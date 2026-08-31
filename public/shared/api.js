// HTML 파일을 직접 열면 /api 요청을 사용할 수 없으므로 실행 중인 로컬 앱으로 연결한다.
if (window.location.protocol === 'file:') {
  const normalizedPath = decodeURIComponent(window.location.pathname).replace(/\\/g, '/');
  const publicMarker = '/public/';
  const publicIndex = normalizedPath.lastIndexOf(publicMarker);
  if (publicIndex >= 0) {
    const appPath = normalizedPath.slice(publicIndex + publicMarker.length);
    window.location.replace(`http://localhost:3000/${encodeURI(appPath)}${window.location.search}${window.location.hash}`);
  }
}

const API = {
  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || '요청 실패');
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  },
  get(url) { return this.req('GET', url); },
  post(url, body) { return this.req('POST', url, body); },
  put(url, body) { return this.req('PUT', url, body); },
  del(url) { return this.req('DELETE', url); }
};

function startPolling(fn, intervalMs) {
  fn();
  const id = setInterval(() => {
    if (document.visibilityState !== 'hidden') fn();
  }, intervalMs);
  return () => clearInterval(id);
}
