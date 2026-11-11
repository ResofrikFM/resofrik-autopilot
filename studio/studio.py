#!/usr/bin/env python3
"""
Resofrik FM Studio — the production half of the Autopilot.
Runs on GitHub Actions (free), talks to the Autopilot Worker, and makes:

  scout      Reads Cleveland-area news/event feeds, Bluesky and Mastodon accounts and calendars,
             keeps positive, useful local items, writes short summaries in the station's own words
             (with credit), and sends them to the Autopilot's community desk. Also notices new
             episodes in your podcast/YouTube feeds and queues them for clipping.
  make       Branded picture cards for every queued post, show cards, weekly carousels
             ("This week on Resofrik FM", "Around Cleveland this week", "Rare Breed rotation"),
             a weekly slideshow video, artist promo videos, and vertical captioned shorts cut from
             shows, podcasts and videos.
  all        scout, then make.
  sync-site  Writes the community board into the website's content/events.json.

Needs: Python 3.10+, ffmpeg, Google Chrome (both on GitHub's Ubuntu runners), and for shorts
faster-whisper (pip). Environment: AUTOPILOT_URL, STUDIO_TOKEN, optional ANTHROPIC_API_KEY.
"""
import datetime as dt
import hashlib
import html
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

API = os.environ.get("AUTOPILOT_URL", "").rstrip("/")
TOKEN = os.environ.get("STUDIO_TOKEN", "")
AI_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
WORK = Path(os.environ.get("STUDIO_WORK", tempfile.gettempdir())) / "resofrik-studio"
CHROME = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("google-chrome-stable") or shutil.which("chromium") or shutil.which("chromium-browser")
UA = "Mozilla/5.0 (compatible; ResofrikStudio/2.0; +https://resofrikfm.com)"
MAX_JOBS = int(os.environ.get("STUDIO_MAX_JOBS", "2"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
FONT = os.environ.get("CAPTION_FONT", "DejaVu Sans")
W, H = 1080, 1920  # shorts
CW, CH = 1080, 1350  # cards and carousel slides (4:5)


def say(*a):
    print("[studio]", *a, flush=True)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def http(url, data=None, headers=None, method=None, timeout=60):
    h = {"user-agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("content-type", "")


def api(path, body=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    raw, _ = http(f"{API}/api/studio/{path}", data=data, headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"}, method=method or ("POST" if data else "GET"), timeout=120)
    return json.loads(raw or b"{}")


def upload(path, ctype=None):
    path = Path(path)
    ctype = ctype or {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "mp4": "video/mp4"}.get(path.suffix[1:].lower(), "application/octet-stream")
    q = urllib.parse.urlencode({"name": path.name, "type": ctype})
    raw, _ = http(f"{API}/api/studio/upload?{q}", data=path.read_bytes(), headers={"authorization": f"Bearer {TOKEN}", "content-type": ctype}, method="POST", timeout=600)
    return json.loads(raw)["url"]


def download(url, dest):
    req = urllib.request.Request(url, headers={"user-agent": UA})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    return dest


def claude(system, user, max_tokens=4000, model=None):
    if not AI_KEY:
        return None
    body = {"model": model or SETTINGS.get("ai", {}).get("model") or "claude-sonnet-5-5", "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": user}]}
    try:
        raw, _ = http("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(), headers={"content-type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01"}, method="POST", timeout=300)
        return "".join(c.get("text", "") for c in json.loads(raw).get("content", []))
    except Exception as e:  # never let the AI stop the Studio
        say("AI unavailable:", e)
        return None


def extract_json(text, opener="["):
    if not text:
        return None
    closer = "]" if opener == "[" else "}"
    s, e = text.find(opener), text.rfind(closer)
    if s < 0 or e <= s:
        return None
    try:
        return json.loads(text[s : e + 1])
    except Exception:
        return None


SETTINGS = {}

# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------
TAG_RE = re.compile(r"<[^>]+>")


def strip_html(s):
    s = TAG_RE.sub(" ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def first_words(s, n):
    words = (s or "").split()
    return " ".join(words[:n]) + ("…" if len(words) > n else "")


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:60] or "x"


def esc(s):
    return html.escape(str(s or ""), quote=True)


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%a, %d %b %Y %H:%M:%S %Z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%d"):
        try:
            d = dt.datetime.strptime(s.replace("Z", "+0000") if "T" in s else s, fmt)
            return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
        except Exception:
            pass
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# SCOUT: sources -> community items
# ---------------------------------------------------------------------------
def local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def parse_feed(xml_bytes):
    """RSS 2.0 or Atom -> list of dicts (title, url, summary, published, image, enclosure)."""
    root = ET.fromstring(xml_bytes)
    out = []
    nodes = [n for n in root.iter() if local(n.tag) in ("item", "entry")]
    for n in nodes:
        d = {"title": "", "url": "", "summary": "", "published": None, "image": "", "enclosure": "", "id": ""}
        for c in n:
            t = local(c.tag)
            if t == "title":
                d["title"] = strip_html(c.text or "")
            elif t == "link":
                href = c.attrib.get("href")
                if href and c.attrib.get("rel", "alternate") == "alternate":
                    d["url"] = d["url"] or href
                elif c.text and c.text.strip():
                    d["url"] = d["url"] or c.text.strip()
            elif t in ("description", "summary") and not d["summary"]:
                d["summary"] = strip_html(c.text or "")
            elif t in ("encoded", "content") and not d["summary"]:
                d["summary"] = strip_html(c.text or "")
            elif t in ("pubdate", "published", "updated", "date") and not d["published"]:
                d["published"] = parse_date(c.text or "")
            elif t == "enclosure":
                ty = c.attrib.get("type", "")
                if ty.startswith("image"):
                    d["image"] = c.attrib.get("url", "")
                elif ty.startswith(("audio", "video")):
                    d["enclosure"] = c.attrib.get("url", "")
            elif t in ("thumbnail",) and not d["image"]:
                d["image"] = c.attrib.get("url", "")
            elif t == "content" and c.attrib.get("medium") == "image" and not d["image"]:
                d["image"] = c.attrib.get("url", "")
            elif t == "group":
                for g in c:
                    if local(g.tag) == "thumbnail" and not d["image"]:
                        d["image"] = g.attrib.get("url", "")
                    if local(g.tag) == "description" and not d["summary"]:
                        d["summary"] = strip_html(g.text or "")
            elif t in ("guid", "id", "videoid"):
                d["id"] = d["id"] or (c.text or "").strip()
        if not d["image"]:
            m = re.search(r'<img[^>]+src="(https://[^"]+)"', ET.tostring(n, encoding="unicode"))
            if m:
                d["image"] = html.unescape(m.group(1))
        if d["title"] and d["url"]:
            out.append(d)
    return out


def parse_ics(text, days=45):
    out, cur = [], None
    text = re.sub(r"\r?\n[ \t]", "", text)  # unfold lines
    now = dt.datetime.now(dt.timezone.utc).date()
    for line in text.splitlines():
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT" and cur is not None:
            ds = cur.get("DTSTART", "")
            m = re.match(r"(\d{4})(\d{2})(\d{2})", ds)
            if m and cur.get("SUMMARY"):
                d = dt.date(int(m[1]), int(m[2]), int(m[3]))
                if now <= d <= now + dt.timedelta(days=days):
                    unesc = lambda s: s.replace("\\n", " ").replace("\\,", ",").replace("\\;", ";")
                    out.append({"title": unesc(cur["SUMMARY"]), "url": cur.get("URL", ""), "summary": unesc(cur.get("DESCRIPTION", ""))[:600], "place": unesc(cur.get("LOCATION", ""))[:120], "eventDate": d.isoformat(), "published": None, "image": "", "uid": cur.get("UID", "")})
            cur = None
        elif cur is not None and ":" in line:
            k, v = line.split(":", 1)
            cur[k.split(";")[0]] = v
    return out


def fetch_source(src):
    typ = src.get("type", "rss")
    url = src["url"]
    if typ == "bluesky":
        handle = url.replace("https://bsky.app/profile/", "").strip("/@ ")
        raw, _ = http(f"https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor={urllib.parse.quote(handle)}&limit=25&filter=posts_no_replies")
        out = []
        for f in json.loads(raw).get("feed", []):
            p = f.get("post", {})
            rec = p.get("record", {})
            if f.get("reason"):  # reposts
                continue
            rkey = p.get("uri", "").rsplit("/", 1)[-1]
            img = ""
            emb = p.get("embed") or {}
            if emb.get("images"):
                img = emb["images"][0].get("fullsize", "")
            elif emb.get("external", {}).get("thumb"):
                img = emb["external"]["thumb"]
            text = rec.get("text", "")
            out.append({"title": first_words(text, 14), "url": f"https://bsky.app/profile/{handle}/post/{rkey}", "summary": text, "published": parse_date(rec.get("createdAt", "")), "image": img})
        return out
    if typ == "mastodon":
        m = re.match(r"(https://[^/]+)/@([^/@]+)", url)
        if not m:
            raise ValueError("use a link like https://server/@name")
        base, name = m.group(1), m.group(2)
        acct = json.loads(http(f"{base}/api/v1/accounts/lookup?acct={name}")[0])
        sts = json.loads(http(f"{base}/api/v1/accounts/{acct['id']}/statuses?limit=25&exclude_replies=true&exclude_reblogs=true")[0])
        return [{"title": first_words(strip_html(s.get("content")), 14), "url": s.get("url"), "summary": strip_html(s.get("content")), "published": parse_date(s.get("created_at", "")), "image": (s.get("media_attachments") or [{}])[0].get("preview_url", "")} for s in sts]
    raw, _ = http(url)
    if typ == "ics" or raw.lstrip().startswith(b"BEGIN:VCALENDAR"):
        return parse_ics(raw.decode("utf-8", "replace"))
    return parse_feed(raw)


def heuristic_item(it, src, settings):
    c = settings.get("community", {})
    text = f"{it['title']} {it.get('summary', '')}".lower()
    score = 5 + sum(1 for w in c.get("boostWords", []) if w.lower() in text)
    summ = first_words(it.get("summary", ""), 32)
    return {
        "score": min(score, 10),
        "summary": summ,
        "short": f"{it['title']} (via {src['name']})"[:250],
        "long": "",
        "kind": "event" if it.get("eventDate") else "news",
    }


def ai_enrich(items, settings):
    st = settings["station"]
    sys_prompt = (
        f"You are the community desk editor for {st['name']}, a nonprofit community radio station in {st['city']}. "
        "You pick local items worth sharing with listeners and write them up in the station's own words. "
        "Keep: events, opportunities, resources, arts, music, culture, youth, neighborhood good news, useful civic info. "
        "Drop: crime, accidents, tragedy, lawsuits, partisan politics, ads, anything unclear. "
        "Never invent facts, dates or places. Write summaries in your own words (no copying sentences). Credit the source. Reply with JSON only."
    )
    payload = [{"i": i, "source": it["_src"], "title": it["title"], "text": first_words(it.get("summary", ""), 120), "event_date_hint": it.get("eventDate", ""), "place_hint": it.get("place", "")} for i, it in enumerate(items)]
    user = (
        f"Today is {dt.date.today().isoformat()}. For each item return an object: "
        '{"i": number, "keep": true|false, "score": 0-10 (how much our listeners would care), "kind": "event"|"news", '
        '"eventDate": "YYYY-MM-DD" only if the text states the date else "", "place": "short place name or empty", '
        '"region": "Northeast Ohio"|"Global", "summary": "max 40 words, own words", '
        f'"short": "max 220 characters, friendly, ends with (via SOURCE)", "long": "60-100 words for Facebook/Instagram, ends with 2-3 hashtags, credit the source"}}.\n'
        + json.dumps(payload, ensure_ascii=False)
    )
    arr = extract_json(claude(sys_prompt, user, 8000))
    return {int(a["i"]): a for a in (arr or []) if isinstance(a, dict) and "i" in a}


def scout():
    global SETTINGS
    tasks = api("tasks")
    SETTINGS = tasks["settings"]
    settings = SETTINGS
    full = {**settings, "community": tasks["settings"].get("community") or {}}
    # community words come from the worker defaults when present
    block = [w.lower() for w in (full.get("community") or {}).get("blockWords", [])] or ["shooting", "shot", "killed", "homicide", "murder", "crash", "fatal", "arrest", "indicted"]
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
    report, collected = [], []
    for src in settings.get("sources", []):
        if not src.get("enabled", True):
            continue
        try:
            items = fetch_source(src)
            fresh = []
            for it in items[:30]:
                if it.get("published") and it["published"] < cutoff and not it.get("eventDate"):
                    continue
                text = f"{it['title']} {it.get('summary', '')}".lower()
                if any(re.search(rf"\b{re.escape(w)}\b", text) for w in block):
                    continue
                if not it.get("url"):
                    it["url"] = f"{src['url']}#{hashlib.sha1(it['title'].encode()).hexdigest()[:10]}"
                it["_src"] = src["name"]
                it["_srcobj"] = src
                fresh.append(it)
            collected.extend(fresh[:12])
            report.append({"name": src["name"], "ok": True, "found": len(fresh)})
        except Exception as e:
            report.append({"name": src["name"], "ok": False, "found": 0, "error": str(e)[:200]})
            say("source failed:", src["name"], e)
    enriched = {}
    for start in range(0, len(collected), 25):
        chunk = collected[start : start + 25]
        res = ai_enrich(chunk, full) if AI_KEY else {}
        for i, it in enumerate(chunk):
            enriched[start + i] = res.get(i)
    out = []
    for i, it in enumerate(collected):
        src = it["_srcobj"]
        e = enriched.get(i)
        if e is not None and not e.get("keep", True):
            continue
        h = e or heuristic_item(it, src, full)
        out.append({
            "url": it["url"], "title": it["title"][:200], "source": src["name"], "region": h.get("region") or src.get("region", "Northeast Ohio"),
            "summary": h.get("summary") or first_words(it.get("summary", ""), 32), "short": h.get("short", ""), "long": h.get("long", ""),
            "kind": h.get("kind") or ("event" if it.get("eventDate") else "news"), "eventDate": h.get("eventDate") or it.get("eventDate", ""),
            "place": h.get("place") or it.get("place", ""), "score": h.get("score", 5), "image": it.get("image", "") if (it.get("image", "") or "").startswith("https://") else "",
            "published": int(it["published"].timestamp() * 1000) if it.get("published") else None,
        })
    added = api("items", {"items": out}).get("added", 0) if out else 0
    # new episodes in the station's own podcast/YouTube feeds -> clip jobs
    seen = list(tasks.get("seenFeedEntries") or [])
    first_run = not seen  # first time: clip only the newest episode, not the whole back catalogue
    queued = 0
    for feed in (settings.get("studio") or {}).get("videoFeeds", []):
        try:
            entries = fetch_source({"url": feed["url"], "type": "rss"})[:5]
            for idx, en in enumerate(entries):
                key = hashlib.sha1((en.get("id") or en["url"]).encode()).hexdigest()[:16]
                if key in seen:
                    continue
                seen.append(key)
                if first_run and idx > 0:
                    continue
                api("jobs", {"type": "clip", "url": en.get("enclosure") or en["url"], "title": en["title"], "source": feed.get("name", "")})
                queued += 1
        except Exception as e:
            report.append({"name": feed.get("name", feed["url"]), "ok": False, "found": 0, "error": str(e)[:200]})
    api("scout-report", {"sources": report, "added": added, "considered": len(out), "jobsQueued": queued, "seenFeedEntries": seen})
    say(f"scout: {len(collected)} candidates, {added} new on the community desk, {queued} new episodes queued")
    return added


# ---------------------------------------------------------------------------
# Rendering: HTML -> JPG/PNG with headless Chrome
# ---------------------------------------------------------------------------
FONTS_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;600;800&display=swap" rel="stylesheet">'


def chrome_shot(html_doc, w, h, out_png, transparent=False):
    if not CHROME:
        raise RuntimeError("Google Chrome not found")
    WORK.mkdir(parents=True, exist_ok=True)
    f = WORK / f"r-{hashlib.sha1(html_doc.encode()).hexdigest()[:12]}.html"
    f.write_text(html_doc, encoding="utf-8")
    args = [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", f"--window-size={w},{h}", "--virtual-time-budget=6000", f"--screenshot={out_png}"]
    if transparent:
        args.append("--default-background-color=00000000")
    args.append(f.resolve().as_uri())
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    return out_png


def to_jpg(png, jpg):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(png), "-q:v", "3", str(jpg)], check=True)
    return jpg


def brand():
    st = SETTINGS.get("station", {})
    return {"name": st.get("name", "Resofrik FM"), "slogan": st.get("slogan", "For The Rare Breed"), "accent": st.get("brandColor", "#c9a227"), "dark": st.get("darkColor", "#111111"), "logo": st.get("logoUrl", ""), "label": st.get("linkLabel", "resofrikfm.com"), "city": st.get("city", "Cleveland")}


BASE_CSS = """
*{box-sizing:border-box;margin:0;padding:0}html,body{width:%(w)dpx;height:%(h)dpx;overflow:hidden}
body{font-family:Inter,'DejaVu Sans',Arial,sans-serif;color:#f6f2ea;background:%(dark)s;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(1200px 900px at 85%% -10%%, %(accent)s55, transparent 60%%),radial-gradient(900px 700px at -10%% 110%%, %(accent)s33, transparent 60%%),%(dark)s}
.grain{position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.025) 0 2px,transparent 2px 4px)}
.rings{position:absolute;right:-220px;top:-220px;width:760px;height:760px;border-radius:50%%;border:2px solid %(accent)s55;box-shadow:0 0 0 60px %(accent)s14,0 0 0 120px %(accent)s0d,0 0 0 180px %(accent)s08}
.top{position:absolute;left:72px;right:72px;top:64px;display:flex;align-items:center;gap:22px}
.logo{height:92px;width:auto;border-radius:14px}.word{font-family:'Archivo Black',Inter,sans-serif;font-size:40px;letter-spacing:.5px}
.chip{display:inline-block;background:%(accent)s;color:#111;font-weight:800;font-size:26px;letter-spacing:2px;text-transform:uppercase;padding:10px 20px;border-radius:999px}
.main{position:absolute;left:72px;right:72px;top:250px;bottom:210px;display:flex;flex-direction:column;justify-content:center;gap:34px}
.head{font-family:'Archivo Black',Inter,sans-serif;line-height:1.02;font-size:112px;letter-spacing:-1px;text-wrap:balance}
.sub{font-size:40px;line-height:1.35;color:#e9e2d4;text-wrap:pretty}
.meta{font-size:36px;font-weight:800;color:%(accent)s}
.foot{position:absolute;left:72px;right:72px;bottom:64px;display:flex;justify-content:space-between;align-items:flex-end;font-size:30px;color:#cfc7b8}
.foot b{color:#fff;font-size:34px}.slogan{font-style:italic;color:%(accent)s}
.num{font-family:'Archivo Black',Inter,sans-serif;font-size:220px;line-height:.8;color:%(accent)s;opacity:.95}
.photo{width:100%%;height:400px;object-fit:cover;border-radius:28px;border:4px solid %(accent)s}
.bar{position:absolute;left:0;right:0;bottom:0;height:14px;background:%(accent)s}
"""

FIT_JS = """<script>
function fit(sel,min){document.querySelectorAll(sel).forEach(function(el){var box=document.querySelector('.main');var fs=parseFloat(getComputedStyle(el).fontSize);
var guard=0;while((box.scrollHeight>box.clientHeight+2||el.scrollWidth>el.clientWidth+2)&&fs>min&&guard<200){fs-=3;el.style.fontSize=fs+'px';guard++;}});}
document.fonts&&document.fonts.ready.then(function(){fit('.head',44);fit('.sub',26);});fit('.head',44);fit('.sub',26);
</script>"""


def page(body, w=CW, h=CH, extra_css=""):
    b = brand()
    css = BASE_CSS % {"w": w, "h": h, "accent": b["accent"], "dark": b["dark"]}
    return f"<!doctype html><html><head><meta charset='utf-8'>{FONTS_LINK}<style>{css}{extra_css}</style></head><body><div class='bg'></div><div class='grain'></div><div class='rings'></div>{body}<div class='bar'></div>{FIT_JS}</body></html>"


def top_html():
    b = brand()
    logo = f"<img class='logo' src='{esc(b['logo'])}' alt=''>" if b["logo"] else ""
    return f"<div class='top'>{logo}<div class='word'>{esc(b['name'])}</div></div>"


def foot_html(left=None):
    b = brand()
    return f"<div class='foot'><div><b>{esc(left or 'Listen live')}</b><br>{esc(b['label'])}</div><div class='slogan'>{esc(b['slogan'])}</div></div>"


PILLAR_CHIP = {"music": "Rare Breed Sounds", "program": "Real Talk", "community": "Around town", "behind": "Behind the mic", "cta": "Join the breed", "manual": "Resofrik FM", "reminder": "Tonight"}


def card_html(post):
    b = brand()
    pillar = post.get("pillar") or "music"
    chip = PILLAR_CHIP.get(pillar, "Resofrik FM")
    if pillar == "community":
        chip = f"Around {b['city']}"
    head = post.get("headline") or first_words(re.split(r"(?<=[.!?])\s", post.get("short", ""))[0], 12)
    sub = post.get("short", "")
    if sub.strip().startswith(head.strip()[:20]):
        sub = sub[len(head) :].strip(" —-:.") if len(sub) > len(head) + 10 else ""
    sub = re.sub(r"\s*\(via [^)]*\)\s*$", "", sub).strip(" —-:")
    meta = ""
    if post.get("eventDate"):
        d = dt.date.fromisoformat(post["eventDate"])
        meta = f"{d.strftime('%a, %b')} {d.day}" + (f" · {post.get('place')}" if post.get("place") else "")
    if post.get("source"):
        meta = (meta + " · " if meta else "") + f"via {post['source']}"
    body = f"""{top_html()}<div class='main'><div><span class='chip'>{esc(chip)}</span></div><div class='head'>{esc(head)}</div>{f"<div class='meta'>{esc(meta)}</div>" if meta else ""}{f"<div class='sub'>{esc(first_words(sub, 40))}</div>" if sub else ""}</div>{foot_html('Details at the link' if post.get('kind') == 'community' else None)}"""
    return page(body)


def render_card(post, out_dir):
    png = Path(out_dir) / f"card-{post['id']}.png"
    chrome_shot(card_html(post), CW, CH, str(png))
    return to_jpg(png, png.with_suffix(".jpg"))


def show_card_html(show):
    when = f"{DAY_PLURAL.get(show['day'], show['day'])} · {fmt12(show['start'])} ET"
    body = f"""{top_html()}<div class='main'><div><span class='chip'>On air</span></div><div class='head'>{esc(show['show'])}</div><div class='meta'>{esc(when)}</div><div class='sub'>{esc(show.get('description', ''))}</div></div>{foot_html()}"""
    return page(body)


DAY_PLURAL = {"Sun": "Sundays", "Mon": "Mondays", "Tue": "Tuesdays", "Wed": "Wednesdays", "Thu": "Thursdays", "Fri": "Fridays", "Sat": "Saturdays"}


def fmt12(hhmm):
    h, m = map(int, hhmm.split(":"))
    return f"{h % 12 or 12}{':' + str(m).zfill(2) if m else ''} {'PM' if h >= 12 else 'AM'}"


# ---------------------------------------------------------------------------
# Carousels
# ---------------------------------------------------------------------------
def slide_cover(title, kicker, sub=""):
    return page(f"""{top_html()}<div class='main'><div><span class='chip'>{esc(kicker)}</span></div><div class='head' style='font-size:132px'>{esc(title)}</div>{f"<div class='sub'>{esc(sub)}</div>" if sub else ""}<div class='meta'>Swipe →</div></div>{foot_html()}""")


def slide_item(n, title, meta, text, photo=""):
    ph = f"<img class='photo' src='{esc(photo)}' alt=''>" if photo else ""
    num_style = " style='font-size:120px'" if photo else ""
    head_size = 76 if photo else 84
    return page(f"""{top_html()}<div class='main' style='gap:26px'>{ph}<div class='num'{num_style}>{n:02d}</div><div class='head' style='font-size:{head_size}px'>{esc(title)}</div>{f"<div class='meta'>{esc(meta)}</div>" if meta else ""}{f"<div class='sub'>{esc(first_words(text, 36))}</div>" if text else ""}</div>{foot_html()}""")


def slide_cta(line1, line2):
    b = brand()
    return page(f"""{top_html()}<div class='main' style='align-items:flex-start'><div class='head' style='font-size:120px'>{esc(line1)}</div><div class='sub'>{esc(line2)}</div><div><span class='chip' style='font-size:34px;padding:16px 30px'>{esc(b['label'])}</span></div></div>{foot_html('Follow for more')}""")


def render_slides(htmls, out_dir, tag):
    files = []
    for i, h in enumerate(htmls):
        png = Path(out_dir) / f"{tag}-{i + 1}.png"
        chrome_shot(h, CW, CH, str(png))
        files.append(to_jpg(png, png.with_suffix(".jpg")))
    return files


def week_dates(monday):
    m = dt.date.fromisoformat(monday)
    return {name: (m + dt.timedelta(days=i)).isoformat() for i, name in enumerate(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])}


def carousel_texts(kind, context):
    st = SETTINGS["station"]
    fallback = {
        "lineup": (f"This week on {st['name']}: the shows to catch. Swipe through and set your reminders.", f"This week on {st['name']} — swipe for the shows, days and times. Music for a while, then a program or two.\n\nSave this post so you don't miss a show.\n\n{' '.join(st.get('hashtagsLocal', []))}"),
        "cleveland": (f"Around {st['city']} this week — swipe for what's happening near you.", f"Around {st['city']} this week. Swipe for events and good news from our neighbors, with thanks to the sources credited on each slide.\n\nKnow something we should share? Tell us in the comments.\n\n{' '.join(st.get('hashtagsLocal', []))}"),
        "rotation": (f"The Rare Breed rotation: artists you'll hear on {st['name']} this week.", f"The Rare Breed rotation. Every one of these artists sent us their music directly, and we play it with their permission.\n\nWho should we add next? Tell us below.\n\n{' '.join(st.get('hashtagsGlobal', []))}"),
    }[kind]
    if not AI_KEY:
        return {"short": fallback[0], "long": fallback[1]}
    res = extract_json(claude(f"You write social posts for {st['name']}. Voice: {st.get('voice', '')} Use only the facts given. No URLs. JSON only.", f"Write a carousel post. Type: {kind}. Facts: {json.dumps(context, ensure_ascii=False)}. Return {{\"short\": \"max 220 chars\", \"long\": \"60-100 words, end with 3 hashtags, invite a comment\"}}", 1500), "{")
    return res if res and res.get("short") and res.get("long") else {"short": fallback[0], "long": fallback[1]}


def make_weekly(tasks, out_dir):
    wk = tasks.get("weekly")
    if not wk:
        return 0
    st = SETTINGS["station"]
    studio = SETTINGS.get("studio", {})
    want = studio.get("carousels", {})
    t = studio.get("carouselTime", "12:00")
    days = week_dates(wk["monday"])
    made = 0
    shows = SETTINGS.get("schedule") or []
    if want.get("lineup", True) and shows:
        slides = [slide_cover("This week on " + st["name"], "This week", "Music for a while, then a program or two.")]
        for i, s in enumerate(shows[:6], 1):
            slides.append(slide_item(i, s["show"], f"{DAY_PLURAL.get(s['day'], s['day'])} · {fmt12(s['start'])} ET", s.get("description", "")))
        slides.append(slide_cta("Listen live", "Set a reminder and tune in."))
        files = render_slides(slides, out_dir, "lineup")
        tx = carousel_texts("lineup", [{"show": s["show"], "day": s["day"], "time": fmt12(s["start"]) + " ET"} for s in shows])
        api("post", {"kind": "carousel", "pillar": "program", "headline": "This week on " + st["name"], "short": tx["short"], "long": tx["long"], "media": {"type": "images", "urls": [upload(f) for f in files]}, "whenLocal": {"date": days["Mon"], "time": t}})
        made += 1
    board = wk.get("board") or []
    if want.get("clevelandThisWeek", True) and len(board) >= 3:
        slides = [slide_cover(f"Around {st['city']} this week", "Community", "Events and good news from our neighbors.")]
        for i, it in enumerate(board[:5], 1):
            meta = ""
            if it.get("eventDate"):
                d = dt.date.fromisoformat(it["eventDate"])
                meta = f"{d.strftime('%a, %b')} {d.day}" + (f" · {it.get('place')}" if it.get("place") else "")
            meta = (meta + " · " if meta else "") + f"via {it.get('source', '')}"
            slides.append(slide_item(i, it["title"], meta, it.get("summary", ""), it.get("image", "")))
        slides.append(slide_cta("Share your event", f"Nonprofits and community groups: send it to us at {st.get('linkLabel', '')}."))
        files = render_slides(slides, out_dir, "cleveland")
        urls = [upload(f) for f in files]
        tx = carousel_texts("cleveland", [{"title": it["title"], "date": it.get("eventDate", ""), "source": it.get("source", "")} for it in board[:5]])
        api("post", {"kind": "carousel", "pillar": "community", "headline": f"Around {st['city']} this week", "short": tx["short"], "long": tx["long"], "media": {"type": "images", "urls": urls}, "whenLocal": {"date": days["Tue"], "time": t}})
        made += 1
        if studio.get("slideshowVideos", True):
            mp4 = slideshow_video(files, Path(out_dir) / "cleveland-week.mp4", studio.get("musicBedUrl", ""))
            api("post", {"kind": "slideshow", "pillar": "community", "headline": f"Around {st['city']} this week", "short": f"Around {st['city']} this week, in 30 seconds. What are you going to?", "long": tx["long"], "media": {"type": "video", "urls": [upload(mp4)]}, "whenLocal": {"date": days["Thu"], "time": t}})
            made += 1
    artists = [a for a in SETTINGS.get("artists") or [] if a.get("name")]
    if want.get("rotation", True) and len(artists) >= 2:
        slides = [slide_cover("The Rare Breed rotation", "On air now", "Artists who sent us their music. Played with permission.")]
        for i, a in enumerate(artists[:6], 1):
            slides.append(slide_item(i, a["name"], " · ".join(x for x in [a.get("genre", ""), a.get("city", "")] if x), f"Listen for “{a['song']}”." if a.get("song") else "", a.get("image", "")))
        slides.append(slide_cta("Hear them live", "New music every day on " + st["name"] + "."))
        files = render_slides(slides, out_dir, "rotation")
        tx = carousel_texts("rotation", [{k: a.get(k, "") for k in ("name", "genre", "song", "city")} for a in artists[:6]])
        api("post", {"kind": "carousel", "pillar": "music", "headline": "The Rare Breed rotation", "short": tx["short"], "long": tx["long"], "media": {"type": "images", "urls": [upload(f) for f in files]}, "whenLocal": {"date": days["Fri"], "time": t}})
        made += 1
    api("carousels-done", {"monday": wk["monday"]})
    return made


# ---------------------------------------------------------------------------
# Video
# ---------------------------------------------------------------------------
X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "4500k", "-bufsize", "9M", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart"]


def ff(*args):
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *map(str, args)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError("ffmpeg: " + p.stderr[-800:])


def probe(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", str(path)], capture_output=True, text=True)
    d = json.loads(p.stdout or "{}")
    v = next((s for s in d.get("streams", []) if s.get("codec_type") == "video" and s.get("width")), None)
    a = any(s.get("codec_type") == "audio" for s in d.get("streams", []))
    return {"duration": float(d.get("format", {}).get("duration", 0) or 0), "video": v, "audio": a}


def overlay_png(title, out_png, kind="clip"):
    b = brand()
    logo = f"<img src='{esc(b['logo'])}' style='height:96px;border-radius:16px'>" if b["logo"] else ""
    doc = f"""<!doctype html><html><head><meta charset='utf-8'>{FONTS_LINK}<style>
*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:{W}px;height:{H}px;background:transparent;overflow:hidden;font-family:Inter,'DejaVu Sans',sans-serif;color:#fff}}
.top{{position:absolute;top:0;left:0;right:0;height:300px;background:linear-gradient(#000c,#0000);padding:70px 64px;display:flex;gap:22px;align-items:center}}
.name{{font-family:'Archivo Black',Inter,sans-serif;font-size:44px}}.t{{font-size:34px;color:{b['accent']};font-weight:800;margin-top:6px;max-width:820px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.bot{{position:absolute;bottom:0;left:0;right:0;height:300px;background:linear-gradient(#0000,#000d);display:flex;align-items:flex-end;justify-content:space-between;padding:0 64px 86px}}
.cta{{background:{b['accent']};color:#111;font-weight:800;font-size:36px;padding:16px 28px;border-radius:999px}}.sl{{font-style:italic;font-size:32px;color:#eee}}
</style></head><body><div class='top'>{logo}<div><div class='name'>{esc(b['name'])}</div><div class='t'>{esc(title)}</div></div></div>
<div class='bot'><div class='cta'>▶ {esc(b['label'])}</div><div class='sl'>{esc(b['slogan'])}</div></div></body></html>"""
    return chrome_shot(doc, W, H, str(out_png), transparent=True)


def ass_time(t):
    t = max(0, t)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def write_ass(words, start, end, path, accent="#c9a227"):
    """Word-timed captions, 2-4 words at a time, big and centered in the lower third."""
    r, g, b_ = int(accent[1:3], 16), int(accent[3:5], 16), int(accent[5:7], 16)
    acc = f"&H00{b_:02X}{g:02X}{r:02X}"
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{FONT},78,&H00FFFFFF,{acc},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ws = [w for w in words if w["end"] > start and w["start"] < end and w["word"].strip()]
    lines, chunk = [], []
    for w in ws:
        chunk.append(w)
        txt = " ".join(x["word"].strip() for x in chunk)
        if len(chunk) >= 4 or len(txt) > 22 or re.search(r"[.!?,]$", w["word"].strip()):
            lines.append(chunk)
            chunk = []
    if chunk:
        lines.append(chunk)
    ev = []
    for i, ch in enumerate(lines):
        s = ch[0]["start"] - start
        e = (lines[i + 1][0]["start"] - start) if i + 1 < len(lines) else ch[-1]["end"] - start + 0.3
        e = min(e, ch[-1]["end"] - start + 0.6, end - start)
        text = " ".join(x["word"].strip() for x in ch).replace("{", "(").replace("}", ")").replace("\\", "/")
        ev.append(f"Dialogue: 0,{ass_time(s)},{ass_time(max(e, s + 0.3))},Cap,,0,0,0,,{text}")
    Path(path).write_text(head + "\n".join(ev) + "\n", encoding="utf-8")
    return path


def render_clip(src, start, end, words, title, out, has_video=True, art_png=None):
    """Vertical 1080x1920 short: blurred fill + centered video (or artwork + waveform for audio), captions, brand bars."""
    d = end - start
    tmp = Path(out).parent
    ov = overlay_png(title, tmp / f"ov-{Path(out).stem}.png")
    ass = write_ass(words, start, end, tmp / f"cap-{Path(out).stem}.ass", brand()["accent"])
    ass_f = str(ass).replace("\\", "/").replace(":", "\\:")
    fade = f"afade=t=in:st=0:d=0.3,afade=t=out:st={max(d - 0.6, 0):.2f}:d=0.6,loudnorm=I=-14:TP=-1.5:LRA=11"
    if has_video:
        fc = (f"[0:v]split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=24:2,eq=brightness=-0.18[bg];"
              f"[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v1];[v1][1:v]overlay=0:0[v2];[v2]subtitles='{ass_f}'[v];[0:a]{fade}[a2]")
        ff("-ss", f"{start:.2f}", "-t", f"{d:.2f}", "-i", src, "-i", ov, "-filter_complex", fc, "-map", "[v]", "-map", "[a2]", *X264, "-shortest", out)
    else:
        bgimg = art_png or ov
        fc = (f"[1:v]scale={W}:{H}[bg];[0:a]asplit[w][au];[w]showwaves=s=880x260:mode=cline:rate=30:colors={brand()['accent']}[wv];"
              f"[bg][wv]overlay=(W-w)/2:1180[v1];[v1][2:v]overlay=0:0[v2];[v2]subtitles='{ass_f}'[v];[au]{fade}[a2]")
        ff("-ss", f"{start:.2f}", "-t", f"{d:.2f}", "-i", src, "-loop", "1", "-t", f"{d:.2f}", "-i", bgimg, "-i", ov, "-filter_complex", fc, "-map", "[v]", "-map", "[a2]", *X264, "-shortest", out)
    return out


def audiogram_bg(title, subtitle, out_png, photo=""):
    b = brand()
    ph = f"<img src='{esc(photo)}' style='width:760px;height:760px;object-fit:cover;border-radius:40px;border:6px solid {b['accent']}'>" if photo else f"<div style='width:760px;height:760px;border-radius:50%;border:6px solid {b['accent']};display:flex;align-items:center;justify-content:center;font-family:Archivo Black,Inter;font-size:120px;color:{b['accent']}'>ON AIR</div>"
    body = f"""<div style='position:absolute;top:330px;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:40px;text-align:center;padding:0 80px'>{ph}<div class='head' style='font-size:76px'>{esc(title)}</div><div class='sub'>{esc(subtitle)}</div></div>"""
    doc = page(body, W, H).replace("<div class='rings'></div>", "")
    return chrome_shot(doc, W, H, str(out_png))


def slideshow_video(slides, out, music_url=""):
    """Slides (4:5) -> vertical video with gentle zoom, 4 s each, music bed if provided."""
    tmp = Path(out).parent
    segs = []
    per = 4.0
    for i, s in enumerate(slides):
        seg = tmp / f"seg-{Path(out).stem}-{i}.mp4"
        frames = int(per * 30)
        fc = (f"[0:v]split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:2,eq=brightness=-0.25[bg];"
              f"[b]scale=2160:-2,zoompan=z='min(zoom+0.0007,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={CW}x{CH}:fps=30[fg];"
              f"[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]")
        ff("-loop", "1", "-t", f"{per}", "-i", s, "-f", "lavfi", "-t", f"{per}", "-i", "anullsrc=r=44100:cl=stereo", "-filter_complex", fc, "-map", "[v]", "-map", "1:a", *X264, "-t", f"{per}", seg)
        segs.append(seg)
    lst = tmp / f"list-{Path(out).stem}.txt"
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in segs))
    silent = tmp / f"silent-{Path(out).stem}.mp4"
    ff("-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", silent)
    total = per * len(slides)
    if music_url:
        try:
            bed = download(music_url, tmp / "bed.mp3")
            ff("-i", silent, "-i", bed, "-filter_complex", f"[1:a]atrim=0:{total},afade=t=in:d=1,afade=t=out:st={total - 2}:d=2,volume=0.8[m]", "-map", "0:v", "-map", "[m]", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out)
            return out
        except Exception as e:
            say("music bed skipped:", e)
    shutil.copy(silent, out)
    return out


def artist_promo(a, out_dir):
    st = SETTINGS["station"]
    tmp = Path(out_dir)
    audio = download(a["audio"], tmp / f"{slugify(a['name'])}.audio")
    start = float(a.get("audioStart", 30))
    dur = 20.0
    info = probe(audio)
    if info["duration"] and info["duration"] < start + dur:
        start = max(0.0, info["duration"] - dur)
    bg = audiogram_bg(a["name"], f"“{a['song']}” · now on {st['name']}" if a.get("song") else f"Now on {st['name']}", tmp / f"promo-{slugify(a['name'])}.png", a.get("image", ""))
    out = tmp / f"promo-{slugify(a['name'])}.mp4"
    ov = overlay_png("New on rotation", tmp / f"ov-promo-{slugify(a['name'])}.png")
    fc = (f"[1:v]scale={W}:{H}[bg];[0:a]asplit[w][au];[w]showwaves=s=880x200:mode=cline:rate=30:colors={brand()['accent']}[wv];"
          f"[bg][wv]overlay=(W-w)/2:1480[v1];[v1][2:v]overlay=0:0[v];[au]afade=t=in:d=0.5,afade=t=out:st={dur - 1.5}:d=1.5,loudnorm=I=-14:TP=-1.5[a2]")
    ff("-ss", f"{start}", "-t", f"{dur}", "-i", audio, "-loop", "1", "-t", f"{dur}", "-i", bg, "-i", ov, "-filter_complex", fc, "-map", "[v]", "-map", "[a2]", *X264, "-shortest", out)
    return out


# ---------------------------------------------------------------------------
# Shorts from long recordings
# ---------------------------------------------------------------------------
def transcribe(path):
    from faster_whisper import WhisperModel  # installed on the runner

    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    segs, _ = model.transcribe(str(path), word_timestamps=True, vad_filter=True, beam_size=1)
    segments, words = [], []
    for s in segs:
        segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})
        for w in s.words or []:
            words.append({"start": w.start, "end": w.end, "word": w.word})
    return segments, words


