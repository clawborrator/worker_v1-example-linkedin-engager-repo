#!/usr/bin/env node
//
// linkedin.js. Playwright wrapper used by the LinkedIn engager
// agent.
//
// Five subcommands, each prints JSON to stdout and exits:
//   auth-check                              verify cookies still log in
//   scroll-feed --count N --feed F          fetch posts from a feed
//   read-post <post-url>                    fetch a post body + comments
//   comment-post <post-url> --text "..."    leave a top-level comment
//   reply-comment <permalink> --text "..."  reply to an existing comment
//
// Cookies are loaded from /secrets/linkedin.cookies.json
// (read-only mount). Expected format: top-level array of objects
// in Playwright's addCookies() shape. Cookie-Editor /
// EditThisCookie exports work; the loader normalizes the
// `sameSite` field across exporter formats.
//
// Selector strategy. Modern LinkedIn is a React SPA with hashed
// class names (`.feed-shared-update-v2__description--abc123`).
// CSS-class selectors break monthly. The SELECTORS object below
// leans on stable signals where possible:
//   - URN attributes (data-id="urn:li:activity:...") are stable
//   - aria-label attributes are stable (accessibility-driven)
//   - role attributes are stable (semantic)
//   - data-test-id attributes are stable when present
//   - text selectors work but are i18n-fragile
// When selectors break, this is the one file to patch.
//
// Same architectural lesson as the Reddit wrapper: this is pure
// Playwright + DOM extraction. NO judgment. The agent (Claude)
// does all judgment between subcommand calls in its own turn.

'use strict';

// playwright-extra is a drop-in wrapper around playwright that
// supports plugins. The stealth plugin patches navigator.webdriver,
// chrome.runtime, the plugins array, WebGL fingerprint, canvas
// hash, language headers, and ~10 other detectable headless
// signals. Combined with `headless: false` under Xvfb (see
// CLAUDE.md, every node call is wrapped in `xvfb-run -a`), this
// is the best we can do against hostile anti-bot stacks without
// a managed-browser service. It is not bulletproof; LinkedIn
// updates its detection regularly. Plan for sessions to die
// faster than on Reddit and re-export cookies as a routine event.
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');

// ─── Config ────────────────────────────────────────────────────

// Persistent browser profile. The LinkedIn session is established once
// by a human login (the `login` subcommand) and persists here across
// runs, so the worker reuses a native session instead of importing
// cookies (which LinkedIn rejects). Mounted as a volume in compose.
const PROFILE_DIR = process.env.LINKEDIN_PROFILE_DIR || '/profile';

const BASE = 'https://www.linkedin.com';

// The feed/post/comment reading is done via the voyager JSON API and
// the comment WRITE via the live composer (see below), so the only DOM
// selectors left are the anti-bot challenge signals that assertNotChallenged
// checks against any page we load.
const SELECTORS = {
  captchaIframe:       'iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="captcha" i]',
  authChallengePage:   ':text("Let us verify it\'s really you")',
  rateLimitNotice:     ':text("Try again later"), :text("You\'ve reached the weekly invitation limit"), :text("temporarily restricted")',
  loginRedirectMarker: 'form[action*="checkpoint"], a[href*="/login"]',
};

// ─── Helpers ──────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function die(error, details) {
  emit({ ok: false, error, ...(details ? { details } : {}) });
  process.exit(1);
}

async function newContext() {
  // headless: false plus Xvfb (see CLAUDE.md) removes the
  // headless-chromium fingerprint signal. The stealth plugin
  // imported at the top of this file patches the remaining
  // common tells (navigator.webdriver, chrome.runtime, plugins,
  // WebGL, canvas, languages). Requires DISPLAY env to be set,
  // which xvfb-run does automatically.
  // Persistent profile: the session was established once by a human
  // login (see the `login` subcommand) and lives on disk in
  // PROFILE_DIR. No cookie import, so there is no "replayed session"
  // for LinkedIn to reject. UA is a plain Linux Chrome to match the
  // actual browser (no Windows/Linux fingerprint mismatch).
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    viewport:   { width: 1366, height: 900 },
    userAgent:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/Chicago',
  });
  // launchPersistentContext has no separate Browser (ctx.browser() is
  // null), so expose a close() shim that tears down the context. This
  // keeps every caller's `await browser.close()` working unchanged.
  const browser = ctx.browser() || { close: () => ctx.close() };
  return { browser, ctx };
}

async function gotoWithRetry(page, url) {
  // LinkedIn slows authenticated sessions after writes. 60s
  // timeout + one TimeoutError-only retry with 3s backoff,
  // matching the Reddit wrapper's pattern. networkidle on
  // LinkedIn never settles (always-on telemetry), so
  // domcontentloaded is what we wait for; an explicit
  // waitForSelector at the call site picks up where we need
  // actual content.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      lastErr = e;
      const isTimeout = e?.name === 'TimeoutError' || /Timeout/i.test(e?.message ?? '');
      if (!isTimeout || attempt === 1) throw e;
      await page.waitForTimeout(3_000);
    }
  }
  throw lastErr;
}

// Where failure screenshots land. In-repo so the agent commits
// them as part of its audit step and they show up on GitHub
// directly viewable in the file browser. Browsable history of
// every cycle's failure mode without docker exec or docker cp.
const SCREENSHOTS_DIR = '/workspace/repo/data/screenshots';

async function snapshotOnFailure(page, errorTag) {
  // Dump a full-page screenshot to the in-repo screenshots
  // directory so it gets committed + pushed on the next audit
  // step and is viewable in the GitHub UI. Especially useful
  // for the partial-cookie-validity case where auth-check
  // passes (the feed shell loads) but interactive requests
  // later get redirected to login. The screenshot tells you
  // whether the page is the actual login form, an "is this
  // you?" interstitial, a captcha, or something else. Returns
  // the relative repo path on success, null on capture failure.
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } catch {
    // Continue even if mkdir fails; screenshot() below will
    // surface the real error.
  }
  const filename = `${errorTag}-${Date.now()}.png`;
  const absolutePath = `${SCREENSHOTS_DIR}/${filename}`;
  const repoRelativePath = `data/screenshots/${filename}`;
  try {
    await page.screenshot({ path: absolutePath, fullPage: false });
    return repoRelativePath;
  } catch {
    return null;
  }
}

