// Thin fetch wrapper + Server-Sent Events subscription.

async function req(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const err = new Error((data && (data.detail || data.error)) || `HTTP ${r.status}`);
    err.status = r.status;
    err.offline = data?.offline;
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b) => req('POST', u, b ?? {}),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
};

// Online images go through the local cache proxy so they keep working offline.
export const img = (url) => (!url ? '' : url.startsWith('/') ? url : `/api/img?u=${encodeURIComponent(url)}`);

const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= []).push(fn); }
function emit(evt, data) { (listeners[evt] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }

export function connectEvents() {
  const es = new EventSource('/api/events');
  ['scan', 'library', 'queue', 'download', 'queue_state', 'lyrics', 'liked', 'playlists', 'lyrics_backfill']
    .forEach((e) => es.addEventListener(e, (m) => emit(e, JSON.parse(m.data))));
  es.onerror = () => { /* EventSource auto-reconnects */ };
}
