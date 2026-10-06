// Layout algorithms: equal-cell grid and Pinterest-style waterfall (masonry).

export const DEFAULT_ASPECT = 1.5;

/** Equal cells grid. Returns {rows, cols}. */
export function computeGrid(n, width, height, grid, aspects) {
  if (n <= 0) return { rows: 0, cols: 0 };
  const columnsFirst = grid.mode === 'columns';
  const pack = (major, minor) => (columnsFirst ? { rows: major, cols: minor } : { rows: minor, cols: major });

  if (grid.fixed && grid.size > 0) {
    const k = grid.size;
    const other = grid.show_all_cells ? Math.max(k, Math.ceil(n / k)) : Math.ceil(n / k);
    return pack(k, other);
  }
  if (grid.fit_cells && width > 0 && height > 0) {
    let best = null;
    for (let major = 1; major <= n; major++) {
      const minor = Math.ceil(n / major);
      const { rows, cols } = pack(major, minor);
      const cw = (width - grid.spacing * (cols - 1)) / cols;
      const ch = (height - grid.spacing * (rows - 1)) / rows;
      if (cw <= 0 || ch <= 0) continue;
      let area = 0;
      for (const aspect of aspects) {
        const ar = aspect || DEFAULT_ASPECT;
        area += Math.min(cw, ch * ar) * Math.min(ch, cw / ar);
      }
      const empties = rows * cols - n;
      if (!best || area > best.area + 1e-6 || (Math.abs(area - best.area) < 1e-6 && empties < best.empties)) {
        best = { area, empties, rows, cols };
      }
    }
    if (best) return { rows: best.rows, cols: best.cols };
  }
  const major = Math.ceil(Math.sqrt(n));
  return pack(major, Math.ceil(n / major));
}

/** Integer partition of `total` pixels into `parts` segments with spacing. */
export function split(total, parts, spacing) {
  const avail = total - spacing * (parts - 1);
  const edges = [];
  for (let i = 0; i <= parts; i++) edges.push(Math.round((avail * i) / parts));
  return Array.from({ length: parts }, (_, i) => [edges[i] + spacing * i, edges[i + 1] - edges[i]]);
}

export function gridRects(n, width, height, grid, aspects) {
  const { rows, cols } = computeGrid(n, width, height, grid, aspects);
  if (!n) return { rows, cols, rects: [] };
  const xs = split(width, cols, grid.spacing);
  const ys = split(height, rows, grid.spacing);
  const rects = [];
  for (let i = 0; i < n; i++) {
    const [r, c] = grid.mode === 'columns' ? [i % rows, Math.floor(i / rows)] : [Math.floor(i / cols), i % cols];
    if (r >= rows || c >= cols) {
      rects.push(null);
      continue;
    }
    rects.push({ x: xs[c][0], y: ys[r][0], w: xs[c][1], h: ys[r][1] });
  }
  return { rows, cols, rects };
}

// ---------------------------------------------------------------- masonry
function greedy(aspects, cols, order) {
  const heights = new Array(cols).fill(0);
  const members = Array.from({ length: cols }, () => []);
  for (const i of order) {
    let k = 0;
    for (let j = 1; j < cols; j++) if (heights[j] < heights[k]) k = j;
    heights[k] += 1 / aspects[i];
    members[k].push(i);
  }
  return members;
}

function colWidth(m, aspects, height, gap) {
  if (!m.length) return Infinity;
  let inv = 0;
  for (const i of m) inv += 1 / aspects[i];
  return (height - gap * (m.length - 1)) / inv;
}

function fitWidth(members, aspects, height, gap) {
  let w = Infinity;
  for (const m of members) w = Math.min(w, colWidth(m, aspects, height, gap));
  return w;
}

