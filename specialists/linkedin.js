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
const path = require('path');

// ─── Config ────────────────────────────────────────────────────

const COOKIES_PATH = process.env.LINKEDIN_COOKIES_PATH
  || '/secrets/linkedin.cookies.json';

const BASE = 'https://www.linkedin.com';

const SELECTORS = {
  // Logged-in indicator. The global nav contains a "Me" button
  // when authenticated. Several stable signals; we try them in
  // order so one DOM refactor does not break all.
  loggedInProfileButton: 'button[data-control-name="nav.settings"], button:has(img[alt^="Photo of "]), [aria-label="Me"]',

  // Feed posts. data-id is the activity URN, stable for years.
  feedPostThing:         'div[data-id^="urn:li:activity:"]',

  // Post author + headline. Live inside the post header. Use
  // role-based fallbacks; LinkedIn frequently re-hashes class
  // names on these.
  postHeaderAuthorLink:  'a[href*="/in/"][aria-label*="View"], a.update-components-actor__meta-link',
  postHeaderAuthor:      'span.update-components-actor__title span[aria-hidden="true"], .update-components-actor__title',
  postHeaderHeadline:    '.update-components-actor__description',

  // Post body text. The "see more" expander hides part of long
  // posts. The wrapper clicks it before extraction.
  postBodyContainer:     '.feed-shared-update-v2__description, .update-components-text',
  postSeeMoreButton:     'button.feed-shared-inline-show-more-text__see-more-less-toggle, button:has-text("…more")',

  // Counts. LinkedIn renders these as text inside spans with
  // accessibility labels. Pattern-match on aria-label so we
  // catch label rephrases.
  reactionCountSpan:     '.social-details-social-counts__reactions-count, [aria-label*="reactions"], [aria-label*="reaction"]',
  commentCountButton:    '[aria-label$=" comments"], [aria-label$=" comment"], .social-details-social-counts__comments',

  // Promoted/sponsored content marker. We never engage with it.
  promotedMarker:        ':text("Promoted"), :text("Sponsored")',

  // Repost marker. Renders as "X reposted this" header above the
  // original post.
  repostMarker:          '.update-components-header, :text("reposted this")',

  // Comment thread. LinkedIn lazy-loads comments; click "Load
  // more comments" repeatedly.
  loadMoreCommentsButton: 'button.comments-comments-list__load-more-comments-button, button:has-text("Load more comments")',
  commentArticle:        'article.comments-comment-item, .comments-comment-entity',
  commentAuthorLink:     'a.comments-post-meta__actor-link, .comments-comment-meta__actor a[href*="/in/"]',
  commentAuthorName:     '.comments-post-meta__name-text, .comments-comment-meta__actor span[dir="ltr"]',
  commentAuthorHeadline: '.comments-post-meta__headline, .comments-comment-meta__description',
  commentBody:           '.comments-comment-item-content-body, .update-components-text',
  commentReactionCount:  '[aria-label*="reaction"] .social-counts-reactions__social-counts-numRections, .comments-comment-social-bar__reactions-count',
  commentMenuButton:     'button[aria-label*="Open menu" i], button.comments-comment-social-bar__copy-link-button',

  // Composer. Clicking the "Comment" button reveals a Quill
  // contenteditable; typing and submit go through that.
  commentTriggerOnPost:  'button[aria-label$="Comment"][type="button"], button.feed-shared-social-action-bar__action-button:has-text("Comment")',
  commentReplyTrigger:   'button.comments-comment-social-bar__reply-action-button, button:has-text("Reply")',
  commentEditor:         'div[role="textbox"][contenteditable="true"], div.ql-editor[contenteditable="true"]',
  commentSubmitButton:   'button.comments-comment-box__submit-button:not([disabled]), button:has-text("Post"):not([disabled])',

  // Anti-bot signals.
  captchaIframe:         'iframe[src*="recaptcha"], iframe[src*="captcha"], iframe[title*="captcha" i]',
  authChallengePage:     ':text("Let us verify it\'s really you")',
  rateLimitNotice:       ':text("Try again later"), :text("You\'ve reached the weekly invitation limit"), :text("temporarily restricted")',
  loginRedirectMarker:   'form[action*="checkpoint"], a[href*="/login"]',
};

