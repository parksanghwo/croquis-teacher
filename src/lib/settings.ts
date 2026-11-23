// 예전 Anthropic 키가 OpenAI로 전송되지 않도록 저장 이름을 새로 씀
const KEY = 'croquis-teacher.openaiKey';
const MODEL = 'croquis-teacher.openaiModel';

// .env 값은 개발 서버(npm run dev)에서만 읽는다.
// 빌드(npm run build)에서는 DEV가 false라 키 문자열이 결과물에 들어가지 않는다.
const ENV_KEY = import.meta.env.DEV ? (import.meta.env.VITE_OPENAI_API_KEY ?? '').trim() : '';
const ENV_MODEL = import.meta.env.DEV ? (import.meta.env.VITE_OPENAI_MODEL ?? '').trim() : '';

export const DEFAULT_MODEL = ENV_MODEL || 'gpt-6-luna';

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

/** 창에서 입력한 키가 우선, 없으면 .env 키 */
export const getApiKey = () => memKey || ENV_KEY;
/** 창에서 직접 입력해 저장한 키만 (입력창 채우기용) */
export const getSavedKey = () => memKey;
export const hasEnvKey = () => !!ENV_KEY;
export const getModel = () => memModel;
export function saveSettings(apiKey: string, model: string, remember: boolean) {
  memKey = apiKey.trim();
  memModel = model.trim() || DEFAULT_MODEL;
  write(KEY, remember ? memKey : '');
  write(MODEL, memModel === DEFAULT_MODEL ? '' : memModel);
}
