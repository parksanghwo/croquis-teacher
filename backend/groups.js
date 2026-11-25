// Groups of overlays (Shift+click several, or lasso them): the board draws a bracket joining
// them and circles with the error features their correction logs have in common.
import crypto from 'node:crypto';
import { board, persist } from './store.js';
import { aiConfig, aiEnabled } from './ai.js';
import { reviewItem, fileNameFor } from './review.js';

const textModel = () => process.env.OPENAI_MODEL || 'gpt-6-luna';
const UNSURE = '판단 어려움';

export const COMMON_PROMPT = `여러 크로키 피드백 표를 비교해, 서로 다른 그림 2장 이상에서 반복된 오류를 추출하세요.

- ‘교정 내용’과 ‘반복 패턴’을 함께 읽고, 무엇을 어떻게 잘못 그렸는지가 같으면 표현이 달라도 한 그룹으로 묶으세요. 예를 들어 ‘숙인 고개가 들려 보임’과 ‘고개를 덜 숙여 그림’은 같은 패턴입니다.
- 부위나 오류 유형만 같다고 묶지 마세요. 같은 부위라도 ‘넓게 그림’과 ‘좁게 그림’처럼 오차 방향이 반대면 구분하고, ‘판단 어려움’인 기록은 제외하세요.
- 같은 그림에서 같은 패턴이 여러 번 나와도 1장으로 세세요. 패턴별로 다음 연습에 적합한 사진의 조건을 한 가지씩 제시하세요.`;

// Output shape (the prompt above is used word for word; the field descriptions only say
// where each part goes on the board)
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'drawings', 'practice'],
        properties: {
          name: { type: 'string', description: '원 안에 들어갈 반복된 오류 패턴. 무엇을 어떻게 잘못 그렸는지 15자 안팎으로' },
          drawings: { type: 'array', items: { type: 'string' }, description: '이 패턴이 나온 그림 파일명(표에 적힌 그대로), 그림마다 한 번씩' },
          practice: { type: 'string', description: '이 패턴을 연습하기에 적합한 사진의 조건 한 가지' },
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
    if (!byPattern.has(key)) byPattern.set(key, { name: key, practice: '', drawings: new Set() });
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
    .map(f => ({ name: String(f.name).slice(0, 40), practice: String(f.practice || '').slice(0, 80), drawings: [...new Set(f.drawings)].filter(d => files.has(d)) }))
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
  // grouping again over a bigger set replaces the smaller groups it covers
  for (const old of Object.values(board.groups)) if (old.members.every(m => members.includes(m))) delete board.groups[old.id];
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