BOOST = re.compile(r"\b(music|cleveland|community|love|artist|song|story|family|why|never|always|secret|truth|dream|history|culture|africa|naija|caribbean|poetry|poem)\b", re.I)


def pick_moments_heuristic(segments, n, lo=20, hi=55):
    cands = []
    for i in range(len(segments)):
        j, words, score = i, 0, 0.0
        while j < len(segments) and segments[j]["end"] - segments[i]["start"] < hi:
            seg = segments[j]
            words += len(seg["text"].split())
            score += len(BOOST.findall(seg["text"])) * 2 + seg["text"].count("?") * 1.5 + seg["text"].count("!")
            dur = seg["end"] - segments[i]["start"]
            if dur >= lo and re.search(r"[.!?]$", seg["text"]):
                cands.append((score + words / max(dur, 1) * 3, segments[i]["start"], seg["end"]))
            j += 1
    cands.sort(reverse=True)
    picked = []
    for sc, s, e in cands:
        if all(e <= ps or s >= pe for _, ps, pe in picked):
            picked.append((sc, s, e))
        if len(picked) >= n:
            break
    return [{"start": s, "end": e} for _, s, e in sorted(picked, key=lambda x: x[1])]


def pick_moments(segments, n, title, lo=20, hi=55):
    if AI_KEY and segments:
        lines, budget = [], 60000
        for k, s in enumerate(segments):
            ln = f"[{k}] {s['start']:.1f}-{s['end']:.1f} {s['text']}"
            budget -= len(ln)
            if budget < 0:
                break
            lines.append(ln)
        st = SETTINGS["station"]
        res = extract_json(claude(
            f"You are a short-form video editor for {st['name']}, a community radio station. Pick moments that work on their own as 20-55 second vertical clips: a strong opening line, a complete thought, emotion, humor, insight or a great line about music or {st['city']}. Avoid profanity, private information, and anything that could embarrass a guest. JSON only.",
            f"Program: {title}\nTranscript segments (index, start-end seconds, text):\n" + "\n".join(lines) + f"\n\nReturn a JSON array of up to {n} objects: "
            '{"from": first segment index, "to": last segment index, "title": "max 7 words for the on-screen title", "short": "max 200 characters for Bluesky/Threads, a hook, no hashtags", "long": "40-80 words for Instagram/Facebook, end with 3 hashtags"}. '
            f"Each clip must last {lo}-{hi} seconds and clips must not overlap.", 3000))
        out = []
        for r in res or []:
            try:
                a, b = segments[int(r["from"])], segments[int(r["to"])]
                if lo - 3 <= b["end"] - a["start"] <= hi + 5 and all(b["end"] <= o["start"] or a["start"] >= o["end"] for o in out):
                    out.append({"start": a["start"], "end": b["end"], "title": str(r.get("title", ""))[:60], "short": str(r.get("short", "")), "long": str(r.get("long", ""))})
            except Exception:
                continue
        if out:
            return out[:n]
    return pick_moments_heuristic(segments, n, lo, hi)


