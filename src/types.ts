export interface Img {
  url: string;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** 첨삭 항목. 좌표는 모두 (정렬된) 내 크로키 이미지 기준 % (0~100). */
export interface Issue {
  id: string;
  name: string;
  fix: string;
  why: string;
  how: string;
  x: number;
  y: number;
  /** 빨간 교정선 */
  strokes: Pt[][];
  /** 파란 보조선: 관절 중심축·방향선·이동 방향 */
  axes?: Pt[][];
  /** 흐리게 덮을 학생의 기존 선 */
  fade?: Pt[][];
  /** 오류의 원인 */
  cause?: string;
  /** 다음 크로키에 적용할 규칙 */
  rule?: string;
  /** 중요도 1~4 */
  priority?: number;
  /** 기준 선화에서 올가미로 골라 끌어다 놓은 조각 (좌표는 기준 선화 기준 0~1) */
  piece?: Piece;
  /** 조각을 놓고 분석을 기다리는 중 */
  pending?: boolean;
}

export interface Piece {
  poly: Pt[];
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface Feedback {
  pose: string;
  good: string;
  issues: Issue[];
}

export interface CritiqueSettings {
  time: string;
  focus: string[];
  excludeHead: boolean;
  autoAlign: boolean;
  detailedTone: boolean;
  /** 선화 추출: AI 이미지 모델(프롬프트 1·2) 또는 브라우저 자동 트레이싱 */
  extract: 'ai' | 'local';
}

