export const round = (v, dp = 3) => Math.round(v * 10 ** dp) / 10 ** dp;
export const ratio = (num, den) => (den > 0 ? num / den : null);
export const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
