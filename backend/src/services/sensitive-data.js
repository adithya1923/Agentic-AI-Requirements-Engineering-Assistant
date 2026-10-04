// Length-preserving masking keeps source offsets usable while reducing accidental
// disclosure to generation and embedding providers. Source records are never changed.
const patterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:\d[ -]*?){13,19}\b/gu,
  /\b(?:\d[ -]*?){8,12}\b/gu,
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/giu,
];

export function maskSensitiveText(value) {
  if (typeof value !== 'string') return value;
  return patterns.reduce((text, pattern) => text.replace(pattern, (match) => [...match].map((character) => /\s/u.test(character) ? character : 'X').join('')), value);
}
