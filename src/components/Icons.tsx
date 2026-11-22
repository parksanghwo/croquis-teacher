import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>, size = 18): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  ...p,
});

export const PencilIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p, 20)}>
    <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
    <path d="M14 7l3 3" />
  </svg>
);
export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M5 12l5 5 9-10" />
  </svg>
);
export const ArrowRightIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const ChevronLeftIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p, 16)}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const MinusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 12h14M12 5v14" />
  </svg>
);
export const TrashIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);
export const KeyIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p, 16)}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
  </svg>
);
export const UploadIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p, 28)}>
    <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />
  </svg>
);
