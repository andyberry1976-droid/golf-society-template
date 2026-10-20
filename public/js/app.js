(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  document.documentElement.classList.remove('no-js');

  /* Results dropdown (desktop): click/Enter/Space toggles, hover opens, Escape or clicking away closes */
  $$('[data-dd]').forEach(function (dd) {
    var b = $('.dd-b', dd), m = $('.dd-m', dd), t;
    function set(o) { dd.classList.toggle('open', o); b.setAttribute('aria-expanded', String(o)); }
    b.addEventListener('click', function () { set(!dd.classList.contains('open')); });
    b.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown') { e.preventDefault(); set(true); var a = $('a', m); if (a) a.focus(); } });
    m.addEventListener('keydown', function (e) {
      var as = $$('a', m), i = as.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); as[(i + 1) % as.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); as[(i - 1 + as.length) % as.length].focus(); }
    });
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      dd.addEventListener('mouseenter', function () { clearTimeout(t); set(true); });
      dd.addEventListener('mouseleave', function () { t = setTimeout(function () { set(false); }, 180); });
    }
    dd.addEventListener('focusout', function (e) { if (!dd.contains(e.relatedTarget)) set(false); });
    document.addEventListener('click', function (e) { if (!dd.contains(e.target)) set(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dd.classList.contains('open')) { set(false); b.focus(); } });
  });
  /* Results group in the mobile menu: keep aria-expanded in step with <details> */
  $$('details.msub').forEach(function (d) {
    var s = $('summary', d);
    d.addEventListener('toggle', function () { s.setAttribute('aria-expanded', String(d.open)); });
  });

  /* birthday balloons: every home visit on a birthday, skipped for reduced motion */
  (function () {
    var bb = $('#bday-balloons'); if (!bb || reduced) return;
    bb.hidden = false;
    var named = $$('.bb-named', bb);
    named.forEach(function (n, i) { n.style.left = ((i + 1) * 100 / (named.length + 1)) + '%'; n.style.animationDelay = (0.3 + i * 0.6) + 's'; });
    var narrow = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    var lanes = named.map(function (n, i) { return (i + 1) * 100 / (named.length + 1); });
    for (var i = 0; i < (narrow ? 8 : 14); i++) {
      var s = document.createElement('span'); s.className = 'bb'; s.textContent = '🎈';
      var x, tries = 0; // on phones keep small balloons out of the named balloons' lanes
      do { x = 4 + Math.random() * 90; } while (narrow && tries++ < 30 && lanes.some(function (l) { return Math.abs(x - l) < 24; }));
      s.style.left = x + '%'; s.style.animationDelay = (Math.random() * 1.5) + 's';
      s.style.animationDuration = (4.5 + Math.random() * 1.5) + 's'; s.style.fontSize = (narrow ? 20 + Math.random() * 12 : 26 + Math.random() * 22) + 'px';
      bb.appendChild(s);
    }
    setTimeout(function () { bb.parentNode && bb.parentNode.removeChild(bb); }, 7500);
  })();

  /* mobile nav */
  var tg = $('#nav-toggle'), mn = $('#mobile-nav');
  if (tg && mn) {
    tg.addEventListener('click', function () {
      var o = mn.classList.toggle('open');
      tg.setAttribute('aria-expanded', String(o));
      tg.setAttribute('aria-label', o ? 'Close menu' : 'Open menu');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mn.classList.contains('open')) { mn.classList.remove('open'); tg.setAttribute('aria-expanded', 'false'); tg.focus(); }
    });
  }

  /* confetti burst (skipped for reduced motion) */
  function burst(el) {
    if (reduced || !el || !el.animate) return;
    var r = el.getBoundingClientRect(), cx = r.left + Math.min(r.width, 300) / 2, cy = r.top + r.height / 2;
    var cols = ['#d4168f', '#ffd23f', '#0a7a55', '#6d28d9', '#38bdf8', '#ff9f43', '#fff'];
    for (var i = 0; i < 44; i++) {
      var s = document.createElement('span');
      s.className = 'cf'; s.setAttribute('aria-hidden', 'true');
      s.style.left = cx + 'px'; s.style.top = cy + 'px'; s.style.background = cols[i % cols.length];
      if (i % 3 === 0) { s.style.borderRadius = '50%'; s.style.width = '10px'; s.style.height = '10px'; }
      document.body.appendChild(s);
      var a = Math.random() * Math.PI * 2, v = 90 + Math.random() * 190, dx = Math.cos(a) * v, dy = Math.sin(a) * v - 120;
      var an = s.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: 'translate(' + dx + 'px,' + (dy + 260) + 'px) rotate(' + (Math.random() * 720 - 360) + 'deg)', opacity: 0 }], { duration: 1000 + Math.random() * 900, easing: 'cubic-bezier(.2,.7,.4,1)' });
      an.onfinish = (function (n) { return function () { n.remove(); }; })(s);
    }
  }
  var cf = $('[data-confetti]');
  if (cf) burst(cf);
  $$('[data-burst]').forEach(function (b) { b.addEventListener('click', function () { burst(b); }); });

  /* countdown to the next event */
  var cd = $('[data-countdown]');
  if (cd) {
    var parts = cd.getAttribute('data-countdown').split(/[-T:]/).map(Number); // local time: YYYY-MM-DDTHH:MM
    var target = new Date(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0).getTime();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var tick = function () {
      var t = Math.max(0, target - Date.now()), s = Math.floor(t / 1000);
      $('[data-cd=d]', cd).textContent = p2(Math.floor(s / 86400));
      $('[data-cd=h]', cd).textContent = p2(Math.floor(s % 86400 / 3600));
      $('[data-cd=m]', cd).textContent = p2(Math.floor(s % 3600 / 60));
      $('[data-cd=s]', cd).textContent = p2(s % 60);
    };
    tick();
    if (!reduced) setInterval(tick, 1000); else setInterval(tick, 30000);
  }

  /* auto-submit filter selects */
  $$('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form.submit(); });
  });

  /* event form: pick sensible defaults when the format changes */
  var fmt = $('#f-format');
  if (fmt) {
    fmt.addEventListener('change', function () {
      var o = fmt.options[fmt.selectedIndex];
      var basis = $('#f-scoring_basis'), hc = $('#f-counts_handicap');
      if (basis && o.dataset.basis) basis.value = o.dataset.basis;
      if (hc && o.dataset.hcp !== undefined) hc.checked = o.dataset.hcp === '1';
    });
  }

  /* results entry: tint rows that have a score */
  $$('.rentry tbody tr').forEach(function (tr) {
    var inputs = $$('input[data-score]', tr);
    var upd = function () { tr.classList.toggle('played', inputs.some(function (i) { return i.value.trim() !== ''; })); };
    inputs.forEach(function (i) { i.addEventListener('input', upd); });
    upd();
  });

  /* confirm destructive actions */
  $$('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });
})();