// ─── Helpers ──────────────────────────────────────────────────

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function die(error, details) {
  emit({ ok: false, error, ...(details ? { details } : {}) });
  process.exit(1);
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    die('cookies missing', `expected file at ${COOKIES_PATH}`);
  }
  const raw = fs.readFileSync(COOKIES_PATH, 'utf-8');
  let cookies;
  try { cookies = JSON.parse(raw); }
  catch (e) { die('cookies malformed', `not valid JSON: ${e.message}`); }
  if (!Array.isArray(cookies)) die('cookies malformed', 'top level must be an array');

  return cookies.map((c) => {
    const out = { ...c };
    if (typeof out.expires === 'string') out.expires = Number(out.expires);
    if (out.expirationDate && !out.expires) out.expires = Math.floor(out.expirationDate);
    if (out.session === true) delete out.expires;
    if (!out.domain) out.domain = '.linkedin.com';
    if (!out.path) out.path = '/';
    // sameSite normalization across exporter formats (same as
    // the reddit.js wrapper; lifted here for self-containment).
    const ss = (() => {
      if (out.sameSite == null) return null;
      const v = String(out.sameSite).toLowerCase();
      switch (v) {
        case 'strict':         return 'Strict';
        case 'lax':            return 'Lax';
        case 'none':           return 'None';
        case 'no_restriction': return 'None';
        default:               return null;
      }
    })();
    if (ss) out.sameSite = ss;
    else delete out.sameSite;
    // Strip extension-specific bookkeeping fields Playwright
    // rejects.
    delete out.hostOnly;
    delete out.storeId;
    delete out.id;
    delete out.expirationDate;
    return out;
  });
}

