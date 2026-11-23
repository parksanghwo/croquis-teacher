import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ParsedResponse } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { CritiqueSettings, Feedback, Img, Pt } from '../types';
import { prepareForModel, restoreFromModel, toBase64 } from './image';
import { CRITIQUE_PROMPT, LINE_ART_PROMPT, PENCIL_PROMPT, REGION_PROMPT } from './prompts';
import { getApiKey, getImageModel, getModel } from './settings';

const PointSchema = z.object({
  x: z.number().describe('이미지 B 기준 가로 위치 % (0=왼쪽, 100=오른쪽)'),
  y: z.number().describe('이미지 B 기준 세로 위치 % (0=위, 100=아래)'),
});
const Line = z.array(PointSchema);

const NoteFields = {
  name: z.string().describe('교정 부위, 짧게. 예: "왼쪽 팔꿈치"'),
  fix: z.string().describe('메모에 쓸 한 줄 요약, 15자 안팎. 예: "위팔 45°로 세우기"'),
  observed: z.string().describe('관찰된 오류: 어느 선이 기준 선화와 어떻게 다른지'),
  cause: z.string().describe('오류의 원인 추정'),
  how: z.string().describe('수정 방법: 기존 선의 어느 지점에서 시작해 어느 방향으로 새 선을 그릴지'),
  rule: z.string().describe('다음 크로키에 적용할 짧고 명확한 행동 지침'),
};

const FeedbackSchema = z.object({
  pose: z.string().describe('포즈 한 줄 요약. 예: "전신 스트리트 포즈"'),
  good: z.string().describe('기준 선화와 잘 맞는 점 1~2문장'),
  issues: z
    .array(
      z.object({
        ...NoteFields,
        priority: z.number().describe('STEP 3 중요도 1~4 (1=동작·무게중심, 2=비례·관절, 3=실루엣·부피, 4=주름·세부)'),
        x: z.number().describe('교정 부위 중심 가로 %'),
        y: z.number().describe('교정 부위 중심 세로 %'),
        red: z.array(Line).describe('빨간 교정선: 이미지 B 위에 그릴 올바른 윤곽 폴리라인들'),
        blue: z.array(Line).describe('파란 보조선: 관절 중심축·방향선·이동 방향 (마지막 점에 화살표)'),
        fade: z.array(Line).describe('흐리게 처리할 학생의 기존 선 폴리라인들'),
      }),
    )
    .describe('가장 중요한 오류 4~7개, 중요도 순'),
});

const RegionSchema = z.object(NoteFields);

export class MissingKeyError extends Error {}

const image = (img: Img) => {
  const { media_type, data } = toBase64(img);
  return { type: 'input_image' as const, image_url: `data:${media_type};base64,${data}`, detail: 'high' as const };
};
const text = (t: string) => ({ type: 'input_text' as const, text: t });

function client() {
  const apiKey = getApiKey();
  if (!apiKey) throw new MissingKeyError('API 키가 필요해요.');
  // 브라우저에서 직접 호출: 키는 이 기기에만 저장되고 OpenAI API로만 전송됨
  return new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
}