/** Move / swap photos out of the limiting column while it helps. */
function refine(members, aspects, height, gap, maxRounds = 60) {
  for (let round = 0; round < maxRounds; round++) {
    const widths = members.map((m) => colWidth(m, aspects, height, gap));
    let worst = 0;
    for (let k = 1; k < members.length; k++) if (widths[k] < widths[worst]) worst = k;
    const current = widths[worst];
    let best = null;
    for (let k = 0; k < members.length; k++) {
      if (k === worst) continue;
      let floor = Infinity;
      for (let j = 0; j < members.length; j++) if (j !== worst && j !== k) floor = Math.min(floor, widths[j]);
      for (const a of members[worst]) {
        const na = members[worst].filter((x) => x !== a);
        let score = Math.min(colWidth(na, aspects, height, gap),
          colWidth([...members[k], a], aspects, height, gap), floor);
        if (score > current + 1e-6 && (!best || score > best.score)) best = { score, a, b: null, k };
        for (const b of members[k]) {
          if (Math.abs(aspects[a] - aspects[b]) < 1e-9) continue;
          score = Math.min(colWidth([...na, b], aspects, height, gap),
            colWidth([...members[k].filter((x) => x !== b), a], aspects, height, gap), floor);
          if (score > current + 1e-6 && (!best || score > best.score)) best = { score, a, b, k };
        }
      }
    }
    if (!best) break;
    const { a, b, k } = best;
    members[worst] = members[worst].filter((x) => x !== a);
    members[k].push(a);
    if (b !== null) {
      members[k] = members[k].filter((x) => x !== b);
      members[worst].push(b);
    }
  }
  return members;
}

/**
 * Pinterest-style waterfall layout that fits entirely inside width x height.
 * Tries every column count, shrinks the column width until the tallest column
 * fits and keeps the layout with the biggest photos. Unless keepOrder is set,
 * photos are distributed to balance the column heights. Anchored top-left:
 * leftover space only appears after the last photos. Returns {cols, rects}.
 */
export function computeMasonry(rawAspects, width, height, gap, fixedCols = 0, keepOrder = false) {
  const n = rawAspects.length;
  if (!n || width <= 0 || height <= 0) return { cols: 0, rects: [] };
  const aspects = rawAspects.map((ar) => (ar && ar > 0 ? ar : DEFAULT_ASPECT));
  const inOrder = aspects.map((_, i) => i);
  const tallestFirst = [...inOrder].sort((a, b) => 1 / aspects[b] - 1 / aspects[a]);
  const candidates = fixedCols ? [fixedCols] : inOrder.map((i) => i + 1);
  let best = null;
  for (const cols of candidates) {
    const maxW = (width - gap * (cols - 1)) / cols;
    if (maxW <= 8) break;
    const options = [greedy(aspects, cols, inOrder)];
    if (!keepOrder) options.push(greedy(aspects, cols, tallestFirst));
    for (const members of options) {
      const w = Math.min(maxW, fitWidth(members, aspects, height, gap));
      if (w > 1 && (!best || w > best.w + 0.01)) best = { w, cols, members };
    }
  }
  if (!best) return { cols: 0, rects: [] };
  let { w, cols, members } = best;
  if (!keepOrder && cols > 1) {
    const maxW = (width - gap * (cols - 1)) / cols;
    if (w < maxW) {
      members = refine(members.map((m) => [...m]), aspects, height, gap);
      w = Math.min(maxW, fitWidth(members, aspects, height, gap));
    }
    // rough reading order: sort inside columns, columns by their first photo
    members = members.filter((m) => m.length).map((m) => [...m].sort((a, b) => a - b))
      .sort((a, b) => a[0] - b[0]);
    cols = members.length;
  }
  const rects = new Array(n).fill(null);
  members.forEach((m, k) => {
    const x = k * (w + gap);
    let y = 0;
    for (const i of m) {
      const h = w / aspects[i];
      rects[i] = {
        x: Math.round(x), y: Math.round(y),
        w: Math.round(x + w) - Math.round(x), h: Math.round(y + h) - Math.round(y),
      };
      y += h + gap;
    }
  });
  return { cols, rects };
}
