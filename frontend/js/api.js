// Talks to the backend. Every call rejects with an Error whose message is
// the server's Korean error text, so the UI can show it as-is.

async function request(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: body && !(body instanceof Blob) ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body == null ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
  } catch {
    const err = new Error('서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인하세요');
    err.offline = true;
    throw err;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 오류 (${res.status})`);
  return data;
}

export const api = {
  board: () => request('GET', '/board'),
  /** {ai, imageModel}: whether arrows extract line art with the image model */
  config: () => request('GET', '/config'),
  camera: cam => request('PUT', '/camera', { x: cam.x, y: cam.y, z: cam.z }),
  /** Upload an image blob → {id, url, width, height} */
  uploadImage: blob => request('POST', '/images', blob, { 'Content-Type': blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png' }),
  putItem: item => request('PUT', `/items/${item.id}`, item),
  deleteItem: id => request('DELETE', `/items/${id}`),
  putLink: link => request('PUT', `/links/${link.id}`, link),
  deleteLink: id => request('DELETE', `/links/${id}`),
  /** Build or rebuild the 50/50 overlay for an arrow → {item, link, created} */
  overlay: (linkId, { refit = false } = {}) => request('POST', `/links/${linkId}/overlay`, { refit }),
};
