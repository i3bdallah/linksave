#!/usr/bin/env node

import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SAVED_POSTS_URL = 'https://www.linkedin.com/my-items/saved-posts/';

// Write data atomically: write to a temp file in the same directory, then rename.
// Keeps a .bak of the previous version if one exists.
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(tmp, data);
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak');
  }
  fs.renameSync(tmp, filePath);
}

// ── ANSI helpers ────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  reset:   isTTY ? '\x1b[0m'  : '',
  bold:    isTTY ? '\x1b[1m'  : '',
  dim:     isTTY ? '\x1b[2m'  : '',
  green:   isTTY ? '\x1b[32m' : '',
  yellow:  isTTY ? '\x1b[33m' : '',
  cyan:    isTTY ? '\x1b[36m' : '',
  red:     isTTY ? '\x1b[31m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
};

const log = {
  step:  (msg) => console.log(`${c.cyan}▸${c.reset} ${msg}`),
  ok:    (msg) => console.log(`${c.green}✔${c.reset} ${msg}`),
  warn:  (msg) => console.log(`${c.yellow}!${c.reset} ${msg}`),
  info:  (msg) => console.log(`${c.dim}  ${msg}${c.reset}`),
  error: (msg) => console.error(`${c.red}✖${c.reset} ${msg}`),
};

const startTime = performance.now();
const elapsed = () => `${c.dim}(${((performance.now() - startTime) / 1000).toFixed(1)}s)${c.reset}`;

// ── Banner ──────────────────────────────────────────────────────────
console.log('');
console.log(`  ${c.bold}linksave${c.reset}  ${c.dim}— Export your LinkedIn saved posts${c.reset}`);
console.log(`  ${c.dim}${'─'.repeat(43)}${c.reset}`);
console.log('');

// ── Load config ─────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));
} catch {
  log.error('Could not read config.json. Create one with your li_at cookie.');
  process.exit(1);
}

if (!config.li_at || config.li_at === 'PASTE_YOUR_COOKIE_HERE') {
  log.error('Please paste your li_at cookie into config.json');
  log.info('→ Open LinkedIn in your browser');
  log.info('→ DevTools → Application → Cookies → linkedin.com');
  log.info('→ Copy the value of the "li_at" cookie');
  process.exit(1);
}

const outputDir = config.output_dir || './bookmarks';
const scrollDelay = config.scroll_delay_ms || 1500;
const maxScrolls = config.max_scrolls || 50;

// ── Load dedup state ────────────────────────────────────────────────
let seen = [];
try {
  seen = JSON.parse(fs.readFileSync('.state.json', 'utf-8'));
} catch { /* first run */ }
const seenSet = new Set(seen);

