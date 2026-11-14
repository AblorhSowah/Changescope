import type { ActivitySourceType } from '../core/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

type ShapeTag = 'circle' | 'rect' | 'path';

interface Shape {
  tag: ShapeTag;
  /** drawn as an outline (CSS class fd-stroke) when true, filled otherwise */
  stroke?: boolean;
  attrs: Readonly<Record<string, string>>;
}

/**
 * One shape per source, so the source is never told by colour alone. 12 x 12 grid.
 * Paint comes from CSS (currentColor): no presentation attributes, no style attributes.
 */
const SOURCE_SHAPES: Readonly<Record<ActivitySourceType, readonly Shape[]>> = {
  // filled circle
  developer: [{ tag: 'circle', attrs: { cx: '6', cy: '6', r: '4.5' } }],
  // diamond
  'ai-agent': [{ tag: 'path', attrs: { d: 'M6 .6 11.4 6 6 11.4 .6 6z' } }],
  // square
  external: [{ tag: 'rect', attrs: { x: '1.5', y: '1.5', width: '9', height: '9', rx: '1' } }],
  // branch: two dots and a line
  git: [
    { tag: 'circle', attrs: { cx: '3.2', cy: '2.8', r: '1.9' } },
    { tag: 'circle', attrs: { cx: '8.8', cy: '9.2', r: '1.9' } },
    { tag: 'path', stroke: true, attrs: { d: 'M3.2 4.2v2.3c0 1.6 1.2 2.7 3.6 2.7' } },
  ],
  // hexagon with a hole (the hole needs fill-rule: evenodd, set in the stylesheet)
  automated: [{ tag: 'path', attrs: { d: 'M6 .7 10.6 3.35v5.3L6 11.3 1.4 8.65v-5.3zM6 4.1a1.9 1.9 0 1 0 0 3.8a1.9 1.9 0 0 0 0-3.8z' } }],
  // ring with a question mark
  unknown: [
    { tag: 'circle', stroke: true, attrs: { cx: '6', cy: '6', r: '4.9' } },
    { tag: 'path', stroke: true, attrs: { d: 'M4.6 4.9a1.4 1.4 0 1 1 2.2 1.1c-.5.4-.8.6-.8 1.1' } },
    { tag: 'circle', attrs: { cx: '6', cy: '8.7', r: '.65' } },
  ],
};

function svg(doc: Document, cls: string, shapes: readonly Shape[]): SVGSVGElement {
  const el = doc.createElementNS(SVG_NS, 'svg');
  el.setAttribute('class', cls);
  el.setAttribute('viewBox', '0 0 12 12');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('focusable', 'false');
  for (const s of shapes) {
    const node = doc.createElementNS(SVG_NS, s.tag);
    if (s.stroke === true) node.setAttribute('class', 'fd-stroke');
    for (const [name, value] of Object.entries(s.attrs)) node.setAttribute(name, value);
    el.appendChild(node);
  }
  return el;
}

/** Decorative: the text label next to it carries the name. */
export function sourceIcon(doc: Document, source: ActivitySourceType): SVGSVGElement {
  return svg(doc, `fd-icon fd-icon--${source}`, SOURCE_SHAPES[source]);
}

export function branchIcon(doc: Document): SVGSVGElement {
  return svg(doc, 'fd-icon fd-icon--branch', SOURCE_SHAPES.git);
}
