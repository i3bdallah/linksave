# linksave

Export your LinkedIn saved posts to Markdown, JSON, and a searchable HTML viewer.

LinkedIn doesn't offer a way to export your bookmarked posts. **linksave** launches a headless browser, scrolls through your saved posts, and exports everything locally — with incremental deduplication so re-runs only save new posts.

## Quick start

```bash
git clone https://github.com/yourusername/linksave.git
cd linksave
npm install
npx playwright install chromium
```

Copy the example config and add your cookie:

```bash
cp config.example.json config.json
```

Edit `config.json` and paste your `li_at` cookie (see [Getting your cookie](#getting-your-li_at-cookie) below).

Run it:

```bash
node src/index.js
```

That's it. Your saved posts are now in `./bookmarks/`.

## Getting your `li_at` cookie

1. Open [linkedin.com](https://www.linkedin.com) in your browser and log in
2. Open DevTools (`F12`) → **Application** → **Cookies** → `https://www.linkedin.com`
3. Find the cookie named **`li_at`** and copy its value
4. Paste it into `config.json`

> The `li_at` cookie expires periodically. If linksave reports an auth error, grab a fresh one.

## Configuration

All options go in `config.json` (see `config.example.json`):

| Field             | Description                              | Default        |
| ----------------- | ---------------------------------------- | -------------- |
| `li_at`           | Your LinkedIn session cookie (**required**) | —           |
| `output_dir`      | Where exported files are written         | `./bookmarks`  |
| `scroll_delay_ms` | Pause between scrolls in ms              | `1500`         |
| `max_scrolls`     | Max scroll attempts to load more posts   | `50`           |

## Output

Three files are generated in the output directory:

| File              | Format   | Description                                      |
| ----------------- | -------- | ------------------------------------------------ |
| `saved-posts.md`  | Markdown | All saved posts with author, text, and links     |
| `bookmarks.json`  | JSON     | Structured data for every post                   |
| `index.html`      | HTML     | Searchable, paginated viewer — open in a browser |

## How it works

1. Authenticates to LinkedIn using your `li_at` session cookie
2. Navigates to your saved posts page and scrolls to load them all
3. Extracts post data (author, headline, text, links, timestamps) from the DOM
4. Deduplicates against previously saved posts (tracked in `.state.json`)
5. Merges new posts into the three output formats

Re-runs are incremental — only new posts are added.

## Global install

If you want to use `linksave` as a command anywhere:

```bash
npm link
linksave
```

## Security

- **Never commit `config.json`** — it contains your session cookie. It is already in `.gitignore`.
- The cookie is only sent to `linkedin.com` via a headless Chromium browser. It is never transmitted anywhere else.

## License

MIT
