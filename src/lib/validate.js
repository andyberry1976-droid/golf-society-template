'use strict';
/** Minimal form validation helper. Usage: const f = form(req.body); const name = f.str('name',{min:1,max:80}); if(!f.ok) ... */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function form(body = {}) {
  const errors = {};
  const values = {};
  const raw = (k) => {
    const v = body[k];
    return Array.isArray(v) ? v[v.length - 1] : v;
  };
  const f = {
    errors, values,
    get ok() { return Object.keys(errors).length === 0; },
    fail(k, msg) { if (!errors[k]) errors[k] = msg; return null; },
    str(k, { min = 0, max = 200, label = k, required = false } = {}) {
      const s = String(raw(k) ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
      values[k] = s;
      if ((required || min > 0) && s.length < Math.max(min, 1)) return f.fail(k, `${label} is required`);
      if (s.length > max) return f.fail(k, `${label} must be at most ${max} characters`);
      return s;
    },
    email(k, { label = 'Email' } = {}) {
      const s = String(raw(k) ?? '').trim().toLowerCase();
      values[k] = s;
      if (!EMAIL_RE.test(s) || s.length > 254) return f.fail(k, `${label} doesn't look right`);
      return s;
    },
    int(k, { min = -1e9, max = 1e9, label = k, optional = false } = {}) {
      const s = String(raw(k) ?? '').trim();
      values[k] = s;
      if (s === '') return optional ? null : f.fail(k, `${label} is required`);
      const n = Number(s);
      if (!Number.isInteger(n) || n < min || n > max) return f.fail(k, `${label} must be a whole number between ${min} and ${max}`);
      return n;
    },
    num(k, { min = -1e9, max = 1e9, label = k, optional = false } = {}) {
      const s = String(raw(k) ?? '').trim();
      values[k] = s;
      if (s === '') return optional ? null : f.fail(k, `${label} is required`);
      const n = Number(s);
      if (!Number.isFinite(n) || n < min || n > max) return f.fail(k, `${label} must be a number between ${min} and ${max}`);
      return n;
    },
    date(k, { label = k, optional = false } = {}) {
      const s = String(raw(k) ?? '').trim();
      values[k] = s;
      if (s === '' && optional) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T12:00:00Z'))) return f.fail(k, `${label} must be a valid date`);
      return s;
    },
    time(k, { label = k } = {}) {
      const s = String(raw(k) ?? '').trim();
      values[k] = s;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return f.fail(k, `${label} must be a time like 09:30`);
      return s;
    },
    oneOf(k, list, { label = k } = {}) {
      const s = String(raw(k) ?? '').trim();
      values[k] = s;
      if (!list.includes(s)) return f.fail(k, `${label} is not valid`);
      return s;
    },
    bool(k) {
      const v = raw(k);
      values[k] = v;
      return v === '1' || v === 'on' || v === 'true' || v === true;
    },
    password(k, { label = 'Password' } = {}) {
      const s = String(raw(k) ?? '');
      if (s.length < 10) return f.fail(k, `${label} must be at least 10 characters`);
      if (s.length > 200) return f.fail(k, `${label} is too long`);
      return s;
    },
  };
  return f;
}

module.exports = { form, EMAIL_RE };