// ── Launch browser ──────────────────────────────────────────────────
log.step('Launching browser...');
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await context.addCookies([{
    name: 'li_at',
    value: config.li_at,
    domain: '.linkedin.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  }]);

  const page = await context.newPage();
  log.step('Navigating to saved posts...');
  await page.goto(SAVED_POSTS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // ── Auth check ──────────────────────────────────────────────────
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
    log.error('LinkedIn redirected to login — your li_at cookie has expired.');
    log.info('→ Open LinkedIn in your browser and log in');
    log.info('→ DevTools → Application → Cookies → linkedin.com');
    log.info('→ Copy the fresh "li_at" value into config.json');
    process.exit(1);
  }
  log.ok('Authenticated');

  // ── Scroll to load posts ──────────────────────────────────────
  let prevHeight = 0;
  let scrollCount = 0;

  for (let i = 0; i < maxScrolls; i++) {
    scrollCount = i + 1;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(scrollDelay);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    const loadedCount = await page.$$eval('[data-chameleon-result-urn]', els => els.length);
    if (isTTY) {
      process.stdout.write(`\r${c.cyan}▸${c.reset} Scrolling ${c.dim}(${scrollCount}/${maxScrolls})${c.reset} — ${c.bold}${loadedCount}${c.reset} posts loaded`);
    }

    if (newHeight === prevHeight) {
      if (isTTY) process.stdout.write('\n');
      log.ok(`Reached end after ${scrollCount} scrolls — ${c.bold}${loadedCount}${c.reset} posts loaded`);
      break;
    }
    prevHeight = newHeight;
  }
  if (scrollCount === maxScrolls) {
    if (isTTY) process.stdout.write('\n');
    log.warn(`Hit max scroll limit (${maxScrolls})`);
  }

  // ── Extract posts from DOM ────────────────────────────────────
  // LinkedIn saved posts page uses [data-chameleon-result-urn] as card containers
  const posts = await page.$$eval('[data-chameleon-result-urn]', (cards) =>
    cards.map((card) => {
      // Author name — from profile image alt text or actor name link
      const profileImg = card.querySelector('.presence-entity__image, img[alt]');
      let author = profileImg?.alt || '';
      if (!author) {
        const nameSpan = card.querySelector('.entity-result__content-actor span[dir="ltr"] span[aria-hidden="true"]');
        author = nameSpan?.textContent?.replace(/<!---->/g, '').trim() || '';
      }

      // Headline — the description text below the author name
      const headlineEl = card.querySelector('.entity-result__content-actor .linked-area div[class*="t-14"]');
      const headline = headlineEl?.textContent?.replace(/<!---->/g, '').trim() || '';

      // Timestamp — "2w", "3d", etc.
      const timeEl = card.querySelector('.entity-result__content-actor p.t-12');
      let timestamp = '';
      if (timeEl) {
        const hiddenSpan = timeEl.querySelector('span[aria-hidden="true"]');
        timestamp = (hiddenSpan || timeEl).textContent.replace(/[•\s]+$/, '').trim();
      }

      // Post text — the summary paragraph
      const textEl = card.querySelector('.entity-result__content-summary, p[class*="entity-result__content-summary"]');
      let postText = '';
      if (textEl) {
        // Get innerHTML, replace <br> with newlines, strip tags
        postText = textEl.innerHTML
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<!--.*?-->/g, '')
          .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/[ \t]+$/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      // Post URL — from any link pointing to /feed/update/
      const postLink = card.querySelector('a[href*="/feed/update/"]');
      let url = postLink?.href || '';
      if (!url) {
        const urn = card.getAttribute('data-chameleon-result-urn');
        if (urn) url = `https://www.linkedin.com/feed/update/${urn}`;
      }

      // Clean up URL — remove the updateEntityUrn query param for cleanliness
      if (url.includes('?')) url = url.split('?')[0];

      // External links — embedded article links, etc.
      const embeddedTitle = card.querySelector('.entity-result__embedded-object-sub-title');
      const links = [];
      if (embeddedTitle) links.push(embeddedTitle.textContent.trim());

      // Any non-linkedin links
      card.querySelectorAll('a[href]').forEach(a => {
        const h = a.href;
        if (h && !h.includes('linkedin.com') && h.startsWith('http')) links.push(h);
      });

      return { author, headline, postText, url, timestamp, links: [...new Set(links)] };
    }).filter(p => p.author || p.postText || p.url)
  );

  log.ok(`Extracted ${c.bold}${posts.length}${c.reset} posts`);

  if (posts.length === 0) {
    log.warn('No posts extracted — dumping page HTML to debug-page.html');
    fs.writeFileSync('debug-page.html', await page.content());
    process.exit(1);
  }

  // ── Dedup ─────────────────────────────────────────────────────
  const key = (p) => p.url || `${p.author}::${p.postText.slice(0, 80)}`;
  const newPosts = posts.filter((p) => !seenSet.has(key(p)));
  const dupeCount = posts.length - newPosts.length;

  if (dupeCount > 0) log.info(`${dupeCount} already-saved posts skipped`);

  if (newPosts.length === 0) {
    log.ok('No new posts — all caught up!');
    process.exit(0);
  }

  // ── Write outputs ──────────────────────────────────────────────
  fs.mkdirSync(outputDir, { recursive: true });
  const today = new Date().toISOString().split('T')[0];

  // Tag new posts with saved date and update dedup state
  for (const p of newPosts) {
    p.saved = today;
    seenSet.add(key(p));
  }

  log.step('Writing output files...');

  // ── JSON: merge with existing ─────────────────────────────────
  const jsonFile = path.join(outputDir, 'bookmarks.json');
  let allPosts = [];
  if (fs.existsSync(jsonFile)) {
    const raw = fs.readFileSync(jsonFile, 'utf-8');
    try {
      allPosts = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse ${jsonFile}: ${err.message}. Fix or remove the file before re-running.`);
    }
  }
  allPosts = [...newPosts, ...allPosts];
  atomicWrite(jsonFile, JSON.stringify(allPosts, null, 2));

  // ── Markdown ──────────────────────────────────────────────────
  const mdFile = path.join(outputDir, 'saved-posts.md');
  const mdSections = allPosts.map((p) => {
    const lines = [
      '---', '',
      p.author ? `**${p.author}**` : '',
      p.headline ? `*${p.headline}*` : '',
      p.timestamp ? `📅 ${p.timestamp} — saved ${p.saved}` : `📅 saved ${p.saved}`,
      '', p.postText || '*(no text extracted)*', '',
      p.url ? `🔗 [Original post](${p.url})` : '',
    ];
    if (p.links.length > 0) lines.push('', '**Links:**', ...p.links.map((l) => `- ${l}`));
    return lines.filter(l => l !== undefined).join('\n');
  });
  fs.writeFileSync(mdFile, `# LinkedIn Saved Posts\n\nExported with linksave on ${today}\n\n${mdSections.join('\n\n')}\n`);

  // ── HTML viewer ───────────────────────────────────────────────
  const htmlFile = path.join(outputDir, 'index.html');
  const htmlTemplate = fs.readFileSync(new URL('./template.html', import.meta.url), 'utf-8');
  // Escape sequences that would break or escape a <script> context
  const safeJson = JSON.stringify(allPosts)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const html = htmlTemplate.replace('"__BOOKMARKS_DATA__"', safeJson);
  fs.writeFileSync(htmlFile, html);

  // ── Update state ──────────────────────────────────────────────
  atomicWrite('.state.json', JSON.stringify([...seenSet], null, 2));

  log.info(mdFile);
  log.info(jsonFile);
  log.info(htmlFile);

  console.log('');
  log.ok(`${c.bold}${newPosts.length} new posts${c.reset} saved ${c.dim}(${allPosts.length} total)${c.reset} ${elapsed()}`);
  if (dupeCount > 0) log.info(`${dupeCount} duplicates skipped`);
  console.log('');
  log.info(`Open ${c.cyan}${htmlFile}${c.reset} in your browser to browse them`);

} catch (err) {
  log.error(err.message);
  process.exit(1);
} finally {
  await browser.close();
}