function emitFailureWithScreenshot(error, details, screenshotRepoPath) {
  emit({
    ok: false,
    error,
    ...(details ? { details } : {}),
    ...(screenshotRepoPath
      ? {
          screenshot_path: screenshotRepoPath,
          retrieve_hint: `the screenshot is in the repo at ${screenshotRepoPath} and will be on GitHub after the agent's next audit commit; you can also open it locally with \`open /workspace/repo/${screenshotRepoPath}\` from inside the container`,
        }
      : {}),
  });
  process.exit(1);
}

async function assertNotChallenged(page) {
  // If LinkedIn dropped a captcha, auth challenge, or rate-limit
  // page, snapshot the visible state to /tmp then bail with a
  // typed error so the agent can react. Also catches the silent-
  // redirect-to-login case (cookies expired or partially valid
  // mid-cycle).
  if (await page.locator(SELECTORS.captchaIframe).count() > 0) {
    const snap = await snapshotOnFailure(page, 'captcha');
    emitFailureWithScreenshot('captcha', undefined, snap);
  }
  if (await page.locator(SELECTORS.authChallengePage).count() > 0) {
    const snap = await snapshotOnFailure(page, 'auth-challenge');
    emitFailureWithScreenshot('auth_lost_mid_cycle', 'LinkedIn challenged the session with an identity verification page', snap);
  }
  if (await page.locator(SELECTORS.rateLimitNotice).count() > 0) {
    const snap = await snapshotOnFailure(page, 'rate-limited');
    emitFailureWithScreenshot('rate_limited', undefined, snap);
  }
  if (await page.locator(SELECTORS.loginRedirectMarker).count() > 0) {
    const snap = await snapshotOnFailure(page, 'login-redirect');
    emitFailureWithScreenshot('auth_lost_mid_cycle', 'page redirected to login form', snap);
  }
}

function ageHoursFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return Math.round((Date.now() - d.getTime()) / 3_600_000);
}

// LinkedIn renders post age as relative text ("3h", "2d", "1w").
function parseRelativeAge(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+)\s*(m|h|d|w|mo|y)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  switch (u) {
    case 'm':  return n / 60;
    case 'h':  return n;
    case 'd':  return n * 24;
    case 'w':  return n * 24 * 7;
    case 'mo': return n * 24 * 30;
    case 'y':  return n * 24 * 365;
    default:   return null;
  }
}

// ─── Voyager JSON API ─────────────────────────────────────────
// LinkedIn's web UI migrated the feed to a Server-Driven UI (hashed
// classes, no URNs in the DOM), so DOM scraping of the feed is dead.
// The underlying voyager JSON API is intact, though, and returns clean
// normalized data. We call it from inside the authenticated page
// context (so cookies + the csrf-token from JSESSIONID come along) and
// parse the normalized {data, included} envelope. This is far more
// stable than CSS-class or SDUI-tree scraping.

// GET a voyager path from within the logged-in page; returns {status, text}.
async function voyagerGet(page, path) {
  return await page.evaluate(async (p) => {
    const jsid = (document.cookie.split('; ').find((c) => c.startsWith('JSESSIONID=')) || '').split('=')[1]?.replace(/"/g, '') || '';
    const r = await fetch(p, {
      headers: {
        'csrf-token': jsid,
        'x-restli-protocol-version': '2.0.0',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
      },
      credentials: 'include',
    });
    let text = '';
    try { text = await r.text(); } catch { /* empty */ }
    return { status: r.status, text };
  }, path);
}

// Plain text out of a voyager TextViewModel.
function tvmText(tvm) {
  return tvm && typeof tvm.text === 'string' ? tvm.text.trim() : null;
}

// Look up a member's network distance (DISTANCE_1/2/3, OUT_OF_NETWORK,
// SELF) by publicIdentifier. The old networkinfo endpoint is gone (410);
// the dash profile WITH the WebTopCard decoration carries the
// memberRelationship/distance. Returns null on any failure.
async function lookupDistance(page, publicId) {
  if (!publicId) return null;
  const url = `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-6`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await voyagerGet(page, url);
      if (r.status === 200) {
        const d = (r.text.match(/DISTANCE_\d|OUT_OF_NETWORK|SELF/) || [])[0];
        if (d) return d;
      }
    } catch { /* retry */ }
    await page.waitForTimeout(900); // ease off LinkedIn's per-call throttle
  }
  return null;
}

// Pull a member's profile photo from the dash profile API. The DOM <img>
// is lazy-loaded (its src is swapped in by LinkedIn's JS on render), so in
// the headless engager it is usually still empty when we snapshot, leaving
// photo_url null. The same WebTopCardCore decoration that carries the
// network distance also carries profilePicture.displayImageReference, so we
// build the URL straight from the API artifacts (largest one). The returned
// CDN URL is time-signed and won't hotlink cross-origin, but it is correct
// for record-keeping. Returns null on any failure.
function vectorImageUrl(pic) {
  const v = pic && pic.displayImageReference && pic.displayImageReference.vectorImage;
  if (!v || !v.rootUrl || !Array.isArray(v.artifacts) || !v.artifacts.length) return null;
  const a = [...v.artifacts].sort((x, y) => (y.width || 0) - (x.width || 0))[0];
  return v.rootUrl + (a.fileIdentifyingUrlPathSegment || '');
}
async function lookupPhoto(page, publicId) {
  if (!publicId) return null;
  const want = publicId.toLowerCase();
  const url = `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-6`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await voyagerGet(page, url);
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        // `included` also carries the VIEWER's own profile (the logged-in
        // engager account), so match the queried person by
        // publicIdentifier. Taking the first profilePicture returns the
        // engager's own photo for everyone.
        for (const e of j.included || []) {
          if (e && e.publicIdentifier && e.publicIdentifier.toLowerCase() === want && e.profilePicture) {
            const u = vectorImageUrl(e.profilePicture);
            if (u) return u;
          }
        }
      }
    } catch { /* retry */ }
    await page.waitForTimeout(900); // ease off LinkedIn's per-call throttle
  }
  return null;
}

// Index a normalized `included` array by every URN it can be referenced
// under (entityUrn + dashEntityUrn), for resolving `*`-prefixed refs.
function indexIncluded(included) {
  const idx = new Map();
  for (const e of included || []) {
    if (e.entityUrn) idx.set(e.entityUrn, e);
    if (e.dashEntityUrn) idx.set(e.dashEntityUrn, e);
  }
  return idx;
}