async function newContext() {
  // headless: false plus Xvfb (see CLAUDE.md) removes the
  // headless-chromium fingerprint signal. The stealth plugin
  // imported at the top of this file patches the remaining
  // common tells (navigator.webdriver, chrome.runtime, plugins,
  // WebGL, canvas, languages). Requires DISPLAY env to be set,
  // which xvfb-run does automatically.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    viewport:   { width: 1366, height: 900 },
    userAgent:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/New_York',
  });
  await ctx.addCookies(loadCookies());
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
    await page.screenshot({ path: absolutePath, fullPage: true });
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
          warning: 'profile-photo selectors all stale; LinkedIn DOM may have shifted. Engager will keep working but display name will read this placeholder. Update SELECTORS.loggedInProfileButton in linkedin.js when convenient.',
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
  let url = BASE + '/feed/';
  if (feedArg.startsWith('hashtag:')) {
    url = `${BASE}/feed/hashtag/${encodeURIComponent(feedArg.slice(8))}/`;
  } else if (feedArg !== 'home') {
    die('bad_feed', `unknown feed "${feedArg}". Use home or hashtag:<name>`);
  }

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, url);
    await assertNotChallenged(page);

    // Scroll up to 5 passes, ~1s between, until we have `count`
    // post-things visible OR we run out of scroll passes.
    let posts = [];
    for (let pass = 0; pass < 5; pass++) {
      posts = await page.locator(SELECTORS.feedPostThing).all();
      if (posts.length >= count) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1_000);
    }

    const out = [];
    for (const post of posts.slice(0, count)) {
      try {
        const urn = await post.getAttribute('data-id');
        const isPromoted = (await post.locator(SELECTORS.promotedMarker).count()) > 0;
        const isRepost = (await post.locator(SELECTORS.repostMarker).count()) > 0;
        const author = (await post.locator(SELECTORS.postHeaderAuthor).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');
        const headline = (await post.locator(SELECTORS.postHeaderHeadline).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');
        // Body. Don't bother clicking "see more" for the feed
        // listing; the excerpt is what the agent uses to decide
        // interest. read-post does the full extraction.
        const bodyText = (await post.locator(SELECTORS.postBodyContainer).first().textContent().catch(() => ''))?.trim()?.replace(/\s+/g, ' ');
        const bodyExcerpt = bodyText?.slice(0, 500) ?? '';
        // Reactions / comments. LinkedIn's text is "142 reactions"
        // or "Like, Celebrate, and 142 others". Extract the first
        // integer if present.
        const reactionText = (await post.locator(SELECTORS.reactionCountSpan).first().textContent().catch(() => null))?.trim();
        const commentText = (await post.locator(SELECTORS.commentCountButton).first().getAttribute('aria-label').catch(() => null));
        const reactionCount = reactionText ? (parseInt(reactionText.replace(/[^0-9]/g, ''), 10) || null) : null;
        const commentCount = commentText ? (parseInt(commentText.replace(/[^0-9]/g, ''), 10) || null) : null;
        // Age. LinkedIn renders "3h", "1d", "2w" as visible text.
        // Look in the post header.
        const ageRaw = await post.locator('time, .feed-shared-actor__sub-description, .update-components-actor__sub-description').first().textContent().catch(() => null);
        const ageHours = parseRelativeAge((ageRaw || '').trim());
        const postUrl = urn ? `${BASE}/feed/update/${encodeURIComponent(urn)}/` : null;
        if (!urn) continue;
        out.push({
          urn,
          author: author || null,
          author_headline: headline || null,
          body_excerpt: bodyExcerpt,
          post_url: postUrl,
          reaction_count: reactionCount,
          comment_count: commentCount,
          age_hours: ageHours,
          is_promoted: isPromoted,
          is_repost: isRepost,
        });
      } catch (e) {
        continue;
      }
    }
    emit({ ok: true, feed: feedArg, posts: out });
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

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, postUrl);
    await assertNotChallenged(page);

    // The single-post view renders the same post-thing as the
    // feed; find the first.
    const postThing = page.locator(SELECTORS.feedPostThing).first();
    await postThing.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

    const urn = await postThing.getAttribute('data-id');
    const author = (await postThing.locator(SELECTORS.postHeaderAuthor).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');
    const headline = (await postThing.locator(SELECTORS.postHeaderHeadline).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');

    // Click "see more" if present, then read the full body.
    const seeMore = postThing.locator(SELECTORS.postSeeMoreButton).first();
    if (await seeMore.count() > 0) {
      await seeMore.click().catch(() => {});
      await page.waitForTimeout(500);
    }
    const body = (await postThing.locator(SELECTORS.postBodyContainer).first().textContent().catch(() => ''))?.trim();

    const reactionText = (await postThing.locator(SELECTORS.reactionCountSpan).first().textContent().catch(() => null))?.trim();
    const commentText = (await postThing.locator(SELECTORS.commentCountButton).first().getAttribute('aria-label').catch(() => null));
    const reactionCount = reactionText ? (parseInt(reactionText.replace(/[^0-9]/g, ''), 10) || null) : null;
    const commentCount = commentText ? (parseInt(commentText.replace(/[^0-9]/g, ''), 10) || null) : null;

    // Expand comments. Click "Load more comments" up to 3 times.
    for (let i = 0; i < 3; i++) {
      const more = page.locator(SELECTORS.loadMoreCommentsButton).first();
      if (await more.count() === 0) break;
      await more.click().catch(() => {});
      await page.waitForTimeout(1_200);
    }

    const commentThings = await page.locator(SELECTORS.commentArticle).all();
    const comments = [];
    for (const c of commentThings.slice(0, 60)) {
      try {
        const cAuthor = (await c.locator(SELECTORS.commentAuthorName).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');
        const cHeadline = (await c.locator(SELECTORS.commentAuthorHeadline).first().textContent().catch(() => null))?.trim()?.replace(/\s+/g, ' ');
        const cBody = (await c.locator(SELECTORS.commentBody).first().textContent().catch(() => ''))?.trim();
        const cReactRaw = (await c.locator(SELECTORS.commentReactionCount).first().textContent().catch(() => null))?.trim();
        const cReact = cReactRaw ? (parseInt(cReactRaw.replace(/[^0-9]/g, ''), 10) || null) : null;
        const cAgeRaw = await c.locator('time').first().textContent().catch(() => null);
        const cAge = parseRelativeAge((cAgeRaw || '').trim());
        // Permalink. LinkedIn comments embed their URN in an
        // element with the comment URN; the cleanest stable
        // identifier is data-id on the article itself.
        const cId = await c.getAttribute('data-id');
        const cPermalink = cId && urn
          ? `${BASE}/feed/update/${encodeURIComponent(urn)}/?commentUrn=${encodeURIComponent(cId)}`
          : null;
        // Depth: nested replies live inside .comments-comment-item
        // ancestors; first-level is depth 0. Best-effort via
        // class-name walk.
        const depth = await c.evaluate((el) => {
          let n = 0;
          let cur = el.parentElement;
          while (cur && n < 5) {
            if (cur.matches?.('article.comments-comment-item, .comments-comment-entity')) n++;
            cur = cur.parentElement;
          }
          return n;
        }).catch(() => 0);
        if (!cAuthor && !cBody) continue;
        comments.push({
          id: cId,
          author: cAuthor || null,
          author_headline: cHeadline || null,
          body: cBody,
          reaction_count: cReact,
          age_hours: cAge,
          permalink: cPermalink,
          depth,
          parent_id: null,
        });
      } catch (e) {
        continue;
      }
    }

    emit({
      ok: true,
      post: {
        urn,
        author: author || null,
        author_headline: headline || null,
        body,
        post_url: postUrl,
        reaction_count: reactionCount,
        comment_count: commentCount,
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

async function typeIntoEditor(page, editor, text) {
  // Click to focus, clear (Ctrl-A + Backspace) just in case
  // LinkedIn pre-populates a draft, then type. LinkedIn's Quill
  // editor sometimes ignores Locator.fill(), so we use
  // keyboard.type for reliability.
  await editor.click();
  await page.keyboard.press('Control+a').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(text, { delay: 8 });
}

async function clickSubmitWhenReady(page, scope) {
  // The Post button is disabled until the editor has non-empty
  // content. Wait until it is enabled, then click.
  const btn = scope.locator(SELECTORS.commentSubmitButton).first();
  await btn.waitFor({ state: 'visible', timeout: 5_000 });
  await btn.click();
  // Wait a beat for LinkedIn to POST and render the new comment.
  await page.waitForTimeout(2_500);
}

// ─── Subcommand: comment-post ─────────────────────────────────

async function cmdCommentPost(postUrl, args) {
  if (!postUrl) die('missing_arg', 'comment-post requires a post URL');
  const text = args.text;
  if (!text || !text.trim()) die('missing_arg', 'comment-post requires --text "..."');

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, postUrl);
    await assertNotChallenged(page);

    const postThing = page.locator(SELECTORS.feedPostThing).first();
    await postThing.waitFor({ state: 'visible', timeout: 15_000 });

    // Click the Comment action to reveal the composer.
    const commentBtn = postThing.locator(SELECTORS.commentTriggerOnPost).first();
    if (await commentBtn.count() === 0) {
      die('comment_form_not_found', 'no Comment action found on this post (locked, banned, or LinkedIn DOM changed)');
    }
    await commentBtn.click();

    const editor = postThing.locator(SELECTORS.commentEditor).first();
    await editor.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      die('comment_form_not_found', 'composer did not appear after clicking Comment');
    });

    await typeIntoEditor(page, editor, text);
    await clickSubmitWhenReady(page, postThing);
    await assertNotChallenged(page);

    // Best-effort URL extraction. LinkedIn does not return a
    // direct permalink in the DOM after post; we leave the URL
    // null and let the audit's target_url carry the trail.
    emit({
      ok: true,
      comment_url: null,
      note: 'posted (assertNotChallenged passed post-submit); LinkedIn does not surface a stable permalink in the DOM after post, audit via target_url',
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

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  try {
    await gotoWithRetry(page, permalink);
    await assertNotChallenged(page);

    // Wait for comments to render, then find the specific
    // comment by URN if the permalink encodes one.
    await page.waitForSelector(SELECTORS.commentArticle, { timeout: 15_000 }).catch(() => {});
    const urnMatch = permalink.match(/commentUrn=([^&]+)/);
    const targetUrn = urnMatch ? decodeURIComponent(urnMatch[1]) : null;
    let targetComment;
    if (targetUrn) {
      targetComment = page.locator(`${SELECTORS.commentArticle}[data-id="${targetUrn}"]`).first();
    } else {
      targetComment = page.locator(SELECTORS.commentArticle).first();
    }
    if (await targetComment.count() === 0) {
      die('comment_not_found', 'no comment matched the permalink target');
    }

    // Click Reply on the target comment.
    const replyBtn = targetComment.locator(SELECTORS.commentReplyTrigger).first();
    if (await replyBtn.count() === 0) {
      die('comment_form_not_found', 'no Reply action on target comment (locked/banned/DOM changed)');
    }
    await replyBtn.click();

    const editor = targetComment.locator(SELECTORS.commentEditor).first();
    await editor.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
      die('comment_form_not_found', 'reply composer did not appear after clicking Reply');
    });

    await typeIntoEditor(page, editor, text);
    await clickSubmitWhenReady(page, targetComment);
    await assertNotChallenged(page);

    emit({
      ok: true,
      comment_url: null,
      note: 'posted (assertNotChallenged passed post-submit); LinkedIn does not surface a stable permalink in the DOM after post, audit via target_url',
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

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'auth-check':     await cmdAuthCheck(); break;
    case 'scroll-feed':    await cmdScrollFeed(args); break;
    case 'read-post':      await cmdReadPost(args._[0]); break;
    case 'comment-post':   await cmdCommentPost(args._[0], args); break;
    case 'reply-comment':  await cmdReplyComment(args._[0], args); break;
    default:
      emit({
        ok: false,
        error: 'unknown_command',
        usage: [
          'linkedin.js auth-check',
          'linkedin.js scroll-feed --count 15 --feed home|hashtag:<name>',
          'linkedin.js read-post <post-url>',
          'linkedin.js comment-post <post-url> --text "..."',
          'linkedin.js reply-comment <comment-permalink> --text "..."',
        ],
      });
      process.exit(1);
  }
}

main().catch((e) => die('uncaught', e.stack || e.message || String(e)));
