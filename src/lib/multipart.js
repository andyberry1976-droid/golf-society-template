'use strict';
/** Minimal multipart/form-data parser for small admin uploads (one file + text fields). No dependency. */
const express = require('express');

function parse(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}; const files = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd === -1) break;
    const head = buf.slice(start + 2, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next === -1) break;
    const body = buf.slice(headEnd + 4, next - 2); // strip the CRLF before the boundary
    const name = /name="([^"]*)"/i.exec(head);
    const filename = /filename="([^"]*)"/i.exec(head);
    if (name) {
      if (filename) files[name[1]] = { filename: filename[1], data: body, type: (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '' };
      else fields[name[1]] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

/** Middleware: parse a multipart body (<= limit) into req.body (text fields) and req.files. */
function upload({ limit = '5mb' } = {}) {
  const raw = express.raw({ type: 'multipart/form-data', limit });
  return (req, res, next) => raw(req, res, (err) => {
    if (err) return next(err);
    if (Buffer.isBuffer(req.body)) {
      const p = parse(req.body, req.headers['content-type']);
      req.body = p ? p.fields : {}; req.files = p ? p.files : {};
    }
    next();
  });
}
module.exports = { parse, upload };