// Parse a /feed/updatesV2 normalized response into the post shape the
// playbook expects (same fields the old DOM scraper produced).
function parseUpdatesV2(json) {
  const elements = (json.data && json.data['*elements']) || [];
  const idx = indexIncluded(json.included);
  const out = [];
  for (const elUrn of elements) {
    const u = idx.get(elUrn);
    if (!u || !String(u['$type'] || '').endsWith('render.UpdateV2')) continue;
    const activityUrn = (String(elUrn).match(/urn:li:activity:\d+/) || [])[0] || null;
    const actor = u.actor || {};
    let reactionCount = null, commentCount = null;
    const sd = u['*socialDetail'] ? idx.get(u['*socialDetail']) : null;
    if (sd) {
      const sc = sd['*totalSocialActivityCounts'] ? idx.get(sd['*totalSocialActivityCounts']) : null;
      if (sc) {
        reactionCount = typeof sc.numLikes === 'number' ? sc.numLikes : null;
        commentCount = typeof sc.numComments === 'number' ? sc.numComments : null;
      }
    }
    const body = (u.commentary && tvmText(u.commentary.text)) || '';
    const postUrl = activityUrn
      ? `${BASE}/feed/update/${activityUrn}/`
      : (u.socialContent && u.socialContent.shareUrl) || null;
    out.push({
      urn: activityUrn,
      author: tvmText(actor.name),
      author_headline: tvmText(actor.description),
      // body_excerpt is what the feed listing exposes; body (full) is
      // kept for read-post and stripped by scroll-feed before emit.
      body_excerpt: body.slice(0, 500),
      body,
      post_url: postUrl,
      reaction_count: reactionCount,
      comment_count: commentCount,
      age_hours: parseRelativeAge(tvmText(actor.subDescription)),
      is_promoted: /sponsoredContentV2|sponsored/i.test(String(elUrn)),
      is_repost: !!(u.resharedUpdate || u['*resharedUpdate']),
    });
  }
  return out;
}

// Flatten a voyager AnnotatedText / TextViewModel comment body to text.
function annotatedText(at) {
  if (!at) return '';
  if (typeof at.text === 'string') return at.text;
  if (Array.isArray(at.values)) return at.values.map((v) => (v && v.value) || '').join('');
  return '';
}

function ageHoursFromMs(ms) {
  if (!ms) return null;
  return Math.round((Date.now() - ms) / 3_600_000);
}

// Parse a /feed/comments normalized response into the comment shape the
// playbook expects.
function parseComments(json) {
  const elements = (json.data && json.data['*elements']) || [];
  const idx = indexIncluded(json.included);
  const out = [];
  for (const elUrn of elements) {
    const c = idx.get(elUrn);
    if (!c || !String(c['$type'] || '').endsWith('.Comment')) continue;
    const commenter = c.commenter || {};
    const mp = commenter['*miniProfile'] ? idx.get(commenter['*miniProfile']) : null;
    const author = mp ? [mp.firstName, mp.lastName].filter(Boolean).join(' ').trim() : null;
    const headline = (mp && mp.occupation) || tvmText(c.headline) || null;
    let reactionCount = null;
    const sd = c['*socialDetail'] ? idx.get(c['*socialDetail']) : null;
    if (sd) {
      const sc = sd['*totalSocialActivityCounts'] ? idx.get(sd['*totalSocialActivityCounts']) : null;
      if (sc && typeof sc.numLikes === 'number') reactionCount = sc.numLikes;
    }
    out.push({
      id: c.urn || null,
      author: author || null,
      author_headline: headline,
      body: annotatedText(c.comment || c.commentV2),
      reaction_count: reactionCount,
      age_hours: ageHoursFromMs(c.createdTime),
      permalink: c.permalink || null,
      depth: c.parentCommentUrn ? 1 : 0,
      parent_id: c.parentCommentUrn || null,
    });
  }
  return out;
}

