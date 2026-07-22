/* ================================================================
   Νομοθεσίων — Application logic
   Αναζήτηση (ανεξάρτητη τόνων), φιλτράρισμα, θέμα, σύνδεσμοι πηγών.
   ================================================================ */
(function () {
  "use strict";

  var DATA = window.LEGISLATION_DATA || { categories: [], laws: [] };
  var CATEGORIES = DATA.categories;
  var LAWS = DATA.laws;

  /* --------- Ασφαλής πρόσβαση localStorage (sandbox/ιδιωτική περιήγηση) --------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* --------- Χάρτης κατηγοριών για γρήγορη αναζήτηση --------- */
  var CAT_BY_ID = {};
  CATEGORIES.forEach(function (c) { CAT_BY_ID[c.id] = c; });
  function catLabel(id) { return CAT_BY_ID[id] ? CAT_BY_ID[id].label : id; }
  function catIcon(id) { return CAT_BY_ID[id] ? CAT_BY_ID[id].icon : "📄"; }

  /* --------- Κανονικοποίηση ελληνικού κειμένου (χωρίς τόνους) ---------
     Διατηρεί αντιστοιχία 1:1 χαρακτήρων ώστε να λειτουργεί η επισήμανση. */
  function normChar(ch) {
    var n = ch.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ς/g, "σ");
    return n.length ? n[0] : ch.toLowerCase();
  }
  function normalize(text) {
    if (!text) return "";
    var out = "";
    for (var i = 0; i < text.length; i++) out += normChar(text[i]);
    return out;
  }
  function tokenize(q) {
    return normalize(q).split(/[\s,·.]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  }

  /* --------- Προϋπολογισμός πεδίων αναζήτησης --------- */
  LAWS.forEach(function (l) {
    l._hayTitle = normalize([l.title, l.abbr, l.number].join(" "));
    l._hayNum = normalize(l.number || "");
    l._normTags = (l.tags || []).map(normalize);
    l._hayAll = normalize([
      l.title, l.abbr, l.number, l.type,
      (l.tags || []).join(" "), l.summary, catLabel(l.category)
    ].join(" "));
  });

  /* --------- Βαθμολόγηση αποτελεσμάτων --------- */
  function score(law, terms) {
    var s = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (law._hayAll.indexOf(t) === -1) return 0; // λογική AND
      s += 1;
      if (law._hayTitle.indexOf(t) !== -1) s += 3;
      if (law._hayNum.indexOf(t) !== -1) s += 4;
      if (law._normTags.indexOf(t) !== -1) s += 2;
    }
    return s;
  }

  /* --------- Ασφαλής HTML & επισήμανση όρων --------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function highlight(text, terms) {
    if (!text) return "";
    if (!terms || !terms.length) return esc(text);
    var normed = normalize(text);
    var ranges = [];
    terms.forEach(function (t) {
      if (!t) return;
      var idx = 0;
      while ((idx = normed.indexOf(t, idx)) !== -1) { ranges.push([idx, idx + t.length]); idx += t.length; }
    });
    if (!ranges.length) return esc(text);
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    ranges.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    var out = "", pos = 0;
    merged.forEach(function (r) {
      out += esc(text.slice(pos, r[0])) + "<mark>" + esc(text.slice(r[0], r[1])) + "</mark>";
      pos = r[1];
    });
    return out + esc(text.slice(pos));
  }

  /* --------- Σύνδεσμοι πηγής πλήρους κειμένου --------- */
  var SOURCE_KEY = "nomothesion_source";
  function refString(law) {
    var parts = [];
    if (law.number && law.number !== "—") parts.push(law.number);
    else if (law.abbr) parts.push(law.abbr);
    parts.push(law.title);
    return parts.join(" ");
  }
  function sourceUrl(law) {
    var provider = lsGet(SOURCE_KEY) || "google";
    var base = refString(law);
    var q;
    switch (provider) {
      case "kodiko": q = "site:kodiko.gr " + base; break;
      case "enomothesia": q = "site:e-nomothesia.gr " + base; break;
      case "et": q = "site:et.gr " + base + " ΦΕΚ"; break;
      default: q = base + " ΦΕΚ πλήρες κείμενο";
    }
    return "https://www.google.com/search?q=" + encodeURIComponent(q);
  }
  function citation(law) {
    var hasNum = law.number && law.number !== "—";
    var out = hasNum ? (law.type + " " + law.number + " — «" + law.title + "»")
                     : (law.title + " (" + law.year + ")");
    if (law.fek) out += " (" + law.fek + ")";
    return out;
  }

  /* --------- Κατάσταση εφαρμογής --------- */
  var state = { query: "", cat: null };

  /* --------- Στοιχεία DOM --------- */
  var $ = function (s) { return document.querySelector(s); };
  var searchInput = $("#searchInput");
  var clearBtn = $("#clearSearch");
  var filterBar = $("#filterBar");
  var categoryGrid = $("#categoryGrid");
  var resultsList = $("#resultsList");
  var resultsTitle = $("#resultsTitle");
  var resultsMeta = $("#resultsMeta");
  var emptyState = $("#emptyState");
  var statsBar = $("#statsBar");
  var quickTags = $("#quickTags");
  var cardTpl = $("#lawCardTemplate");

  /* --------- Αρχικοποίηση στατικών τμημάτων --------- */
  function initStats() {
    statsBar.innerHTML =
      '<span class="stat"><strong>' + LAWS.length + "</strong> νομοθετήματα</span>" +
      '<span class="stat"><strong>' + CATEGORIES.length + "</strong> κατηγορίες δικαίου</span>" +
      '<span class="stat">Σύνταγμα · Κώδικες · Νόμοι · Κανονισμοί ΕΕ</span>';
    var fc = $("#footerCount");
    if (fc) fc.textContent = LAWS.length + " νομοθετήματα σε " + CATEGORIES.length + " κατηγορίες";
  }

  var QUICK = ["Ποινικός Κώδικας", "Αστικός Κώδικας", "διαζύγιο", "ανώνυμη εταιρεία",
    "GDPR", "εργατικό", "φορολογία", "κληρονομιά", "μίσθωση", "πτώχευση"];
  function initQuickTags() {
    quickTags.innerHTML = "";
    QUICK.forEach(function (q) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "quick-tag";
      b.textContent = q;
      b.addEventListener("click", function () { setQuery(q); });
      quickTags.appendChild(b);
    });
  }

  function countInCat(id) {
    var n = 0;
    for (var i = 0; i < LAWS.length; i++) if (LAWS[i].category === id) n++;
    return n;
  }

  function initFilters() {
    filterBar.innerHTML = "";
    var all = document.createElement("button");
    all.type = "button";
    all.className = "filter-chip";
    all.dataset.cat = "";
    all.innerHTML = "Όλα <span class='chip-count'>" + LAWS.length + "</span>";
    all.addEventListener("click", function () { setCategory(null); });
    filterBar.appendChild(all);
    CATEGORIES.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "filter-chip";
      b.dataset.cat = c.id;
      b.innerHTML = "<span aria-hidden='true'>" + c.icon + "</span> " + esc(c.label) +
        " <span class='chip-count'>" + countInCat(c.id) + "</span>";
      b.addEventListener("click", function () { setCategory(c.id); });
      filterBar.appendChild(b);
    });
  }

  function initCategoryGrid() {
    categoryGrid.innerHTML = "";
    CATEGORIES.forEach(function (c) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "cat-card";
      card.innerHTML =
        '<span class="cat-card__icon" aria-hidden="true">' + c.icon + "</span>" +
        '<h3 class="cat-card__label">' + esc(c.label) + "</h3>" +
        '<p class="cat-card__desc">' + esc(c.desc) + "</p>" +
        '<span class="cat-card__count">' + countInCat(c.id) + " νομοθετήματα →</span>";
      card.addEventListener("click", function () { setCategory(c.id); });
      categoryGrid.appendChild(card);
    });
  }

  /* --------- Δημιουργία κάρτας νόμου --------- */
  function makeCard(law, terms) {
    var node = cardTpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".law-card__type").textContent = law.type;

    var catEl = node.querySelector(".law-card__cat");
    catEl.textContent = catIcon(law.category) + " " + catLabel(law.category);
    catEl.setAttribute("role", "button");
    catEl.setAttribute("tabindex", "0");
    catEl.addEventListener("click", function () { setCategory(law.category); });
    catEl.addEventListener("keydown", function (e) { if (e.key === "Enter") setCategory(law.category); });

    node.querySelector(".law-card__title").innerHTML = highlight(law.title, terms);
    node.querySelector(".law-card__summary").innerHTML = highlight(law.summary || "", terms);

    var meta = node.querySelector(".law-card__meta");
    var bits = [];
    if (law.number && law.number !== "—") bits.push("<span><b>Αριθμ.:</b> " + esc(law.number) + "</span>");
    if (law.abbr) bits.push("<span><b>Σύντμ.:</b> " + esc(law.abbr) + "</span>");
    bits.push("<span><b>Έτος:</b> " + esc(law.year) + "</span>");
    if (law.fek) bits.push("<span>" + esc(law.fek) + "</span>");
    meta.innerHTML = bits.join("");

    var tagWrap = node.querySelector(".law-card__tags");
    (law.tags || []).slice(0, 6).forEach(function (t) {
      var s = document.createElement("button");
      s.type = "button";
      s.className = "tag";
      s.textContent = t;
      s.addEventListener("click", function () { setQuery(t); });
      tagWrap.appendChild(s);
    });

    var link = node.querySelector(".law-card__fulltext");
    link.href = sourceUrl(law);

    var cite = node.querySelector(".law-card__cite");
    cite.addEventListener("click", function () { copyCitation(cite, law); });

    return node;
  }

  function copyCitation(btn, law) {
    var text = citation(law);
    var done = function () {
      var orig = btn.textContent;
      btn.textContent = "✓ Αντιγράφηκε";
      btn.classList.add("copied");
      setTimeout(function () { btn.textContent = orig; btn.classList.remove("copied"); }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, cb) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); cb && cb();
  }

  /* --------- Κύρια απόδοση (render) --------- */
  function currentList() {
    var terms = tokenize(state.query);
    var list = LAWS;
    if (state.cat) list = list.filter(function (l) { return l.category === state.cat; });
    if (terms.length) {
      list = list
        .map(function (l) { return { law: l, s: score(l, terms) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s || b.law.year - a.law.year; })
        .map(function (x) { return x.law; });
    } else {
      list = list.slice().sort(function (a, b) {
        return (b.year - a.year) || a.title.localeCompare(b.title, "el");
      });
    }
    return { list: list, terms: terms };
  }

  function render() {
    // ενημέρωση chips
    Array.prototype.forEach.call(filterBar.children, function (chip) {
      chip.setAttribute("aria-pressed", (chip.dataset.cat || null) === (state.cat || "") && state.cat ? "true" : "false");
    });
    // «Όλα» ενεργό όταν δεν υπάρχει κατηγορία
    if (filterBar.firstChild) filterBar.firstChild.setAttribute("aria-pressed", state.cat ? "false" : (state.query ? "false" : "false"));

    // Φέρνει το ενεργό chip κατηγορίας σε ορατό σημείο στη μπάρα (χρήσιμο σε κινητά)
    if (state.cat) {
      var activeChip = filterBar.querySelector('.filter-chip[aria-pressed="true"]');
      if (activeChip && filterBar.scrollWidth > filterBar.clientWidth + 4) {
        var cr = activeChip.getBoundingClientRect(), fr = filterBar.getBoundingClientRect();
        if (cr.left < fr.left + 8 || cr.right > fr.right - 8) filterBar.scrollLeft += (cr.left - fr.left) - 16;
      }
    }

    clearBtn.hidden = !state.query;

    var idle = !state.query && !state.cat;
    categoryGrid.hidden = !idle;

    var res = currentList();

    if (idle) {
      resultsTitle.textContent = "Όλες οι κατηγορίες δικαίου";
      resultsMeta.textContent = "Επιλέξτε κατηγορία ή χρησιμοποιήστε την αναζήτηση.";
      resultsList.innerHTML = "";
      emptyState.hidden = true;
      return;
    }

    // τίτλος
    var title;
    if (state.cat && state.query) title = catIcon(state.cat) + " " + catLabel(state.cat) + " · «" + state.query + "»";
    else if (state.cat) title = catIcon(state.cat) + " " + catLabel(state.cat);
    else title = "Αποτελέσματα για «" + state.query + "»";
    resultsTitle.textContent = title;

    resultsMeta.textContent = res.list.length
      ? (res.list.length + (res.list.length === 1 ? " νομοθέτημα" : " νομοθετήματα"))
      : "";

    resultsList.innerHTML = "";
    if (!res.list.length) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    var frag = document.createDocumentFragment();
    res.list.forEach(function (law) { frag.appendChild(makeCard(law, res.terms)); });
    resultsList.appendChild(frag);
  }

  /* --------- Ενέργειες κατάστασης --------- */
  function setQuery(q) {
    state.query = q || "";
    searchInput.value = state.query;
    syncHash();
    render();
    scrollToResults();
  }
  function setCategory(id) {
    state.cat = id || null;
    syncHash();
    render();
    scrollToResults();
  }
  function resetAll() {
    state.query = ""; state.cat = null; searchInput.value = "";
    syncHash();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function scrollToResults() {
    var main = document.getElementById("main");
    if (!main) return;
    var y = main.getBoundingClientRect().top + window.pageYOffset - 12;
    if (window.pageYOffset < y - 40 || window.pageYOffset > y + 200) window.scrollTo({ top: y, behavior: "smooth" });
  }

  /* --------- Συγχρονισμός με URL (#q=&cat=) --------- */
  var hashLock = false;
  function syncHash() {
    hashLock = true;
    var p = [];
    if (state.query) p.push("q=" + encodeURIComponent(state.query));
    if (state.cat) p.push("cat=" + encodeURIComponent(state.cat));
    var h = p.join("&");
    if (h) location.hash = h; else history.replaceState(null, "", location.pathname + location.search);
    setTimeout(function () { hashLock = false; }, 0);
  }
  function readHash() {
    var h = location.hash.replace(/^#/, "");
    var q = "", cat = null;
    h.split("&").forEach(function (pair) {
      var kv = pair.split("=");
      if (kv[0] === "q") q = decodeURIComponent(kv[1] || "");
      if (kv[0] === "cat") { var c = decodeURIComponent(kv[1] || ""); if (CAT_BY_ID[c]) cat = c; }
    });
    state.query = q; state.cat = cat;
    searchInput.value = q;
  }

  /* --------- Θέμα (light/dark) --------- */
  var THEME_KEY = "nomothesion_theme";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    var icon = document.querySelector(".theme-icon");
    if (icon) icon.textContent = t === "dark" ? "☀️" : "🌙";
  }
  function initTheme() {
    var saved = lsGet(THEME_KEY);
    var t = saved || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(t);
    var btn = $("#themeToggle");
    if (btn) btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var next = cur === "dark" ? "light" : "dark";
      lsSet(THEME_KEY, next);
      applyTheme(next);
    });
  }

  /* --------- Επιλογέας πηγής --------- */
  function initSourceSelect() {
    var sel = $("#sourceSelect");
    if (!sel) return;
    var saved = lsGet(SOURCE_KEY) || "google";
    sel.value = saved;
    sel.addEventListener("change", function () {
      lsSet(SOURCE_KEY, sel.value);
      render(); // ανανέωση συνδέσμων
    });
  }

  /* --------- Συμβάντα --------- */
  function initEvents() {
    var deb;
    searchInput.addEventListener("input", function () {
      clearTimeout(deb);
      deb = setTimeout(function () {
        state.query = searchInput.value.trim();
        clearBtn.hidden = !state.query;
        syncHash();
        render();
      }, 110);
    });
    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { searchInput.value = ""; state.query = ""; syncHash(); render(); }
      if (e.key === "Enter") { e.preventDefault(); scrollToResults(); }
    });
    clearBtn.addEventListener("click", function () {
      searchInput.value = ""; state.query = ""; clearBtn.hidden = true; syncHash(); render(); searchInput.focus();
    });
    var brand = document.querySelector(".brand");
    if (brand) brand.addEventListener("click", function (e) { e.preventDefault(); resetAll(); });
    var rfe = $("#resetFromEmpty");
    if (rfe) rfe.addEventListener("click", resetAll);

    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== searchInput &&
          !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "")) {
        e.preventDefault(); searchInput.focus();
      }
    });

    window.addEventListener("hashchange", function () {
      if (hashLock) return;
      readHash(); render();
    });
  }

  /* --------- Εκκίνηση --------- */
  function init() {
    if (!LAWS.length) {
      resultsList.innerHTML = "<p>Δεν φορτώθηκαν δεδομένα νομοθεσίας.</p>";
      return;
    }
    initStats();
    initQuickTags();
    initFilters();
    initCategoryGrid();
    initTheme();
    initSourceSelect();
    initEvents();
    readHash();
    render();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
