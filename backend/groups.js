// Groups of overlays (Shift+click several, or lasso them): the board draws a bracket joining
// them and circles with the error features their correction logs have in common.
import crypto from 'node:crypto';
import { board, persist } from './store.js';
import { aiConfig, aiEnabled } from './ai.js';
import { reviewItem, fileNameFor } from './review.js';

const TYPES = ['각도', '위치·간격', '크기·비율', '윤곽·형태', '선의 흐름'];
const textModel = () => process.env.OPENAI_MODEL || 'gpt-6-luna';
const UNSURE = '판단 어려움';

export const COMMON_PROMPT = `아래는 여러 크로키 그림의 교정 기록 표입니다. 그림들에 공통으로 나타나는 오류 특징을 찾으세요.

- 두 그림 이상에서 같은 오류가 나타날 때만 공통 특징으로 묶으세요. 한 그림에만 있는 오류는 빼세요.
- 부위와 어긋난 방향이 같아야 같은 특징입니다. 어긋난 방향이 반대면 따로 묶거나 빼세요.
- name은 원 안에 들어갈 짧은 말(15자 안팎)로, ‘팔과 몸통 사이를 넓게 그림’처럼 무엇이 어떻게 어긋났는지 쓰세요.
- type은 각도, 위치·간격, 크기·비율, 윤곽·형태, 선의 흐름 중 하나를 고르세요.
- drawings에는 그 특징이 나타난 그림 파일명을 표에 적힌 그대로 모두 적으세요.
- ‘판단 어려움’으로 적힌 행은 무시하세요. 공통 특징이 없으면 빈 목록을 돌려주세요.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'type', 'drawings'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: TYPES },
          drawings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** Correction rows per member: { itemId, file, rows } (rows without '판단 어려움' patterns). */
function memberLogs(ids) {
  return ids.map(id => {
    const r = board.reviews?.[id];
    const file = r?.file || (board.items[id] ? fileNameFor(board.items[id]) : id);
    return { itemId: id, file, rows: (r?.rows || []).filter(x => x['반복 패턴'] && x['반복 패턴'] !== UNSURE) };
  });
}

/** Without AI: the same 반복 패턴 wording in two or more drawings. */
function commonByWording(logs) {
  const byPattern = new Map();
  for (const log of logs) for (const row of log.rows) {
    const key = row['반복 패턴'];
    if (!byPattern.has(key)) byPattern.set(key, { name: key, type: row['오류 유형'], drawings: new Set() });
    byPattern.get(key).drawings.add(log.file);
  }
  return [...byPattern.values()].filter(f => f.drawings.size >= 2).map(f => ({ ...f, drawings: [...f.drawings] }));
}

async function commonByModel(logs) {
  const { key, baseUrl } = aiConfig();
  const tables = logs.map(l => [
    `[${l.file}]`,
    '| 부위 | 교정 내용 | 오류 유형 | 반복 패턴 |',
    ...l.rows.map(r => `| ${r['부위']} | ${r['교정 내용']} | ${r['오류 유형']} | ${r['반복 패턴']} |`),
  ].join('\n')).join('\n\n');
  const res = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: textModel(),
      input: [{ role: 'user', content: [{ type: 'input_text', text: `${COMMON_PROMPT}\n\n${tables}` }] }],
      text: { format: { type: 'json_schema', name: 'common_features', schema: SCHEMA, strict: true } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`공통 특징 분석 오류: ${body?.error?.message || res.status}`);
  const text = (body.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') || body.output_text || '{}';
  const files = new Set(logs.map(l => l.file));
  return (JSON.parse(text).features || [])
    .map(f => ({ name: String(f.name).slice(0, 40), type: TYPES.includes(f.type) ? f.type : '', drawings: [...new Set(f.drawings)].filter(d => files.has(d)) }))
    .filter(f => f.drawings.length >= 2);
}

/** Work out a group's common features (logging any member corrections not yet logged). */
export async function computeGroup(group) {
  const members = group.members.filter(id => board.items[id]);
  if (aiEnabled()) await Promise.all(members.map(id => reviewItem(board.items[id]).catch(() => null)));
  const logs = memberLogs(members);
  const enough = logs.filter(l => l.rows.length).length >= 2;
  let features = [];
  if (enough) features = aiEnabled() ? await commonByModel(logs) : commonByWording(logs);
  features.sort((a, b) => b.drawings.length - a.drawings.length);
  Object.assign(group, { members, features, total: members.length, at: new Date().toISOString() });
  persist();
  return group;
}

export function createGroup(memberIds) {
  board.groups ||= {};
  const members = [...new Set(memberIds)].filter(id => board.items[id]);
  const same = Object.values(board.groups).find(g => g.members.length === members.length && g.members.every(m => members.includes(m)));
  if (same) return same;
  const g = { id: crypto.randomUUID().replace(/-/g, '').slice(0, 16), members, features: [], total: members.length, at: new Date().toISOString() };
  board.groups[g.id] = g;
  persist();
  return g;
}

/** Groups that contain an item. */
export const groupsWith = id => Object.values(board.groups || {}).filter(g => g.members.includes(id));

/** Drop a deleted item from its groups; a group left with fewer than two members goes. */
export function forgetMember(id) {
  for (const g of groupsWith(id)) {
    g.members = g.members.filter(m => m !== id);
    if (g.members.length < 2) delete board.groups[g.id];
  }
}
