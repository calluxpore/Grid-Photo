// Photo change transitions. The old frame is a snapshot <canvas> layered over
// (or under) the live canvas; both are animated with the Web Animations API.

export const TRANSITIONS = [
  ['none', 'None'],
  ['fade', 'Crossfade'],
  ['slide', 'Slide'],
  ['slide_vertical', 'Slide vertical'],
  ['cover', 'Cover (new slides over)'],
  ['reveal', 'Reveal (old slides away)'],
  ['zoom', 'Zoom'],
  ['wipe', 'Wipe'],
  ['circle', 'Circle reveal'],
  ['blur', 'Blur dissolve'],
  ['flip', '3D flip'],
  ['random', 'Random'],
];

export const TRANSITION_TITLES = Object.fromEntries(TRANSITIONS);

export const EASINGS = {
  smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
  ease_out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  ease_in_out: 'cubic-bezier(0.65, 0, 0.35, 1)',
  linear: 'linear',
};

export const DURATION_PRESETS = [
  [250, 'Fast (0.25 s)'],
  [500, 'Normal (0.5 s)'],
  [900, 'Slow (0.9 s)'],
  [1600, 'Very slow (1.6 s)'],
];

const RANDOM_POOL = TRANSITIONS.map(([id]) => id).filter((id) => !['none', 'random'].includes(id));

/**
 * Keyframes for a transition. d = direction (1 = forward / next, -1 = back).
 * Returns { out, in, newOnTop, split } where split runs out then in (half each).
 */
function frames(type, d) {
  const tx = (p) => `translateX(${p * d}%)`;
  const ty = (p) => `translateY(${p * d}%)`;
  switch (type) {
    case 'fade':
      return { out: [{ opacity: 1 }, { opacity: 0 }] };
    case 'slide':
      return {
        out: [{ transform: tx(0) }, { transform: tx(-100) }],
        in: [{ transform: tx(100) }, { transform: tx(0) }],
      };
    case 'slide_vertical':
      return {
        out: [{ transform: ty(0) }, { transform: ty(-100) }],
        in: [{ transform: ty(100) }, { transform: ty(0) }],
      };
    case 'cover':
      return {
        out: [{ filter: 'brightness(1)' }, { filter: 'brightness(0.55)' }],
        in: [{ transform: tx(100), boxShadow: '0 0 30px rgba(0,0,0,0.6)' }, { transform: tx(0), boxShadow: '0 0 30px rgba(0,0,0,0)' }],
        newOnTop: true,
      };
    case 'reveal':
      return {
        out: [{ transform: tx(0), boxShadow: '0 0 30px rgba(0,0,0,0.6)' }, { transform: tx(-100), boxShadow: '0 0 30px rgba(0,0,0,0.6)' }],
        in: [{ filter: 'brightness(0.55)' }, { filter: 'brightness(1)' }],
      };
    case 'zoom':
      return {
        out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.18)' }],
        in: [{ transform: 'scale(0.92)' }, { transform: 'scale(1)' }],
      };
    case 'wipe':
      return d > 0
        ? { out: [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 100% 0 0)' }] }
        : { out: [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 0 100%)' }] };
    case 'circle':
      return {
        in: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }],
        newOnTop: true,
      };
    case 'blur':
      return {
        out: [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: 'blur(18px)' }],
        in: [{ filter: 'blur(12px)' }, { filter: 'blur(0px)' }],
      };
    case 'flip':
      return {
        out: [{ transform: 'perspective(1400px) rotateY(0deg)' }, { transform: `perspective(1400px) rotateY(${-90 * d}deg)` }],
        in: [{ transform: `perspective(1400px) rotateY(${90 * d}deg)` }, { transform: 'perspective(1400px) rotateY(0deg)' }],
        split: true,
      };
    default:
      return null;
  }
}

/** Runs a transition; resolves when finished. Returns a cancel function via handle.cancel. */
export function runTransition({ snap, canvas, type, direction, duration, easing }) {
  const resolved = type === 'random' ? RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)] : type;
  const f = frames(resolved, direction >= 0 ? 1 : -1);
  const animations = [];
  const cleanup = () => {
    for (const a of animations) a.cancel();
    snap.remove();
    canvas.style.zIndex = '';
  };
  if (!f) {
    cleanup();
    return { finished: Promise.resolve(), cancel: cleanup };
  }
  if (f.newOnTop) canvas.style.zIndex = '2';
  const ease = EASINGS[easing] || EASINGS.smooth;
  const half = Math.max(1, duration / 2);
  if (f.out) {
    animations.push(snap.animate(f.out, {
      duration: f.split ? half : duration, easing: ease, fill: 'forwards',
    }));
  } else if (!f.newOnTop) {
    snap.style.opacity = '0';
  }
  if (f.in) {
    animations.push(canvas.animate(f.in, {
      duration: f.split ? half : duration, delay: f.split ? half : 0, easing: ease, fill: 'backwards',
    }));
  }
  const finished = Promise.all(animations.map((a) => a.finished)).catch(() => {}).then(cleanup);
  return { finished, cancel: cleanup };
}