def fetch_media(url, dest_dir):
    dest_dir = Path(dest_dir)
    if re.search(r"(youtube\.com|youtu\.be)/", url):
        ytdlp = shutil.which("yt-dlp")
        if not ytdlp:
            raise RuntimeError("yt-dlp is not installed")
        out = dest_dir / "source.%(ext)s"
        subprocess.run([ytdlp, "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "-o", str(out), url], check=True, timeout=1800)
        return next(dest_dir.glob("source.*"))
    ext = re.search(r"\.(mp4|mov|m4v|mp3|m4a|wav|aac|ogg|webm)(\?|$)", url, re.I)
    return download(url, dest_dir / f"source.{ext.group(1).lower() if ext else 'bin'}")


def process_clip_job(job, out_dir):
    st = SETTINGS["station"]
    studio = SETTINGS.get("studio", {})
    lo, hi = (studio.get("clipSeconds") or [20, 55])[:2]
    jd = Path(out_dir) / f"job-{job['id']}"
    jd.mkdir(parents=True, exist_ok=True)
    src = fetch_media(job["url"], jd)
    info = probe(src)
    if not info["audio"]:
        raise RuntimeError("the file has no sound to work with")
    title = job.get("title") or "Resofrik FM"
    audio = jd / "audio.wav"
    ff("-i", src, "-vn", "-ac", "1", "-ar", "16000", "-t", str(int(os.environ.get("MAX_MINUTES", "90")) * 60), audio)
    segments, words = transcribe(audio)
    moments = pick_moments(segments, int(job.get("count") or studio.get("clipsPerVideo", 4)), title, lo, hi)
    if not moments:
        raise RuntimeError("couldn't find good moments")
    art = None
    if not info["video"]:
        art = audiogram_bg(title, f"Listen on {st['name']}", jd / "art.png")
    posted = []
    for k, m in enumerate(moments, 1):
        out = jd / f"short-{k}.mp4"
        on_screen = m.get("title") or title
        render_clip(str(src), m["start"], m["end"], words, on_screen, str(out), bool(info["video"]), art)
        url = upload(out)
        quote = " ".join(w["word"].strip() for w in words if m["start"] <= w["start"] < m["end"])
        short = m.get("short") or f"“{first_words(quote, 22)}” — from {title} on {st['name']}"
        long = m.get("long") or f"A moment from {title} on {st['name']}.\n\n“{first_words(quote, 45)}”\n\nListen live at {st.get('linkLabel', '')}.\n\n{' '.join(st.get('hashtagsLocal', []))}"
        r = api("post", {"kind": "clip", "pillar": "program", "headline": on_screen, "short": short, "long": long, "media": {"type": "video", "urls": [url]}, "schedule": "auto", "jobId": job["id"]})
        posted.append(r.get("whenLocal", ""))
    return f"{len(posted)} shorts from “{title}” scheduled: " + ", ".join(posted)


# ---------------------------------------------------------------------------
# MAKE
# ---------------------------------------------------------------------------
def make():
    global SETTINGS
    tasks = api("tasks")
    SETTINGS = tasks["settings"]
    out_dir = WORK / dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    done = {"cards": 0, "showcards": 0, "carousels": 0, "promos": 0, "jobs": 0}
    for c in tasks.get("cards", [])[:45]:
        try:
            url = upload(render_card(c, out_dir))
            api("attach", {"postId": c["id"], "type": "image", "urls": [url]})
            done["cards"] += 1
        except Exception as e:
            say("card failed:", c.get("id"), e)
    for s in tasks.get("showCardsNeeded", []):
        try:
            png = out_dir / f"show-{s['slug']}.png"
            chrome_shot(show_card_html(s), CW, CH, str(png))
            api("showcard", {"slug": s["slug"], "url": upload(to_jpg(png, png.with_suffix(".jpg")))})
            done["showcards"] += 1
        except Exception as e:
            say("show card failed:", s.get("show"), e)
    try:
        done["carousels"] = make_weekly(tasks, out_dir)
    except Exception as e:
        say("weekly carousels failed:", e)
    st = SETTINGS["station"]
    for a in tasks.get("artistPromos", []):
        try:
            mp4 = artist_promo(a, out_dir)
            short = f"New on rotation: {a['name']}" + (f" — “{a['song']}”" if a.get("song") else "") + f". Hear it on {st['name']}."
            long = f"New on rotation at {st['name']}: {a['name']}" + (f" from {a['city']}" if a.get("city") else "") + (f" with “{a['song']}”" if a.get("song") else "") + f".\n\nArtists send us their music directly and we play it with their permission.\n\nListen live at {st.get('linkLabel', '')}.\n\n{' '.join(st.get('hashtagsGlobal', []))}"
            api("post", {"kind": "promo", "pillar": "music", "headline": a["name"], "short": short, "long": long, "media": {"type": "video", "urls": [upload(mp4)]}, "schedule": "auto"})
            api("promoted", {"slug": slugify(a["name"])})
            done["promos"] += 1
        except Exception as e:
            say("artist promo failed:", a.get("name"), e)
    for job in tasks.get("jobs", [])[:MAX_JOBS]:
        try:
            summary = process_clip_job(job, out_dir)
            api("job-done", {"id": job["id"], "ok": True, "summary": summary})
            done["jobs"] += 1
        except Exception as e:
            say("job failed:", job.get("url"), e)
            api("job-done", {"id": job["id"], "ok": False, "error": str(e)[:300]})
    say("make:", done)
    return done


def sync_site(path):
    raw, _ = http(f"{API}/api/public/events")
    auto = json.loads(raw)
    p = Path(path)
    current = json.loads(p.read_text()) if p.exists() else []
    if isinstance(current, dict):  # some sites wrap the list
        current = current.get("events", [])
    manual = [e for e in current if not e.get("auto")]
    merged = manual + [{k: v for k, v in e.items() if k != "source"} for e in auto[:12]]
    new_text = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
    if not p.exists() or p.read_text() != new_text:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(new_text)
        say(f"website community board updated: {len(manual)} yours + {min(12, len(auto))} automatic")
        return True
    say("website community board unchanged")
    return False


def main():
    if not API or not TOKEN:
        sys.exit("Set AUTOPILOT_URL and STUDIO_TOKEN.")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd == "scout":
        scout()
    elif cmd == "make":
        make()
    elif cmd == "all":
        try:
            scout()
        except Exception as e:
            say("scout failed:", e)
        make()
    elif cmd == "sync-site":
        f = sys.argv[sys.argv.index("--file") + 1] if "--file" in sys.argv else "content/events.json"
        sync_site(f)
    else:
        sys.exit("usage: studio.py scout|make|all|sync-site [--file content/events.json]")


if __name__ == "__main__":
    main()