// Extract the PEOPLE engaging on a post from its comments response: each
// commenter with their profile handle, headline, network distance, and
// what they said (a relevance signal). For the "who should I contact"
// flow. Deduped by person.
function harvestCommenters(json) {
  const elements = (json.data && json.data['*elements']) || [];
  const idx = indexIncluded(json.included);
  const seen = new Set();
  const out = [];
  for (const elUrn of elements) {
    const c = idx.get(elUrn);
    if (!c || !String(c['$type'] || '').endsWith('.Comment')) continue;
    const commenter = c.commenter || {};
    const mp = commenter['*miniProfile'] ? idx.get(commenter['*miniProfile']) : null;
    if (!mp) continue;
    const publicId = mp.publicIdentifier || null;
    const key = publicId || commenter.urn || `${mp.firstName} ${mp.lastName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      role: 'commenter',
      name: [mp.firstName, mp.lastName].filter(Boolean).join(' ').trim() || null,
      headline: mp.occupation || null,
      public_id: publicId,
      profile_url: publicId ? `${BASE}/in/${publicId}/` : null,
      member_urn: commenter.urn || null,
      network_distance: (commenter.distance && commenter.distance.value) || null,
      signal: annotatedText(c.comment || c.commentV2).replace(/\s+/g, ' ').slice(0, 220),
    });
  }
  return out;
}

// Pull the post author as a person record (from a detail updatesV2 json).
function harvestAuthor(detailJson) {
  const idx = indexIncluded(detailJson.included);
  for (const el of (detailJson.data && detailJson.data['*elements']) || []) {
    const u = idx.get(el);
    if (!u || !String(u['$type'] || '').endsWith('render.UpdateV2')) continue;
    const a = u.actor || {};
    const target = (a.navigationContext && a.navigationContext.actionTarget) || '';
    const pub = (target.match(/\/in\/([^/?]+)/) || [])[1] || null;
    return {
      role: 'author',
      name: tvmText(a.name),
      headline: tvmText(a.description),
      public_id: pub,
      profile_url: pub ? `${BASE}/in/${pub}/` : (target || null),
      member_urn: a.urn || null,
      network_distance: null,
      signal: 'authored this post',
    };
  }
  return null;
}

// ─── Subcommand: auth-check ───────────────────────────────────

async function cmdAuthCheck() {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  let screenshotPath = null;

  // Helper: checks the current URL against the dead-cookie redirect
  // patterns and bails (with screenshot) if it matches. Useful for
  // both the post-goto check AND any re-check after waiting, because
  // LinkedIn does client-side JS redirects to /login after the
  // initial /feed/ load when the session is partially valid.
  const checkUrlAndMaybeBail = async (label) => {
    const url = page.url();
    if (/\/login\b|\/uas\/login\b|\/checkpoint\b|\/signup\b/i.test(url)) {
      const snap = await snapshotOnFailure(page, 'auth-check-redirected');
      emit({
        ok: false,
        error: 'not logged in',
        final_url: url,
        when: label,
        screenshot_path: snap,
        retrieve_hint: snap
          ? `the screenshot is in the repo at ${snap} and will be on GitHub after the agent's next audit commit`
          : 'screenshot capture failed',
        hint: 'LinkedIn redirected to login or checkpoint. Cookies are expired, partial, or exported from a different account. Re-export from a fully-logged-in browser session on /feed/ (not the landing page) and include ALL cookies in the export.',
      });
      process.exit(2);
    }
    return url;
  };

  try {
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);

    // PRIMARY signal: final URL after navigation. If LinkedIn
    // bounced an unauthenticated request to /login, /uas/login,
    // /checkpoint, or /signup, the cookies are dead.
    await checkUrlAndMaybeBail('post-goto');

    // LinkedIn is a React SPA. domcontentloaded fires before
    // React has hydrated the shell, so the nav + profile photo
    // selectors below would all miss against an un-hydrated DOM.
    // Wait for the nav region to render or for a short timeout,
    // whichever comes first. networkidle never settles on
    // LinkedIn (always-on telemetry), so don't use that.
    await page.waitForSelector(
      'nav, header, [role="banner"], main, [role="main"]',
      { timeout: 10_000, state: 'attached' },
    ).catch(() => {});
    // Plus a small fixed wait to let React finish first-paint
    // for the nav-internal elements (photo, links). During this
    // wait LinkedIn's client-side JS can detect a partial-cookie
    // session and trigger a client-side redirect to /login,
    // killing the JS execution context. The re-check below
    // catches that case before we start querying the (now-dead)
    // page.
    await page.waitForTimeout(2_500);

    // After hydration wait, re-verify the URL. Partial-cookie
    // sessions land here.
    const finalUrl = await checkUrlAndMaybeBail('post-hydration-wait');

    // SECONDARY signal: presence of the global nav with profile
    // photo. LinkedIn hashes the CSS classes on these regularly,
    // so try several known-stable patterns in order. The whole
    // loop is wrapped because LinkedIn can client-side-navigate
    // away mid-query when cookies are partially valid; the
    // "Execution context was destroyed" error is its signature.
    // On catch, re-verify URL (which may now be a login page) so
    // the failure attributes correctly.
    const photoSelectors = [
      'header img.global-nav__me-photo',
      'img.global-nav__me-photo',
      'img[alt^="Photo of "]',
      '[data-test-global-nav-me] img',
      'nav img[id^="ember"][alt*="profile" i]',
      'button[data-control-name="nav.settings"]',
    ];
    let displayName = null;
    let photoFound = false;
    try {
      for (const sel of photoSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() === 0) continue;
        photoFound = true;
        const alt = await loc.getAttribute('alt').catch(() => null);
        const aria = await loc.getAttribute('aria-label').catch(() => null);
        if (alt) {
          displayName = alt.replace(/^Photo of\s+/i, '').trim();
          break;
        }
        if (aria) {
          displayName = aria.trim();
          break;
        }
        displayName = '(photo found, name not extracted)';
        break;
      }
    } catch (e) {
      if (/Execution context was destroyed/i.test(e.message ?? '')) {
        // The page navigated under us; let the URL check decide
        // whether this is "redirected to login" (dead cookies)
        // or something stranger.
        await page.waitForTimeout(1_000);
        await checkUrlAndMaybeBail('mid-photo-query');
        // If checkUrlAndMaybeBail returned (URL still ok), the
        // photo query is stale but the page is fine. Fall through
        // to the tertiary nav-presence check.
      } else {
        throw e;
      }
    }

    // TERTIARY signal (only fires if the URL check passed but no
    // photo selector matched): look for the global nav itself.
    // If even that is missing, the page is in some unexpected
    // state and we should bail conservatively. Save a screenshot
    // first so the operator can SEE what the page looked like
    // without needing to instrument the container.
    if (!photoFound) {
      const navPresent = (await page.locator('nav.global-nav, header.global-nav, [role="banner"] nav, nav, header').count()) > 0;
      if (navPresent) {
        emit({
          ok: true,
          logged_in_as: '(no display name extracted; global nav present)',
          final_url: finalUrl,
          warning: 'profile-photo selectors all stale; LinkedIn DOM may have shifted. Engager will keep working but display name will read this placeholder. Update the photoSelectors list in cmdAuthCheck when convenient.',
        });
        return;
      }
      screenshotPath = await snapshotOnFailure(page, 'auth-check-fail');
      emit({
        ok: false,
        error: 'not logged in',
        final_url: finalUrl,
        screenshot_path: screenshotPath,
        retrieve_hint: screenshotPath
          ? `the screenshot is in the repo at ${screenshotPath} and will be on GitHub after the agent's next audit commit`
          : 'screenshot capture failed too',
        hint: 'URL did not redirect to login but no nav/header/profile-photo found after waiting for React hydration. Pull the screenshot to inspect what the page actually rendered (interstitial dialog, account-restriction page, captcha, or genuinely stale selectors).',
      });
      process.exit(2);
    }

    emit({ ok: true, logged_in_as: displayName, final_url: finalUrl });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    // Outermost catch. Try to snapshot whatever page state IS
    // visible before exiting so the operator has something to
    // look at even on uncaught errors. screenshot() may itself
    // throw if the browser is in a weird state; swallow that.
    const snap = await snapshotOnFailure(page, 'auth-check-uncaught').catch(() => null);
    const currentUrl = await page.url().catch(() => null);
    emitFailureWithScreenshot('auth_check_failed', `${e.message}${currentUrl ? ` | url at failure: ${currentUrl}` : ''}`, snap);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: scroll-feed ──────────────────────────────────