/** 거절·잘림을 확인하고 파싱된 결과를 꺼낸다 */
function unwrap<T>(response: ParsedResponse<T>): T {
  const refused = response.output.some((o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal'));
  if (refused) throw new Error('이 이미지는 첨삭할 수 없다는 응답을 받았어요. 다른 사진으로 시도해 주세요.');
  if (response.status === 'incomplete') {
    throw new Error(
      response.incomplete_details?.reason === 'max_output_tokens' ? '응답이 너무 길어 잘렸어요. 다시 시도해 주세요.' : '응답이 중간에 끊겼어요. 다시 시도해 주세요.',
    );
  }
  if (!response.output_parsed) throw new Error('첨삭 결과를 해석하지 못했어요. 다시 시도해 주세요.');
  return response.output_parsed;
}

/** 1·2번 프롬프트: 이미지 모델로 선화를 받아 원본 캔버스 크기로 맞춘다 */
async function editToLineArt(src: Img, prompt: string, signal?: AbortSignal): Promise<Img> {
  const prep = await prepareForModel(src);
  const res = await client().images.edit(
    {
      model: getImageModel(),
      image: await toFile(prep.blob, 'input.png', { type: 'image/png' }),
      prompt,
      size: prep.size,
      output_format: 'png',
    },
    { signal },
  );
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('이미지 모델이 결과 이미지를 돌려주지 않았어요.');
  return restoreFromModel(`data:image/png;base64,${b64}`, prep.crop, src);
}

/** 1번: 실사 사진 → 크로키 연습용 기준 선화 */
export const aiLineArt = (photo: Img, signal?: AbortSignal) => editToLineArt(photo, LINE_ART_PROMPT, signal);
/** 2번: 크로키 사진 → 연필선만 */
export const aiPencilLines = (croquis: Img, signal?: AbortSignal) => editToLineArt(croquis, PENCIL_PROMPT, signal);

function brief(settings: CritiqueSettings) {
  return [
    `연습 시간: ${settings.time} 크로키 (짧은 크로키일수록 큰 흐름과 구조 위주로 판단하세요)`,
    settings.focus.length ? `학생이 중점으로 보고 싶은 부분: ${settings.focus.join(', ')}` : '',
    settings.excludeHead ? '머리·얼굴은 캐릭터화로 보고 비교에서 제외하세요.' : '머리·얼굴도 비교에 포함하세요.',
    settings.detailedTone ? '오답노트는 구체적인 위치·방향·비율을 넣어 꼼꼼하게 쓰세요.' : '오답노트 각 항목은 한두 문장으로 간결하게 쓰세요.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 3번: 기준 선화 A와 학생 크로키 B 비교 */
export async function requestCritique(images: { lineArt: Img; croquis: Img }, settings: CritiqueSettings, signal?: AbortSignal): Promise<Feedback> {
  const response = await client().responses.parse(
    {
      model: getModel(),
      max_output_tokens: 32000,
      instructions: CRITIQUE_PROMPT,
      text: { format: zodTextFormat(FeedbackSchema, 'croquis_feedback') },
      input: [
        {
          role: 'user',
          content: [image(images.lineArt), image(images.croquis), text(`${brief(settings)}\n\n이미지 A(첫 번째)를 기준으로 이미지 B(두 번째)를 교정해 주세요.`)],
        },
      ],
    },
    { signal },
  );
  const out = unwrap(response);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const lines = (ls: { x: number; y: number }[][]): Pt[][] => ls.map((l) => l.map((p) => ({ x: clamp(p.x), y: clamp(p.y) }))).filter((l) => l.length > 1);
  return {
    pose: out.pose,
    good: out.good,
    issues: out.issues
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .map((it, i) => ({
        id: `issue-${i}`,
        name: it.name,
        fix: it.fix,
        why: it.observed,
        how: it.how,
        cause: it.cause,
        rule: it.rule,
        priority: Math.max(1, Math.min(4, Math.round(it.priority))),
        x: clamp(it.x),
        y: clamp(it.y),
        strokes: lines(it.red),
        axes: lines(it.blue),
        fade: lines(it.fade),
      })),
  };
}

/** 학생이 기준 선화에서 고른 조각을 크로키 위에 놓았을 때, 그 부위 하나만 비교 */
export async function requestRegionCritique(
  images: { lineArt: Img; region: Img; croquis: Img },
  at: { x: number; y: number; w: number; h: number },
  settings: CritiqueSettings,
) {
  const response = await client().responses.parse({
    model: getModel(),
    max_output_tokens: 16000,
    instructions: CRITIQUE_PROMPT,
    text: { format: zodTextFormat(RegionSchema, 'region_feedback') },
    input: [{ role: 'user', content: [image(images.lineArt), image(images.region), image(images.croquis), text(`${brief(settings)}\n\n${REGION_PROMPT(at)}`)] }],
  });
  const r = unwrap(response);
  return { name: r.name, fix: r.fix, why: r.observed, how: r.how, cause: r.cause, rule: r.rule };
}

export function describeError(err: unknown): string {
  if (err instanceof MissingKeyError) return err.message;
  if (err instanceof OpenAI.AuthenticationError) return 'API 키가 올바르지 않아요. 키를 다시 확인해 주세요.';
  if (err instanceof OpenAI.PermissionDeniedError) return '이 API 키로는 선택한 모델을 쓸 수 없어요.';
  if (err instanceof OpenAI.NotFoundError) return '모델을 찾을 수 없어요. 설정에서 모델 이름을 확인해 주세요.';
  if (err instanceof OpenAI.RateLimitError) return '요청이 많아 잠시 막혔어요. 조금 뒤 다시 시도해 주세요.';
  if (err instanceof OpenAI.APIUserAbortError) return '취소했어요.';
  if (err instanceof OpenAI.APIConnectionError) return '네트워크에 연결할 수 없어요.';
  if (err instanceof OpenAI.APIError) return `API 오류 (${err.status ?? '알 수 없음'}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
