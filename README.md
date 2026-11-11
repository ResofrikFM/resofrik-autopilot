# Resofrik FM Autopilot 2 — your 360° social team in an app

Two parts. Both are free to run, and both are owned by the station (Cloudflare account + GitHub repo):

| Part | Where it runs | What it does |
|---|---|---|
| **Autopilot** (`worker.js`) | Cloudflare Workers (free plan), next to the website | Writes the week's posts, publishes text/pictures/carousels/videos to Facebook, Instagram, Threads, Bluesky, Mastodon and Telegram, announces shows, posts Now Playing, runs the community desk, answers simple comments, hosts your link-in-bio page with email sign-ups and event submissions, tracks clicks, sends you a Monday report |
| **Studio** (`studio/` + `.github/workflows/studio.yml`) | GitHub Actions in the website's repo | Scouts Cleveland-area feeds and calendars, makes branded picture cards for every post, weekly carousels, a weekly "Around Cleveland" video, artist promo videos, and vertical captioned **shorts** cut from your shows, podcasts and videos. Updates the website's Community board |

Running costs: $0 for Cloudflare and GitHub on their free plans. The AI key is optional, pay-as-you-go, and costs pennies a week. No subscriptions.

## What runs by itself
- **Every 15 min:** publishes posts that are due, finishes videos the platforms are still processing, sends show reminders (1 hour before and when the show goes on air, with the show's card), posts Now Playing (up to 4 a day, never overnight).
- **Every hour:** reads new comments and replies. Thanks, praise and "how do I listen" get an answer straight away. Everything else waits in the Inbox with a suggested reply, and you get a ping.
- **Every 4 hours (Studio scout):** checks your news sources and calendars. It keeps positive local items (events, resources, arts, youth, good news) and blocks crime and tragedy. It sums each item up in the station's own words with credit and puts the best ones in the 11:15 and 16:15 community slots.
- **Every evening (Studio):** picture cards for upcoming posts, cards for new shows, shorts from new episodes in your podcast/YouTube feeds, artist promo videos, and the website's Community board update.
- **Saturday:** writes the next week (21 posts), then the Studio makes "This week on Resofrik FM", "Around Cleveland this week" (carousel plus a video version) and "The Rare Breed rotation".
- **Monday 9 AM:** report to your phone covering posts, link clicks by platform, sign-ups and comments.

## What platforms allow (and what doesn't auto-post)
- Fully automatic: **Facebook Page, Instagram (pictures, carousels, Reels), Threads, Bluesky, Mastodon, Telegram**.
- **TikTok and YouTube** lock automated uploads to *private* until an app passes their review. Every finished short is listed in the panel under "Videos ready for TikTok and YouTube" with a Download link. Post those by hand or through Content360.
- **LinkedIn** needs partner approval for page posting, so it isn't included.
- Reading other people's Facebook or Instagram pages through the API needs Meta approval. The scout uses public RSS feeds, calendars, and Bluesky and Mastodon accounts instead.

---

## Setup (about 1–2 hours, once)

### 1. Cloudflare (same account as the website)
1. **Storage & Databases → D1 → Create** a database named `resofrik-autopilot`.
2. **R2 → Create bucket** named `resofrik-media`.
3. **Workers & Pages → Create → Worker** named `resofrik-autopilot`. Choose **Edit code**, paste all of `worker.js`, then **Deploy**.
4. Worker **Settings → Bindings**: add the D1 database as `DB` and the R2 bucket as `MEDIA`.
5. **Settings → Trigger events → Cron Triggers**: add `*/15 * * * *` and `0 22 * * 6`.
6. **Settings → Variables and Secrets**, add these:
   - `ADMIN_PASSWORD`: your control-panel password
   - `STUDIO_TOKEN`: any long random text. Use the same text in GitHub (step 2).
   - `PUBLIC_URL`: the Worker's address, e.g. `https://resofrik-autopilot.yourname.workers.dev` (or a custom domain like `https://go.resofrikfm.com`)
   - `ANTHROPIC_API_KEY` (optional, recommended)
   - `NOTIFY_TELEGRAM_CHAT_ID` or `NOTIFY_DISCORD_WEBHOOK`: alerts and the weekly report on your phone
7. Open the Worker's address and sign in. That's your control panel. `/links` is your link-in-bio page; put it in every bio.

### 2. GitHub (the website's repo)
1. Copy the `studio/` folder and `.github/workflows/studio.yml` into the repo.
2. Repo **Settings → Secrets and variables → Actions**: add `AUTOPILOT_URL` (the Worker address), `STUDIO_TOKEN` (same as above) and `ANTHROPIC_API_KEY` (optional).
3. **Actions → Studio → Run workflow** once to check it works.
4. Optional: to make the panel's "Run the Studio now" and "Make shorts" buttons start the Studio straight away, create a fine-grained GitHub token with *Actions: read and write* on the repo. Add it to the Worker as `GH_DISPATCH_TOKEN`, along with `GH_REPO` (e.g. `resofrikfm/website`).

A public repo gets unlimited free Actions minutes. A private repo gets 2,000 a month, which is plenty for about 4 hours of show recordings a month plus the daily jobs.

### 3. Connect the social accounts (Worker secrets)
| Account | Secrets | Notes |
|---|---|---|
| Bluesky (start here) | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | Settings → Privacy and security → App passwords |
| Facebook Page | `FB_PAGE_ID`, `FB_PAGE_TOKEN` | Free Meta developer app → long-lived **Page** token with `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, plus `pages_read_user_content` and `pages_manage_engagement` for comment replies |
| Instagram | `IG_USER_ID` | Professional account linked to the Page. Add `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments` to the token |
| Threads | `THREADS_USER_ID`, `THREADS_TOKEN` | Same Meta app, Threads use case, long-lived token. It renews itself weekly |
| Mastodon | `MASTODON_URL`, `MASTODON_TOKEN` | Preferences → Development → New application (`write:statuses`, `write:media`) |
| Telegram channel | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID` | @BotFather; make the bot a channel admin |

Press **Test** next to each account in the panel's Connections section.

### 4. Tell it about the station (panel → Settings)
- `station.logoUrl`: link to the original "For the rare breed" logo (upload it to the website). Also set `brandColor`, `donateUrl` (your Zeffy link) and `signupUrl`.
- `schedule`: each show's day (`"Wed"`), start (`"19:00"`) and `"active": true`.
- `artists`: name, genre, song, city, plus `image` and `audio` links for promo videos (songs sent with permission only).
- `sources`: local feeds to watch. It starts with Signal Cleveland, the Cuyahoga Land Bank City-of-Cleveland feed and Cleveland Scene. Add library, arts council and neighborhood feeds, `.ics` calendars, and Bluesky/Mastodon accounts. **Source health** in the Community section shows which ones work.
- `studio.videoFeeds`: your podcast RSS or YouTube channel feed. New episodes get clipped automatically.
- `nowPlaying.url`: your AzuraCast now-playing link. Then set `enabled` to `true`.
- `weekly.autoApprove: false` if you'd rather OK every post first. `engage.autoReply: "off"` if you want to answer every comment yourself.

Then press **Write next week now** and **Run the Studio now**.

### 5. Website
The workflow writes the scout's events and announcements into `content/events.json`. Your own entries are kept, and the automatic ones are marked `"auto": true`. The live feed is also available at `/api/public/events`, and recent clips are at `/api/public/media`.

## Day to day
Nothing is required. Open the panel to check the queue, answer held comments, approve community submissions, drop in a recording to get shorts, or press **Pause everything**.
