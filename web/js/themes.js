// Theme catalogue (colours themselves live in css/themes.css).
export const THEMES = [
  { id: 'midnight', name: 'Midnight', bg: '#101015', fg: '#f4f4f6', dots: ['#1ed760', '#4078ff'] },
  { id: 'aurora', name: 'Aurora', bg: '#120f26', fg: '#f2f0ff', dots: ['#a78bfa', '#2dd4bf'] },
  { id: 'sunset', name: 'Sunset', bg: '#1c1018', fg: '#fff2ee', dots: ['#ff7a59', '#ff4d8d'] },
  { id: 'ocean', name: 'Ocean', bg: '#0a1522', fg: '#eef7ff', dots: ['#38bdf8', '#6366f1'] },
  { id: 'forest', name: 'Forest', bg: '#0d1710', fg: '#f0f7f1', dots: ['#a3e635', '#10b981'] },
  { id: 'mono', name: 'Mono', bg: '#0c0c0c', fg: '#fafafa', dots: ['#fafafa', '#8c8c8c'] },
  { id: 'paper', name: 'Paper', bg: '#ebe9e3', fg: '#18181b', dots: ['#2563eb', '#ec4899'] },
  { id: 'blossom', name: 'Blossom', bg: '#fdeaef', fg: '#2b1220', dots: ['#e11d74', '#fb923c'] },
];

export function cssRgb(name) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v.split(',').map((x) => parseInt(x, 10));
}
