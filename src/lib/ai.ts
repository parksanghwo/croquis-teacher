import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ParsedResponse } from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { CritiqueSettings, Feedback, Img } from '../types';
import { toBase64 } from './image';
import { getApiKey, getModel } from './settings';

const PointSchema = z.object({
  x: z.number().describe('내 크로키 이미지 기준 가로 위치 % (0=왼쪽, 100=오른쪽)'),
  y: z.number().describe('내 크로키 이미지 기준 세로 위치 % (0=위, 100=아래)'),
});

const FeedbackSchema = z.object({
  pose: z.string().describe('포즈 한 줄 요약. 예: "전신 스트리트 포즈"'),
  good: z.string().describe('잘한 점 1~2문장'),
  issues: z
    .array(
      z.object({
        name: z.string().describe('부위 이름, 6자 이내. 예: "팔꿈치"'),
        fix: z.string().describe('고칠 점 한 구절, 15자 이내. 예: "팔꿈치 더 접기, 위팔 45°"'),
        why: z.string().describe('왜 어색한지 한 문장'),
        how: z.string().describe('어떻게 고칠지 한 문장'),
        x: z.number().describe('문제 부위 중심 가로 %'),
        y: z.number().describe('문제 부위 중심 세로 %'),
        strokes: z
          .array(z.array(PointSchema))
          .describe('빨간 펜으로 덧그릴 "올바른" 선. 1~3개 폴리라인, 각 4~14개 점'),
      }),
    )
    .describe('고칠 점 3~6개, 위에서 아래 순서'),
});

const SYSTEM = `당신은 인체 크로키를 가르치는 친절한 미술 선생님입니다.
학생이 참고 사진을 보고 그린 크로키를 받아, 사진과 비교해 비례·관절 각도·실루엣·옷 주름 등 형태의 차이를 짚어 줍니다.

이미지는 세 장이 순서대로 주어집니다.
1) 참고 사진
2) 참고 사진에서 자동 추출한 기준 선화 (근사치라 노이즈가 있을 수 있음)
3) 학생의 크로키 — 모든 좌표는 이 세 번째 이미지 기준 백분율(%)입니다. 왼쪽 위가 (0,0), 오른쪽 아래가 (100,100).

규칙:
- 각 항목의 strokes는 학생 그림 위에 빨간 펜으로 덧그릴 "고쳐진 선"입니다. 학생이 그린 해당 부위 위치에, 사진처럼 보이도록 수정된 윤곽을 그립니다. 학생 선과 대략 같은 크기·위치에 두되 고친 모양을 보여 주세요.
- x, y는 고칠 부위의 중심입니다. strokes와 같은 영역이어야 합니다.
- 실제로 크로키에서 보이는 차이만 지적하세요. 사소한 디테일보다 큰 형태를 먼저.
- 한국어로, 반말이 아닌 부드러운 말투로 짧게 씁니다.`;

const RegionSchema = z.object({
  name: z.string().describe('부위 이름, 6자 이내'),
  fix: z.string().describe('고칠 점 한 구절, 15자 이내'),
  why: z.string().describe('내 선과 기준선이 어떻게 다른지 한 문장'),
  how: z.string().describe('어떻게 고칠지 한 문장'),
});

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

/** 학생이 기준 선화에서 고른 조각을 내 크로키의 특정 위치에 놓았을 때, 그 부위 하나만 비교 */
export async function requestRegionCritique(
  images: { lineArt: Img; region: Img; croquis: Img },
  at: { x: number; y: number; w: number; h: number },
  settings: CritiqueSettings,
): Promise<{ name: string; fix: string; why: string; how: string }> {
  const response = await client().responses.parse({
    model: getModel(),
    max_output_tokens: 16000,
    instructions: SYSTEM,
    text: { format: zodTextFormat(RegionSchema, 'region_feedback') },
    input: [
      {
        role: 'user',
        content: [
          image(images.lineArt),
          image(images.region),
          image(images.croquis),
          text(
            `이번에는 이미지가 다르게 주어져요: 1) 기준 선화 전체, 2) 학생이 기준 선화에서 올가미로 고른 조각, 3) 학생의 크로키.\n` +
              `학생은 이 조각을 크로키 위 가로 ${at.x.toFixed(0)}%, 세로 ${at.y.toFixed(0)}% 위치(조각 크기 약 ${at.w.toFixed(0)}%×${at.h.toFixed(0)}%)에 겹쳐 놓았어요.\n` +
              `그 자리에 있는 학생의 선과 고른 기준선을 비교해서 고칠 점 하나만 알려 주세요.\n` +
              (settings.detailedTone ? 'why/how는 구체적으로 쓰세요.' : 'why/how는 각각 25자 안팎으로 짧게 쓰세요.'),
          ),
        ],
      },
    ],
  });
  return unwrap(response);
}

export async function requestCritique(
  images: { photo: Img; lineArt: Img; croquis: Img },
  settings: CritiqueSettings,
  signal?: AbortSignal,
): Promise<Feedback> {
  const brief = [
    `연습 시간: ${settings.time} 크로키 (짧을수록 큰 흐름 위주로 너그럽게 봐 주세요)`,
    settings.focus.length ? `중점: ${settings.focus.join(', ')}` : '중점: 전체',
    settings.excludeHead ? '머리·얼굴은 캐릭터화로 보고 비교에서 제외하세요.' : '머리·얼굴도 비교에 포함하세요.',
    settings.detailedTone
      ? 'why/how는 구체적인 수치·방향을 넣어 꼼꼼하게 쓰세요.'
      : 'why/how는 각각 25자 안팎으로 짧게 쓰세요.',
  ].join('\n');


  const response = await client().responses.parse(
    {
      model: getModel(),
      max_output_tokens: 16000,
      instructions: SYSTEM,
      text: { format: zodTextFormat(FeedbackSchema, 'croquis_feedback') },
      input: [
        {
          role: 'user',
          content: [image(images.photo), image(images.lineArt), image(images.croquis), text(`${brief}\n\n세 번째 이미지(내 크로키)를 첨삭해 주세요.`)],
        },
      ],
    },
    { signal },
  );
  const out = unwrap(response);

  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  return {
    pose: out.pose,
    good: out.good,
    issues: out.issues.map((it, i) => ({
      ...it,
      id: `issue-${i}`,
      x: clamp(it.x),
      y: clamp(it.y),
      strokes: it.strokes.map((s) => s.map((p) => ({ x: clamp(p.x), y: clamp(p.y) }))).filter((s) => s.length > 1),
    })),
  };
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
