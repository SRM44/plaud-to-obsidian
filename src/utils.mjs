export const pad = (n) => String(n).padStart(2, '0');
export const str = (value) => (typeof value === 'string' ? value.trim() : '');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const idKey = (id) => String(id).replace(/^of_/, '');
