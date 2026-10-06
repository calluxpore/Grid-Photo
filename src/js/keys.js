// Keyboard combo normalisation. Uses physical key codes so shortcuts work the
// same with or without Shift (e.g. "Shift+]" instead of "}").

const CODE_NAMES = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  PageUp: 'PgUp', PageDown: 'PgDown', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'Enter',
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End',
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
  NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSub', NumpadMultiply: 'NumMul',
  NumpadDivide: 'NumDiv', NumpadDecimal: 'NumDec',
};

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'NumLock', 'ContextMenu',
]);

export function keyName(code) {
  if (!code || MODIFIER_CODES.has(code)) return null;
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num${m[1]}`;
  if (/^F\d{1,2}$/.test(code)) return code;
  return null;
}

export function comboFromEvent(e) {
  const key = keyName(e.code);
  if (!key) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
}

const ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'];

/** Normalise a user/default combo string to the canonical form. */
export function normalizeCombo(combo) {
  if (!combo) return '';
  const parts = combo.split('+');
  // a trailing "+" key ("Ctrl++") splits into an empty last part
  let key = parts.pop();
  if (key === '' && combo.endsWith('+')) {
    parts.pop();
    key = '=';
  }
  const mods = ORDER.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  return [...mods, key].join('+');
}

export function displayCombo(combo) {
  return combo
    .replace(/\bPgUp\b/, 'PgUp').replace(/\bNumAdd\b/, 'Num +').replace(/\bNumSub\b/, 'Num -')
    .replace(/\bNumMul\b/, 'Num *').replace(/\bNumDiv\b/, 'Num /');
}