async function cmdScrollFeed(args) {
  const count = parseInt(args.count || '15', 10);
  const feedArg = args.feed || 'home';
  if (feedArg !== 'home' && !feedArg.startsWith('hashtag:')) {
    die('bad_feed', `unknown feed "${feedArg}". Use home or hashtag:<name>`);
  }
  if (feedArg.startsWith('hashtag:')) {
    // The hashtag feed used a separate DOM page that the SDUI migration
    // also reshaped; the voyager path differs from the home feed. Not
    // ported yet. The engager defaults to home.
    die('unsupported_feed', 'hashtag feeds are not supported on the voyager API path yet; use the home feed');
  }

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    // Land on /feed/ first so the voyager fetch runs in a fully
    // initialized authenticated page context (cookies + csrf available).
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);

    // The feed DOM is now a Server-Driven UI with no post URNs, so we
    // read the underlying voyager JSON API. Pull from BOTH the relevance
    // feed (q=feed, what the member sees on screen, surfaces older
    // high-signal posts) AND the recent feed (q=chronFeed), then merge +
    // dedupe by URN, for broad coverage of on-target posts. Fetch at
    // least 20 from each source regardless of `count`.
    const fetchN = Math.max(count, 20);
    const seen = new Set();
    const posts = [];
    let any200 = false;
    for (const q of ['feed', 'chronFeed']) {
      const resp = await voyagerGet(page, `/voyager/api/feed/updatesV2?count=${fetchN}&q=${q}`);
      if (resp.status !== 200) continue;
      any200 = true;
      let json;
      try { json = JSON.parse(resp.text); } catch { continue; }
      for (const p of parseUpdatesV2(json)) {
        if (!p.urn || !p.author || seen.has(p.urn)) continue; // drop ads/junk w/o an author
        seen.add(p.urn);
        delete p.body; // feed listing uses body_excerpt only
        posts.push(p);
      }
    }
    if (!any200) die('scroll_feed_failed', 'both voyager feeds returned non-200');
    emit({ ok: true, feed: feedArg, sources: ['feed', 'chronFeed'], posts });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('scroll_feed_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: read-post ────────────────────────────────────

async function cmdReadPost(postUrl) {
  if (!postUrl) die('missing_arg', 'read-post requires a post URL');
  const activityUrn = (String(postUrl).match(/urn:li:activity:\d+/) || [])[0] || null;
  if (!activityUrn) die('read_post_failed', `could not extract an activity URN from ${postUrl}`);

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    // Land on /feed/ so the voyager fetches run in an authenticated,
    // initialized page context (cookies + csrf available).
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);

    // Post detail via the voyager JSON API (the DOM is SDUI with no URNs).
    // q=backendUrnOrNss returns the requested update; moduleKey=feed-update-by-urn
    // does NOT (it returns an unrelated feed item).
    const detailResp = await voyagerGet(page, `/voyager/api/feed/updatesV2?q=backendUrnOrNss&urnOrNss=${encodeURIComponent(activityUrn)}`);
    if (detailResp.status !== 200) die('read_post_failed', `voyager post detail returned status ${detailResp.status}`);
    let detailJson;
    try { detailJson = JSON.parse(detailResp.text); }
    catch (e) { die('read_post_failed', `post JSON parse failed: ${e.message}`); }
    const parsed = parseUpdatesV2(detailJson);
    const post = parsed[0] || {};

    // Comments via the voyager comments endpoint.
    const commentsResp = await voyagerGet(page, `/voyager/api/feed/comments?count=60&q=comments&sortOrder=RELEVANCE&start=0&updateId=${encodeURIComponent(activityUrn)}`);
    let comments = [];
    if (commentsResp.status === 200) {
      try { comments = parseComments(JSON.parse(commentsResp.text)).slice(0, 60); }
      catch { comments = []; }
    }

    emit({
      ok: true,
      post: {
        urn: post.urn || activityUrn,
        author: post.author || null,
        author_headline: post.author_headline || null,
        body: post.body || '',
        post_url: post.post_url || postUrl,
        reaction_count: post.reaction_count ?? null,
        comment_count: post.comment_count ?? null,
      },
      comments,
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('read_post_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── Composer helpers ─────────────────────────────────────────

// The new SDUI feed has no usable comment WRITE API (createComment is a
// server-driven action with opaque per-render binding tokens), so the
// write path drives the actual composer in the page and lets LinkedIn's
// own JS build the request. The editor is a shadow-DOM contenteditable
// labelled "Text editor for creating comment/reply"; Playwright role
// locators pierce shadow DOM to reach it.

async function fillAndSubmitComment(page, editor, text) {
  // Focus the comment editor (NOT the page search box), clear any draft,
  // type, then submit. Ctrl+Enter is LinkedIn's comment-submit shortcut
  // and sidesteps the two-"Comment"-buttons ambiguity (action bar vs
  // composer submit); a button click is the fallback.
  await editor.click({ timeout: 8_000 });
  await page.keyboard.press('Control+a').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await editor.pressSequentially(text, { delay: 12 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+Enter').catch(() => {});
  await page.waitForTimeout(2_500);
  // Fallback: if our text is still in the editor, the shortcut didn't
  // submit; click the composer's "Comment" button (the last one, not
  // the action-bar toggle).
  const still = ((await editor.textContent().catch(() => '')) || '').includes(text.trim().slice(0, 12));
  if (still) {
    await page.getByRole('button', { name: /^comment$/i }).last().click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
  }
}

// After posting, re-fetch the post's comments via the voyager API and
// find ours by matching body text, returning its permalink. Best-effort.
async function findOwnComment(page, activityUrn, text) {
  try {
    const r = await voyagerGet(page, `/voyager/api/feed/comments?count=30&q=comments&sortOrder=RELEVANCE&start=0&updateId=${encodeURIComponent(activityUrn)}`);
    if (r.status !== 200) return null;
    const needle = text.trim().slice(0, 40);
    const mine = parseComments(JSON.parse(r.text)).find((c) => (c.body || '').includes(needle));
    return mine ? mine.permalink : null;
  } catch { return null; }
}

// ─── Subcommand: comment-post ─────────────────────────────────

async function cmdCommentPost(postUrl, args) {
  if (!postUrl) die('missing_arg', 'comment-post requires a post URL');
  const text = args.text;
  if (!text || !text.trim()) die('missing_arg', 'comment-post requires --text "..."');

  const activityUrn = (String(postUrl).match(/urn:li:activity:\d+/) || [])[0] || null;
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, postUrl);
    await assertNotChallenged(page);
    await page.waitForTimeout(2_000);

    // Open the composer (action-bar Comment button), then target the
    // comment editor by its label so we never type into the search box.
    const openBtn = page.locator('button[aria-label^="Comment"]').first();
    if (await openBtn.count() > 0) { await openBtn.click().catch(() => {}); await page.waitForTimeout(1_500); }
    const editor = page.getByRole('textbox', { name: /comment/i }).first();
    if (await editor.count() === 0) {
      die('comment_form_not_found', 'comment editor not found (post locked, challenge, or DOM changed)');
    }
    await fillAndSubmitComment(page, editor, text);
    await assertNotChallenged(page);

    const commentUrl = activityUrn ? await findOwnComment(page, activityUrn, text) : null;
    emit({
      ok: true,
      comment_url: commentUrl,
      note: commentUrl ? 'posted and confirmed via voyager comments' : 'submitted; could not confirm a permalink via API (it may still have posted, verify via audit)',
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('comment_post_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: reply-comment ────────────────────────────────

async function cmdReplyComment(permalink, args) {
  if (!permalink) die('missing_arg', 'reply-comment requires a comment permalink');
  const text = args.text;
  if (!text || !text.trim()) die('missing_arg', 'reply-comment requires --text "..."');

  const activityUrn = (String(permalink).match(/urn:li:activity:\d+/) || [])[0] || null;
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, permalink);
    await assertNotChallenged(page);
    await page.waitForTimeout(2_500);

    // The permalink anchors to the target comment. Click its Reply
    // control (the first Reply button at the anchored position).
    const replyBtn = page.getByRole('button', { name: /^reply$/i }).first();
    if (await replyBtn.count() === 0) {
      die('comment_form_not_found', 'no Reply control found (locked, challenge, or DOM changed)');
    }
    await replyBtn.click().catch(() => {});
    await page.waitForTimeout(1_500);

    // The reply composer is a comment editor; target by label.
    const editor = page.getByRole('textbox', { name: /reply|comment/i }).first();
    if (await editor.count() === 0) {
      die('comment_form_not_found', 'reply editor did not appear after clicking Reply');
    }
    await fillAndSubmitComment(page, editor, text);
    await assertNotChallenged(page);

    const commentUrl = activityUrn ? await findOwnComment(page, activityUrn, text) : null;
    emit({
      ok: true,
      comment_url: commentUrl,
      note: commentUrl ? 'reply posted and confirmed via voyager comments' : 'reply submitted; could not confirm a permalink via API (it may still have posted, verify via audit)',
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('reply_comment_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── CLI dispatch ─────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); }
      else { out[a.slice(2)] = argv[i + 1]; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ─── Subcommand: login (one-time, human-driven via VNC) ───────
// Opens the persistent-profile browser on the current display and
// waits for a human to sign into LinkedIn by hand (VNC into the
// x11vnc session that the operator starts on this display). Once the
// feed is reached, the session is saved into PROFILE_DIR and every
// later cycle reuses it. No credentials are entered by this script.
async function cmdLogin() {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  await gotoWithRetry(page, BASE + '/login').catch(() => {});
  process.stderr.write('[login] Browser is open. VNC in and sign into LinkedIn by hand.\n');
  process.stderr.write('[login] Handle any 2FA or captcha yourself. Waiting up to 15 min for you to reach /feed/...\n');
  const deadline = Date.now() + 15 * 60 * 1000;
  let loggedIn = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    let url = '';
    try { url = page.url(); } catch { continue; }
    if (/\/feed\/?(\?|$)/.test(url) && !/\/login|\/uas|\/checkpoint|\/signup/i.test(url)) {
      loggedIn = true;
      break;
    }
  }
  // Closing flushes the persistent profile to disk either way.
  await browser.close().catch(() => {});
  if (loggedIn) {
    emit({ ok: true, logged_in: true, profile: PROFILE_DIR, note: 'session saved to persistent profile; cycles will reuse it' });
  } else {
    emit({ ok: false, error: 'login_timeout', profile: PROFILE_DIR, note: 'did not detect /feed within 15 min; whatever state you reached was still saved to the profile' });
  }
}

// ─── Subcommand: my-profile ───────────────────────────────────
// Returns the logged-in member's own name, headline, full About text,
// and full Experience text, so the agent can derive a target audience.
// The old voyager profileView endpoint is gone (410) and the new dash
// endpoints need versioned queryIds, so About/Experience are read as
// rendered page text (robust, and the agent reasons over text anyway).
async function cmdMyProfile() {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);

    const me = await voyagerGet(page, '/voyager/api/me');
    const pub = (me.text.match(/"publicIdentifier":"([^"]+)"/) || [])[1] || null;
    const firstName = (me.text.match(/"firstName":"([^"]*)"/) || [])[1] || '';
    const lastName = (me.text.match(/"lastName":"([^"]*)"/) || [])[1] || '';
    const occupation = (me.text.match(/"occupation":"([^"]*)"/) || [])[1] || '';
    if (!pub) die('my_profile_failed', 'could not resolve own publicIdentifier from /voyager/api/me');

    const expandSeeMore = async () => {
      const mores = page.getByRole('button', { name: /see more|…more|show more|see full/i });
      const n = Math.min(await mores.count().catch(() => 0), 12);
      for (let i = 0; i < n; i++) { await mores.nth(i).click().catch(() => {}); await page.waitForTimeout(150); }
    };

    // About: the section anchored by #about on the main profile page.
    await gotoWithRetry(page, `${BASE}/in/${pub}/`);
    await assertNotChallenged(page);
    await page.waitForTimeout(3_000);
    await expandSeeMore();
    // Click the About section's own "…more" toggle to get the FULL text.
    await page.evaluate(() => {
      for (const sec of document.querySelectorAll('section')) {
        const h = sec.querySelector('h2, [role="heading"]');
        if (h && /^about\b/i.test(h.innerText.trim())) {
          const btn = [...sec.querySelectorAll('button')].find((b) => /\bmore\b/i.test(b.innerText || ''));
          if (btn) btn.click();
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(800);
    const about = await page.evaluate(() => {
      const clean = (t) => (t || '').replace(/^(About\s*)+/i, '').replace(/\s*…?\s*\bsee more\b\s*$/i, '').replace(/\s*…\s*more\s*$/i, '').trim();
      // Prefer the section whose heading is exactly "About".
      for (const sec of document.querySelectorAll('section')) {
        const h = sec.querySelector('h2, h3, [role="heading"]');
        if (h && /^about\b/i.test(h.innerText.trim())) return clean(sec.innerText);
      }
      // Fallback: anchor div, then its section.
      const a = document.querySelector('#about');
      if (a && a.closest('section')) return clean(a.closest('section').innerText);
      // Last resort: slice the main text between About and the next section.
      const main = document.querySelector('main')?.innerText || '';
      const m = main.match(/\bAbout\b([\s\S]{0,3000}?)\n(Activity|Featured|Experience|Education|Top skills|Services)\b/i);
      return m ? clean(m[1]) : '';
    }).catch(() => '');

    // Experience: the dedicated details page lists every position in full.
    await gotoWithRetry(page, `${BASE}/in/${pub}/details/experience/`);
    await assertNotChallenged(page);
    await page.waitForTimeout(3_000);
    await expandSeeMore();
    const experience = await page.evaluate(
      () => (document.querySelector('main')?.innerText || '').replace(/^\s*Experience\s*/i, '').trim()
    ).catch(() => '');

    // Supplement sources: extra URLs (e.g. llms.txt) from
    // PROFILE_SUPPLEMENT_URLS that enrich the persona + audience beyond
    // the LinkedIn profile. Each is an index; we crawl ONE level deep
    // into its same-origin links (llms.txt is a list of content pages),
    // bounded by per-page and total caps so it can't run away.
    const supplements = [];
    const urls = (process.env.PROFILE_SUPPLEMENT_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
    const UA = { 'user-agent': 'Mozilla/5.0 (compatible; linkedin-engager/1.0)' };
    const PER_PAGE = 5_000, MAX_LINKS = 12, PER_SOURCE_BUDGET = 40_000;
    const getText = async (u, cap) => {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(12_000) });
      return { ok: r.ok, status: r.status, text: r.ok ? (await r.text()).slice(0, cap) : '' };
    };
    for (const url of urls) {
      let crawlBudget = PER_SOURCE_BUDGET; // per-source, so one site can't starve another
      try {
        const idx = await getText(url, 20_000);
        const sup = { url, ok: idx.ok, status: idx.status, content: idx.text, crawled: [] };
        if (idx.ok && idx.text) {
          const origin = new URL(url).origin;
          const set = new Set();
          const addLink = (raw, base) => { try { const u = new URL(raw, base); u.hash = ''; set.add(u.href); } catch { /* */ } };
          for (const m of idx.text.matchAll(/\]\(([^)\s]+)\)/g)) addLink(m[1].trim(), url);
          for (const m of idx.text.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) addLink(m[0], url);
          const links = [...set].filter((l) => {
            try { return new URL(l).origin === origin && l.replace(/\/$/, '') !== url.replace(/\/$/, '') && !/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|mp4)$/i.test(l); }
            catch { return false; }
          }).slice(0, MAX_LINKS);
          for (const link of links) {
            if (crawlBudget <= 0) break;
            try {
              // Render in the browser (executes JS) so dynamic/SPA sites
              // give real text, not an empty shell. A raw fetch would
              // only return boilerplate for Next.js-style pages.
              await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
              await page.waitForTimeout(1_800);
              const txt = ((await page.evaluate(() => document.querySelector('main')?.innerText || document.body?.innerText || '').catch(() => '')) || '')
                .replace(/\s+/g, ' ').trim().slice(0, Math.min(PER_PAGE, crawlBudget));
              if (txt.length > 200) { sup.crawled.push({ url: link, content: txt }); crawlBudget -= txt.length; }
            } catch { /* skip a bad link */ }
          }
        }
        supplements.push(sup);
      } catch (e) {
        supplements.push({ url, ok: false, error: String(e && e.message || e).slice(0, 140), content: '', crawled: [] });
      }
    }

    emit({
      ok: true,
      name: `${firstName} ${lastName}`.trim(),
      headline: occupation,
      public_id: pub,
      profile_url: `${BASE}/in/${pub}/`,
      about,
      experience,
      supplements,
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('my_profile_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: harvest-people ───────────────────────────────
// For the "who should I contact today" flow. Given a post URL, returns
// the people engaging on it (the author + everyone who commented) with
// their profile handle, headline, network distance, and what they said
// (a relevance signal). The agent ranks these against the target
// audience and dedupes against a contacted-log; it does NOT contact
// anyone. Reading data only; no connection requests, no messages.
async function cmdHarvestPeople(postUrl) {
  if (!postUrl) die('missing_arg', 'harvest-people requires a post URL');
  const activityUrn = (String(postUrl).match(/urn:li:activity:\d+/) || [])[0] || null;
  if (!activityUrn) die('harvest_people_failed', `could not extract an activity URN from ${postUrl}`);

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);

    const people = [];
    // Author (from post detail).
    const detailResp = await voyagerGet(page, `/voyager/api/feed/updatesV2?q=backendUrnOrNss&urnOrNss=${encodeURIComponent(activityUrn)}`);
    if (detailResp.status === 200) {
      try { const a = harvestAuthor(JSON.parse(detailResp.text)); if (a) people.push(a); } catch { /* */ }
    }
    // Commenters (from comments).
    const commentsResp = await voyagerGet(page, `/voyager/api/feed/comments?count=100&q=comments&sortOrder=RELEVANCE&start=0&updateId=${encodeURIComponent(activityUrn)}`);
    if (commentsResp.status === 200) {
      try { people.push(...harvestCommenters(JSON.parse(commentsResp.text))); } catch { /* */ }
    }
    // Drop self (the operator) and dedupe author-vs-commenter overlap.
    const seen = new Set();
    const deduped = people.filter((p) => {
      const k = p.public_id || p.member_urn || p.name;
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Enrich network distance for anyone missing it (authors don't carry
    // it in the post data the way commenters do), so warmth ranking
    // applies to everyone. One lookup per such person; cap to be polite.
    let lookups = 0;
    for (const p of deduped) {
      if (!p.network_distance && p.public_id && lookups < 12) {
        p.network_distance = await lookupDistance(page, p.public_id);
        lookups++;
      }
    }
    emit({ ok: true, post_url: `${BASE}/feed/update/${activityUrn}/`, activity_urn: activityUrn, people: deduped });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('harvest_people_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: enrich-person ────────────────────────────────
// Given a person's publicId (from harvest-people), returns their full
// About, latest Experience, and their current company's profile
// (industry, size, followers, HQ, specialties) for ICP qualification.
// For 1st/2nd-degree people the whole profile is visible; out-of-network
// people may be partial/hidden (fields come back null). Read-only.
async function cmdEnrichPerson(publicId) {
  if (!publicId) die('missing_arg', 'enrich-person requires a publicId');
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);

    // Profile: name + About.
    await gotoWithRetry(page, `${BASE}/in/${publicId}/`);
    await assertNotChallenged(page);
    await page.waitForTimeout(2800);
    const profileTop = await page.evaluate(() => {
      const h1 = (document.querySelector('h1')?.innerText || '').trim();
      let name = h1 || null;
      if (!name) {
        const m = (document.title || '').replace(/^\(\d+\)\s*/, '').match(/^([^|]+?)\s*\|/);
        name = m ? m[1].trim() : null;
      }
      // The profile photo is the first profile-displayphoto img on the
      // page (og:image isn't set on the logged-in view). The first one
      // is the profile owner; later ones are "people also viewed". This is
      // lazy-loaded and often empty in headless, so it is only a cheap
      // first try; lookupPhoto (the API) is the reliable source below.
      const pimg = document.querySelector('img[src*="profile-displayphoto"]');
      return { name, photo_url: pimg ? pimg.src : null };
    }).catch(() => ({ name: null, photo_url: null }));
    const name = profileTop.name;
    const photo_url = profileTop.photo_url || (await lookupPhoto(page, publicId));
    const about = await page.evaluate(() => {
      for (const sec of document.querySelectorAll('section')) {
        const h = sec.querySelector('h2,[role="heading"]');
        if (h && /^about\b/i.test(h.innerText.trim())) return sec.innerText.replace(/^(About\s*)+/i, '').replace(/\s*…?\s*see more\s*$/i, '').trim();
      }
      return null;
    }).catch(() => null);

    // Experience: full text + latest company id.
    await gotoWithRetry(page, `${BASE}/in/${publicId}/details/experience/`);
    await assertNotChallenged(page);
    await page.waitForTimeout(2800);
    const exp = await page.evaluate(() => {
      const text = (document.querySelector('main')?.innerText || '').replace(/^\s*Experience\s*/i, '').trim();
      // Page is latest-first; the first two text lines are the current
      // role's title and company (reliable, vs the SDUI DOM which mixes
      // in footer listitems).
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const latestRole = lines.length
        ? { title: lines[0] || null, company: (lines[1] || '').split(' · ')[0].trim() || null }
        : null;
      // First company that has a LinkedIn page, for the ICP profile. May
      // be the current employer or a recent one (small current employers
      // often have no page); labeled accordingly downstream.
      let companyId = null;
      for (const a of document.querySelectorAll('a[href*="/company/"]')) {
        const m = a.getAttribute('href').match(/\/company\/([^/?]+)/);
        if (m) { companyId = m[1]; break; }
      }
      return { text: text.slice(0, 700), latestRole, companyId };
    }).catch(() => ({ text: '', latestRole: null, companyId: null }));

    // Company drilldown (current/latest employer).
    let company = null;
    if (exp.companyId) {
      await gotoWithRetry(page, `${BASE}/company/${exp.companyId}/about/`).catch(() => {});
      await page.waitForTimeout(2500);
      company = await page.evaluate((id) => {
        const t = document.querySelector('main')?.innerText || '';
        const after = (label) => {
          const m = t.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n([^\\n]+)', 'i'));
          return m ? m[1].trim() : null;
        };
        return {
          id,
          name: (document.querySelector('h1')?.innerText || '').trim() || null,
          industry: after('Industry'),
          size: after('Company size'),
          headquarters: after('Headquarters'),
          founded: after('Founded'),
          specialties: after('Specialties'),
          followers: (t.match(/([\d,]+)\s+followers/i) || [])[1] || null,
          url: `https://www.linkedin.com/company/${id}/`,
        };
      }, exp.companyId).catch(() => null);
    }

    emit({ ok: true, public_id: publicId, profile_url: `${BASE}/in/${publicId}/`, name, photo_url, about, latest_role: exp.latestRole, latest_experience: exp.text, company });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('enrich_person_failed', e.message);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: photos ───────────────────────────────────────
// Batch profile-photo lookup. Given one or more publicIds (passed
// positionally and/or comma-separated), opens a SINGLE session and
// returns { public_id: photo_url|null } for each via the dash-profile
// API. Much lighter than enrich-person (one nav + one API call each),
// for backfilling or refreshing photo_url across a contacts file
// without re-running the full enrichment. Read-only.
async function cmdPhotos(publicIds) {
  const ids = (publicIds || [])
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) die('missing_arg', 'photos requires one or more publicIds');
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, BASE + '/feed/');
    await assertNotChallenged(page);
    const photos = {};
    for (const id of ids) {
      photos[id] = await lookupPhoto(page, id);
      await page.waitForTimeout(700); // ease off the per-call throttle
    }
    emit({ ok: true, photos });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    die('photos_failed', e.message);
  } finally {
    await browser.close();
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'login':          await cmdLogin(); break;
    case 'auth-check':     await cmdAuthCheck(); break;
    case 'scroll-feed':    await cmdScrollFeed(args); break;
    case 'read-post':      await cmdReadPost(args._[0]); break;
    case 'comment-post':   await cmdCommentPost(args._[0], args); break;
    case 'reply-comment':  await cmdReplyComment(args._[0], args); break;
    case 'my-profile':     await cmdMyProfile(); break;
    case 'harvest-people': await cmdHarvestPeople(args._[0]); break;
    case 'enrich-person':  await cmdEnrichPerson(args._[0]); break;
    case 'photos':         await cmdPhotos(args._); break;
    default:
      emit({
        ok: false,
        error: 'unknown_command',
        usage: [
          'linkedin.js login   (one-time human login via VNC into the persistent profile)',
          'linkedin.js auth-check',
          'linkedin.js my-profile   (own name, headline, About, Experience -- for target-audience derivation)',
          'linkedin.js scroll-feed --count 15 --feed home|hashtag:<name>',
          'linkedin.js read-post <post-url>',
          'linkedin.js comment-post <post-url> --text "..."',
          'linkedin.js reply-comment <comment-permalink> --text "..."',
          'linkedin.js harvest-people <post-url>   (people engaging on a post -- for the contact shortlist)',
          'linkedin.js enrich-person <publicId>    (About + latest role + company profile -- ICP qualification)',
          'linkedin.js photos <publicId>[,<publicId>...]   (batch profile-photo URLs -- backfill/refresh photo_url)',
        ],
      });
      process.exit(1);
  }
}

main().catch((e) => die('uncaught', e.stack || e.message || String(e)));
