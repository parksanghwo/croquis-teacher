// 예전 Anthropic 키가 OpenAI로 전송되지 않도록 저장 이름을 새로 씀
const KEY = 'croquis-teacher.openaiKey';
const MODEL = 'croquis-teacher.openaiModel';

export const DEFAULT_MODEL = 'gpt-6-luna';

function read(k: string): string {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}
function write(k: string, v: string) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* 저장소를 못 쓰면 이번 세션에서만 유지 */
  }
}

let memKey = read(KEY);
let memModel = read(MODEL) || DEFAULT_MODEL;

export const getApiKey = () => memKey;
export const getModel = () => memModel;
export function saveSettings(apiKey: string, model: string, remember: boolean) {
  memKey = apiKey.trim();
  memModel = model.trim() || DEFAULT_MODEL;
  write(KEY, remember ? memKey : '');
  write(MODEL, memModel === DEFAULT_MODEL ? '' : memModel);
}
