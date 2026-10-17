from __future__ import annotations

import os
import re
import sqlite3
import threading
import time
import uuid
import base64
import io
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, request, send_from_directory

try:
    import pytesseract
    from PIL import Image, ImageOps, ImageFilter
except ImportError:  # OCR remains an explicit, helpful optional feature.
    pytesseract = None
    Image = ImageOps = ImageFilter = None

try:  # Optional: lets PDFs be read (text layer first, OCR for scanned pages).
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

BASE_DIR = Path(__file__).resolve().parent


def load_local_env(path: Path) -> None:
    """Load simple KEY=VALUE entries from .env.

    On your own computer the .env file WINS over old values left in the system
    environment (this was the cause of the old model name sticking around).
    On Render (RENDER env var is set) the dashboard values are kept instead.
    """
    if not path.is_file():
        return
    on_render = bool(os.environ.get("RENDER"))
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            if on_render:
                os.environ.setdefault(name, value)
            else:
                os.environ[name] = value


load_local_env(BASE_DIR / ".env")


def resolve_db_path() -> Path:
    configured = os.getenv("DATABASE_PATH", "codelab.db").strip() or "codelab.db"
    path = Path(configured)
    return path if path.is_absolute() else BASE_DIR / path


DB_PATH = resolve_db_path()
GROQ_API_BASE = os.getenv("GROQ_API_BASE", "https://api.groq.com/openai/v1").rstrip("/")
DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b"
# Models Groq has retired: if one of these is still set anywhere, switch to the default automatically.
_RETIRED_MODELS = {"llama-3.3-70b-versatile", "llama-3.1-8b-instant", "llama3-70b-8192", "llama3-8b-8192"}


def resolve_groq_model() -> str:
    configured = os.getenv("GROQ_MODEL", DEFAULT_GROQ_MODEL).strip() or DEFAULT_GROQ_MODEL
    return DEFAULT_GROQ_MODEL if configured.lower() in _RETIRED_MODELS else configured


GROQ_MODEL = resolve_groq_model()
GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo").strip()
SARVAM_API_URL = os.getenv("SARVAM_API_URL", "https://api.sarvam.ai/text-to-speech").rstrip("/")
SARVAM_TTS_MODEL = os.getenv("SARVAM_TTS_MODEL", "bulbul:v4-flash").strip()
SARVAM_SPEAKER = os.getenv("SARVAM_SPEAKER", "simran_hi_assistant").strip()
MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff"}

app = Flask(__name__, static_folder=None)  # flat layout: static files are served by the allow-listed route below
app.config["MAX_CONTENT_LENGTH"] = 11 * 1024 * 1024

_SYSTEM_PROMPT = """You are Abhi AI, an AI assistant with a warm, natural conversational manner informed by respectful everyday interactions in India. Reply with empathy, politeness, and a clear, concise conversational style. Adapt naturally to Indian contexts without forced slang or stereotypes. At the start of each answer, add exactly one short gesture cue in square brackets, chosen from [smiles], [nods], [looks thoughtful], [waves], [listens attentively], [gives a reassuring nod], or [joins hands in a polite namaste]. The website animates the cue and removes it from spoken replies; do not add more stage directions. If greeting the user, a gentle namaste is appropriate; otherwise choose a natural small gesture. You are an AI, not a human: do not claim to have a real body, real feelings, or human experiences.

Identity: if asked who created, made, built or developed you, answer that you were created by Abhimanyu Rana, who is from Shamli and is pursuing his MCA at Galgotias University. Do not invent additional biographical facts.

Language: reply in the language the user writes in. If the user writes Hindi (Devanagari) reply in Hindi; if they write Hinglish (Hindi in Roman letters) reply in simple Hinglish; otherwise reply in English.

Quality: be genuinely intelligent and helpful. Think the problem through, give the actual answer first, then a short explanation. Use correct facts, show steps for maths/code, and say plainly when you are unsure instead of guessing. Keep answers focused, not padded.

Tables and charts: when the user asks for a table, give one short intro line and then a proper Markdown table (header row, then a separator row like |---|---|). When the user asks for a graph, chart or plot, write one short intro line and then exactly one fenced block in this form:
```chart
{"type":"bar","title":"Title","labels":["A","B"],"datasets":[{"label":"Series","data":[1,2]}]}
```
type must be bar, line, pie or doughnut. The JSON must be valid: numbers only in data, no comments, no trailing commas. Use only numbers the user gave or well-established facts; if you do not know real numbers, say so instead of inventing them. The website draws the chart and table itself, so do not repeat their contents in prose.

Safety and capabilities: do not claim to have opened a website, accessed an account, or placed a phone call. This website can offer user-clickable links to YouTube and Instagram, display the device's local time/date, and open a phone's native dialer only after the user clicks a call link. Do not claim that a call was made. You cannot control arbitrary apps or the user's device. Do not reveal provider, API-key, or implementation details unless the user specifically asks technical setup questions. Never ask the user to paste private API keys into the chat."""

_CREATOR_PATTERNS = (
    re.compile(r"\bwho\s+(?:made|created|built|developed)\s+you\b", re.I),
    re.compile(r"\bwho\s+is\s+your\s+(?:creator|developer|maker)\b", re.I),
    re.compile(r"\b(?:tumhe|tumhein|aapko|tujhe)\s+(?:kisne|kis\s+ne|kis\s+ny|kis\s+nay)\s+(?:banaya|banaaya|bnaaya|create\s+kiya)\b", re.I),
    re.compile(r"\b(?:kisne|kis\s+ne)\s+(?:tumhe|tumhein|aapko)?\s*(?:banaya|banaaya|bnaaya)\b", re.I),
    re.compile(r"(?:तुम्हें|तुम्हे|आपको).{0,12}किसने.{0,12}बनाया|किसने.{0,12}(?:तुम्हें|आपको).{0,12}बनाया"),
    re.compile(r"\b(?:creator|maker|developer|owner)\s+kaun\s+hai\b", re.I),
    re.compile(r"\b(?:tumhara|aapka|tera)\s+(?:creator|developer|maker|owner|malik)\b", re.I),
    re.compile(r"\b(?:tumhe|tumhein|aapko|tujhe)\s+(?:kisne|kis\s+ne)\s+(?:develop|design|build|create|made|bnaya|banaya)\b", re.I),
    re.compile(r"\bwho\s+(?:is|are)\s+(?:your|ur)\s+(?:owner|father|parent|founder)\b", re.I),
    re.compile(r"\bwho\s+(?:programmed|designed|trained)\s+you\b", re.I),
    re.compile(r"(?:किसने|किसने\s+ही).{0,15}(?:बनाया|बनाई|बनाए)|(?:तुम्हारा|आपका)\s*(?:क्रिएटर|निर्माता|डेवलपर)", re.I),
)
_CREATOR_REPLY_EN = "I was created by Abhimanyu Rana. He is from Shamli and is pursuing his MCA at Galgotias University."
_CREATOR_REPLY_HI = "मुझे अभिमन्यु राणा ने बनाया है। वे शामली के रहने वाले हैं और गलगोटियास यूनिवर्सिटी में MCA कर रहे हैं।"
_CREATOR_REPLY_HINGLISH = "Mujhe Abhimanyu Rana ne banaya hai. Woh Shamli ke rehne wale hain aur Galgotias University mein MCA kar rahe hain."
_DEVANAGARI_RE = re.compile(r"[\u0900-\u097F]")


def creator_reply_for(text: str) -> str:
    if _DEVANAGARI_RE.search(text):
        return _CREATOR_REPLY_HI
    if re.search(r"\b(?:kisne|kis\s*ne|kisne|tumhe|tumhein|tujhe|aapko|kaun|banaya|banaaya|bnaya|bnaaya|kiya|hai|ho)\b", text, re.I):
        return _CREATOR_REPLY_HINGLISH
    return _CREATOR_REPLY_EN


_RATE_WINDOW_SECONDS = 60
_RATE_LIMIT = 20
_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = defaultdict(list)
_CONVERSATION_RE = re.compile(r"^[A-Za-z0-9_-]{12,64}$")


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(DB_PATH), timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with connect_db() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL CHECK(length(content) <= 8000),
                created_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS documents (
                conversation_id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_id "
            "ON messages (conversation_id, id)"
        )


def valid_conversation_id(value: Any) -> str | None:
    if isinstance(value, str) and _CONVERSATION_RE.fullmatch(value):
        return value
    return None


def save_message(connection: sqlite3.Connection, conversation_id: str, role: str, content: str) -> None:
    connection.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (conversation_id, role, content[:8000], datetime.now(timezone.utc).isoformat()),
    )


def save_document(connection: sqlite3.Connection, conversation_id: str, filename: str, content: str) -> None:
    """Keep the latest uploaded document per conversation so follow-up questions work."""
    connection.execute(
        "INSERT OR REPLACE INTO documents (conversation_id, filename, content, created_at) VALUES (?, ?, ?, ?)",
        (conversation_id, filename[:200], content[:12000], datetime.now(timezone.utc).isoformat()),
    )


def load_document(connection: sqlite3.Connection, conversation_id: str) -> tuple[str, str] | None:
    row = connection.execute(
        "SELECT filename, content FROM documents WHERE conversation_id = ?", (conversation_id,)
    ).fetchone()
    return (row["filename"], row["content"]) if row else None


def looks_like_creator_question(text: str) -> bool:
    return any(pattern.search(text) for pattern in _CREATOR_PATTERNS)


def has_provider_key() -> bool:
    key = os.getenv("GROQ_API_KEY", "").strip()
    return bool(key) and not key.lower().startswith(("replace_", "your_", "put_", "paste_"))


def is_rate_limited(bucket: str = "default", limit: int = _RATE_LIMIT) -> bool:
    client = f"{request.remote_addr or 'unknown'}:{bucket}"
    now = time.monotonic()
    with _rate_lock:
        recent = [stamp for stamp in _rate_buckets[client] if now - stamp < _RATE_WINDOW_SECONDS]
        if len(recent) >= limit:
            _rate_buckets[client] = recent
            return True
        recent.append(now)
        _rate_buckets[client] = recent
        if len(_rate_buckets) > 1000:
            for address in list(_rate_buckets)[:200]:
                if not any(now - stamp < _RATE_WINDOW_SECONDS for stamp in _rate_buckets[address]):
                    _rate_buckets.pop(address, None)
        return False


def groq_chat_params(max_tokens: int, model_override: str | None = None) -> dict:
    """Model name + token limit. gpt-oss models 'think' first, so keep that short for fast replies."""
    model = model_override or GROQ_MODEL or DEFAULT_GROQ_MODEL
    params: dict[str, Any] = {"model": model, "max_completion_tokens": max_tokens}
    if "gpt-oss" in model:
        params["reasoning_effort"] = "low"
    return params


def request_ai_reply(messages: list[dict[str, str]], extra_system: str = "", max_tokens: int = 1200) -> str:
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key or not has_provider_key():
        raise RuntimeError("not_configured")

    now_ist = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    clock_note = (
        f"Current date and time in India (IST): {now_ist:%A, %d %B %Y, %I:%M %p}. "
        "Use this whenever the user asks about the current time, date, day or year; never guess them. "
        "Your training knowledge is old (around 2024): for recent events say you are not sure instead of answering from memory."
    )
    system_text = _SYSTEM_PROMPT + "\n\n" + clock_note + (("\n\n" + extra_system) if extra_system else "")

    def call(params: dict) -> requests.Response:
        return requests.post(
            f"{GROQ_API_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                **params,
                "messages": [{"role": "system", "content": system_text}, *messages],
                "temperature": 0.5,
            },
            timeout=(8, 45),
        )

    params = groq_chat_params(max_tokens)
    response = call(params)

    # If the configured model is missing/retired, retry once with the default model.
    if response.status_code in (400, 404) and params["model"] != DEFAULT_GROQ_MODEL:
        app.logger.warning("Model %s rejected (HTTP %s); retrying with %s", params["model"], response.status_code, DEFAULT_GROQ_MODEL)
        response = call(groq_chat_params(max_tokens, DEFAULT_GROQ_MODEL))

    if response.status_code == 429:
        raise RuntimeError("busy")
    if not response.ok:
        app.logger.warning("AI provider returned HTTP %s: %s", response.status_code, response.text[:300])
        raise RuntimeError(f"upstream_{response.status_code}")

    payload = response.json()
    if payload.get("error"):
        app.logger.warning("AI provider returned an error object")
        raise RuntimeError("upstream")
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("empty")
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        content = "\n".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("empty")
    return content.strip()[:8000]


def request_transcription(audio_bytes: bytes, mime_type: str) -> str:
    """Transcribe one in-memory browser recording without persisting its audio bytes."""
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key or not has_provider_key():
        raise RuntimeError("not_configured")

    extension = {
        "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav",
        "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/mpeg": "mp3",
    }.get(mime_type, "webm")
    response = requests.post(
        f"{GROQ_API_BASE}/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        data={
            "model": GROQ_STT_MODEL or "whisper-large-v3-turbo",
            "language": "en",
            "response_format": "json",
            "prompt": "Transcribe the speaker in English. Names and terms may include Abhi AI, YouTube, Instagram, time, date, and phone numbers.",
        },
        files={"file": (f"recording.{extension}", audio_bytes, mime_type)},
        timeout=(8, 30),
    )
    if response.status_code == 429:
        raise RuntimeError("busy")
    if not response.ok:
        app.logger.warning("Speech transcription provider returned HTTP %s", response.status_code)
        raise RuntimeError("upstream")

    payload = response.json()
    transcript = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(transcript, str) or not transcript.strip():
        raise RuntimeError("no_speech")
    return transcript.strip()[:3000]


_sarvam_session = requests.Session()


def has_sarvam_key() -> bool:
    key = os.getenv("SARVAM_API_KEY", "").strip()
    return bool(key) and not key.lower().startswith(("replace_", "your_", "put_", "paste_"))


def request_sarvam_speech(text: str) -> bytes:
    """Generate WAV bytes from Sarvam without writing the provider response to disk."""
    if not has_sarvam_key():
        raise RuntimeError("not_configured")
    response = _sarvam_session.post(
        SARVAM_API_URL,
        headers={"api-subscription-key": os.getenv("SARVAM_API_KEY", "").strip(), "Content-Type": "application/json"},
        json={
            "text": text[:1200],
            "language_code": "hi-IN",
            "model": SARVAM_TTS_MODEL or "bulbul:v4-flash",
            "speaker": SARVAM_SPEAKER or "simran_hi_assistant",
            "speech_sample_rate": 22050,
        },
        timeout=(8, 45),
    )
    if response.status_code == 429:
        raise RuntimeError("busy")
    if not response.ok:
        app.logger.warning("Sarvam TTS returned HTTP %s", response.status_code)
        raise RuntimeError("upstream")
    payload = response.json()
    audios = payload.get("audios") if isinstance(payload, dict) else None
    if not isinstance(audios, list) or not audios or not isinstance(audios[0], str):
        raise RuntimeError("empty")
    try:
        return base64.b64decode(audios[0], validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise RuntimeError("empty") from error


_WEB_INTENT_RE = re.compile(
    r"\bgoogle\b|\b(?:live\s+)?score(?:card)?\b|\bipl\b|\bcricket\b|\bnews\b|\bkhabar\b|\bheadlines?\b|\bbreaking\b"
    r"|\bweather\b|\bmausam\b|\bprice\b|\bstock\b|\bwho\s+won\b|\bkaun\s+jeet\w*\b|\blatest\b|\btrending\b|\bresult\b"
    r"|\bcurrent(?:ly)?\b|\brecent(?:ly)?\b|\bright\s+now\b|\bthis\s+(?:week|month|year)\b|\b2025\b|\b2026\b"
    r"|\bkya\s+chal\s+raha\b|\baaj\s+(?:ki|ka|ke)\b|\bupdates?\b|\brelease\s+date\b|\blaunch(?:ed|es)?\b"
    r"|\bwho\s+is\s+(?:the\s+)?(?:current|new)\b|\b(?:ceo|president|prime\s+minister|chief\s+minister)\s+of\b"
    r"|\bmatch\s+(?:score|result|kab|kaun|ka)\b|\b(?:aaj|kal)\s+ka\s+match\b"
    r"|गूगल|स्कोर|खबर|मौसम|न्यूज़|न्यूज|रिजल्ट|भाव|क्रिकेट|समाचार",
    re.I,
)
_NEWS_RE = re.compile(r"\bnews\b|\bkhabar\b|\bheadlines?\b|\bbreaking\b|न्यूज़|न्यूज|खबर|समाचार", re.I)
_FRESH_RE = re.compile(
    r"\blatest\b|\bcurrent(?:ly)?\b|\brecent(?:ly)?\b|\btoday\b|\baaj\b|\bnow\b|\btrending\b|\bnew\b|\bupdates?\b|\blaunch\w*\b|\brelease\b",
    re.I,
)
# Only strip "google" when it is an instruction ("google pe", "google karo"), NOT when it is the topic
# ("latest news on Google"). The old pattern removed the word and searched for nothing useful.
_SEARCH_NOISE_RE = re.compile(
    r"\bgoogle\s*(?:pe|par|per|se|mein|me)\b|\bgoogle\s+(?:karo|kar|kr)\b|\bsearch\s*(?:karo|kar|kr)\b"
    r"|\bdekh\s*ke\s*bata(?:o|na)?\b|\bdekhke\s*batao\b|गूगल\s*(?:पर|पे|से|करो)",
    re.I,
)
_FILLER_RE = re.compile(r"\b(?:tell\s+me|some|please|batao|bata\s*do|bataiye|mujhe)\b", re.I)


def looks_like_web_question(text: str) -> bool:
    return bool(_WEB_INTENT_RE.search(text))


def looks_like_news_question(text: str) -> bool:
    return bool(_NEWS_RE.search(text))


def search_query_from(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", _FILLER_RE.sub(" ", _SEARCH_NOISE_RE.sub(" ", text))).strip()
    query = (cleaned or text).strip()
    # A bare "aaj ka score" is too vague for Google: default to live cricket (India).
    if re.search(r"\bscore(?:card)?\b|स्कोर", query, re.I) and not re.search(
        r"\b(?:cricket|ipl|football|fifa|epl|nba|tennis|hockey|kabaddi|t20|odi|test|vs|v)\b|क्रिकेट", query, re.I
    ) and len(query.split()) <= 5:
        query = "live cricket score today"
    return query[:200]


def _ist_now() -> datetime:
    return datetime.now(timezone(timedelta(hours=5, minutes=30)))


def fresh_query(query: str, news: bool) -> str:
    """Add the current month/year so search engines return this month's pages, not 2024 ones."""
    if re.search(r"\b(?:19|20)\d{2}\b", query):
        return query
    if news or _FRESH_RE.search(query):
        return f"{query} {_ist_now():%B %Y}"
    return query


def _is_recent(date_text: str, days: int) -> bool:
    """True if the date is within `days` (or cannot be parsed, e.g. '3 hours ago')."""
    try:
        parsed = datetime.fromisoformat(str(date_text).replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed) <= timedelta(days=days)


def _search_serper(query: str, key: str, news: bool = False, fresh: bool = False) -> str:
    def call(use_filter: bool) -> dict:
        body: dict[str, Any] = {"q": query, "gl": "in", "hl": "en", "num": 8}
        if use_filter and news:
            body["tbs"] = "qdr:w"   # past week
        elif use_filter and fresh:
            body["tbs"] = "qdr:m"   # past month
        response = requests.post(
            "https://google.serper.dev/news" if news else "https://google.serper.dev/search",
            headers={"X-API-KEY": key, "Content-Type": "application/json"},
            json=body,
            timeout=(8, 20),
        )
        if response.status_code == 429:
            raise RuntimeError("busy")
        if not response.ok:
            app.logger.warning("Serper returned HTTP %s: %s", response.status_code, response.text[:200])
            raise RuntimeError(f"serper_{response.status_code}")
        return response.json()

    data = call(True)
    if not (data.get("news") or data.get("organic") or data.get("answerBox") or data.get("sportsResults")):
        data = call(False)  # the date filter was too strict; retry without it
    parts: list[str] = []
    for key_name in ("answerBox", "sportsResults", "knowledgeGraph"):
        if data.get(key_name):
            parts.append(f"{key_name}: {json.dumps(data[key_name], ensure_ascii=False)[:1200]}")
    for item in (data.get("news") or [])[:7]:
        parts.append(f"- NEWS {item.get('title', '')}: {item.get('snippet', '')} [{item.get('source', '')}, {item.get('date', '')}]")
    for item in (data.get("organic") or [])[:5]:
        parts.append(f"- {item.get('title', '')}: {item.get('snippet', '')} [{item.get('date', '')}] ({item.get('link', '')})")
    for item in (data.get("topStories") or [])[:3]:
        parts.append(f"- NEWS {item.get('title', '')} [{item.get('source', '')} {item.get('date', '')}]")
    return "\n".join(parts)[:4500]


def _search_tavily(query: str, key: str, news: bool = False, fresh: bool = False) -> str:
    def call(use_filter: bool) -> dict:
        body: dict[str, Any] = {"query": query, "max_results": 6, "include_answer": True, "search_depth": "basic"}
        if use_filter and news:
            body.update({"topic": "news", "days": 7})
        elif use_filter and fresh:
            body["time_range"] = "month"
        response = requests.post(
            "https://api.tavily.com/search",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body,
            timeout=(8, 25),
        )
        if response.status_code == 429:
            raise RuntimeError("busy")
        if not response.ok:
            app.logger.warning("Tavily returned HTTP %s: %s", response.status_code, response.text[:200])
            raise RuntimeError(f"tavily_{response.status_code}")
        return response.json()

    data = call(True)
    if not data.get("results"):
        data = call(False)
    parts = [f"answer: {data['answer']}"] if data.get("answer") else []
    for item in (data.get("results") or [])[:6]:
        date = item.get("published_date") or ""
        parts.append(f"- {item.get('title', '')}: {str(item.get('content', ''))[:500]} [{date}] ({item.get('url', '')})")
    return "\n".join(parts)[:4500]


def _search_duckduckgo(query: str, news: bool = False, fresh: bool = False) -> str:
    try:  # Free fallback, no key needed: pip install ddgs
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
    except ImportError as error:
        raise RuntimeError("search_not_configured") from error
    parts: list[str] = []
    try:
        with DDGS() as ddgs:
            news_items = list(ddgs.news(query, region="in-en", timelimit="w" if news else "m", max_results=8) or [])
            if news and not news_items:
                news_items = list(ddgs.news(query, region="in-en", timelimit="m", max_results=8) or [])
            for item in news_items:
                if not _is_recent(item.get("date", ""), 45):
                    continue  # drop old (e.g. 2024) stories
                parts.append(f"- NEWS {item.get('title', '')}: {item.get('body', '')} [{item.get('date', '')}] ({item.get('url', '')})")
            if not news or not parts:
                text_limit = "m" if (news or fresh) else None
                for item in list(ddgs.text(query, region="in-en", timelimit=text_limit, max_results=5) or []):
                    parts.append(f"- {item.get('title', '')}: {item.get('body', '')} ({item.get('href', '')})")
    except Exception as error:
        app.logger.warning("DuckDuckGo search failed: %s", error.__class__.__name__)
        raise RuntimeError("upstream") from error
    return "\n".join(parts)[:4500]


def web_search_context(query: str, news: bool = False) -> str:
    """Fetch FRESH web results. Tries Serper (Google), then Tavily, then DuckDuckGo.
    News questions use the news endpoints limited to the past week, and the current month/year
    is added to the query so old (2024) pages do not come back."""
    fresh = news or bool(_FRESH_RE.search(query))
    query = fresh_query(query, news)
    serper_key = os.getenv("SERPER_API_KEY", "").strip()
    tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
    providers: list[Any] = []
    if serper_key:
        providers.append(lambda: _search_serper(query, serper_key, news, fresh))
    if tavily_key:
        providers.append(lambda: _search_tavily(query, tavily_key, news, fresh))
    providers.append(lambda: _search_duckduckgo(query, news, fresh))

    last_error: Exception | None = None
    for provider in providers:
        try:
            result = provider()
            if result.strip():
                return result
        except (RuntimeError, requests.RequestException, ValueError) as error:
            app.logger.warning("Search provider failed: %s", error)
            last_error = error
    if last_error is not None:
        raise last_error if isinstance(last_error, RuntimeError) else RuntimeError("upstream")
    return ""


GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct").strip()


def extract_image_text_vision(image_bytes: bytes) -> str:
    """Read an image with a Groq vision model (no Tesseract install needed). Image is not stored."""
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key or not has_provider_key():
        raise RuntimeError("not_configured")
    mime = image_mimetype(image_bytes)
    data = image_bytes
    # Groq limits base64 images to ~4 MB, so shrink big photos to a JPEG first (needs Pillow).
    if Image is not None:
        try:
            with Image.open(io.BytesIO(image_bytes)) as source:
                picture = ImageOps.exif_transpose(source).convert("RGB")
                picture.thumbnail((1800, 1800))
                buffer = io.BytesIO()
                picture.save(buffer, format="JPEG", quality=85)
                data, mime = buffer.getvalue(), "image/jpeg"
        except Exception:
            data = image_bytes
    if len(data) > 3 * 1024 * 1024:
        raise RuntimeError("ocr_failed")
    encoded = base64.b64encode(data).decode("ascii")
    response = requests.post(
        f"{GROQ_API_BASE}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": GROQ_VISION_MODEL,
            "temperature": 0.1,
            "max_completion_tokens": 1500,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        "Read this image. First write ALL visible text exactly as it appears (Hindi, English or any language), "
                        "keeping the line order. Then, if the image has little or no text, or it is a photo/diagram, add a short "
                        "plain description of what it shows. Do not add anything else."
                    )},
                    {"type": "image_url", "image_url": {"url": f"data:{mime or 'image/jpeg'};base64,{encoded}"}},
                ],
            }],
        },
        timeout=(8, 60),
    )
    if not response.ok:
        app.logger.warning("Vision request returned HTTP %s: %s", response.status_code, response.text[:300])
        raise RuntimeError("ocr_failed")
    choices = response.json().get("choices") or []
    text = ((choices[0].get("message") or {}).get("content") if choices else "") or ""
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:12000]


def extract_image_text(image_bytes: bytes, language: str = "eng") -> str:
    """Try the Groq vision model first; fall back to local Tesseract OCR if it is unavailable."""
    try:
        text = extract_image_text_vision(image_bytes)
        if text:
            return text
    except Exception as error:
        app.logger.warning("Vision OCR failed, trying Tesseract: %s", error.__class__.__name__)
    return extract_image_text_tesseract(image_bytes, language)


def extract_image_text_tesseract(image_bytes: bytes, language: str = "eng") -> str:
    """Extract readable text locally with Tesseract; the original image is never persisted."""
    if pytesseract is None or Image is None:
        raise RuntimeError("ocr_not_installed")
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source).convert("L")
            # Upscaling and contrast help phone photos while keeping the pipeline local.
            if image.width < 1600:
                scale = min(2.0, 1600 / max(image.width, 1))
                image = image.resize((int(image.width * scale), int(image.height * scale)))
            image = ImageOps.autocontrast(image).filter(ImageFilter.SHARPEN)
            installed = set(pytesseract.get_languages(config=""))
            requested = [part for part in language.split("+") if part in installed]
            tesseract_language = "+".join(requested) or "eng"
            text = pytesseract.image_to_string(image, lang=tesseract_language, config="--psm 6")
    except Exception as error:
        app.logger.warning("OCR failed: %s", error.__class__.__name__)
        raise RuntimeError("ocr_failed") from error
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:12000]


_TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".html", ".css", ".log", ".xml", ".yml", ".yaml", ".sql", ".java", ".c", ".cpp"}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def extract_pdf_text(pdf_bytes: bytes, language: str) -> str:
    """Read a PDF: use its text layer, and run Tesseract on pages that are scanned images."""
    if fitz is None:
        raise RuntimeError("pdf_not_installed")
    parts: list[str] = []
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
            for index, page in enumerate(document):
                if index >= 12:
                    break
                page_text = page.get_text().strip()
                if len(page_text) < 40:
                    pixmap = page.get_pixmap(dpi=200)
                    try:
                        page_text = extract_image_text(pixmap.tobytes("png"), language)
                    except RuntimeError:
                        page_text = page_text
                if page_text:
                    parts.append(f"--- Page {index + 1} ---\n{page_text}")
    except RuntimeError:
        raise
    except Exception as error:
        app.logger.warning("PDF read failed: %s", error.__class__.__name__)
        raise RuntimeError("ocr_failed") from error
    return "\n\n".join(parts).strip()[:12000]


def extract_file_text(data: bytes, filename: str, language: str) -> str:
    extension = Path(filename or "").suffix.lower()
    if extension in _IMAGE_EXTENSIONS:
        return extract_image_text(data, language)
    if extension == ".pdf":
        return extract_pdf_text(data, language)
    if extension in _TEXT_EXTENSIONS:
        return data.decode("utf-8", errors="replace").strip()[:12000]
    raise RuntimeError("unsupported")


@app.get("/")
def home():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/static/<path:filename>")
def static_files(filename: str):
    # Flat project (no folders): only these two public files may be served.
    if filename not in ("app.js", "styles.css"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(BASE_DIR, filename)


@app.get("/manus-routes.json")
def route_manifest():
    return send_from_directory(BASE_DIR, "manus-routes.json", mimetype="application/json")


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.get("/api/diagnose")
def diagnose():
    """Open http://localhost:3000/api/diagnose to see exactly why the AI is not answering."""
    if is_rate_limited("diagnose", 10):
        return jsonify({"error": "Thoda ruk kar try karein."}), 429
    report: dict[str, Any] = {
        "groq_key_set": has_provider_key(),
        "groq_model": GROQ_MODEL,
        "groq_model_env_raw": os.getenv("GROQ_MODEL", "(not set)"),
        "running_on_render": bool(os.environ.get("RENDER")),
        "sarvam_key_set": has_sarvam_key(),
        "serper_key_set": bool(os.getenv("SERPER_API_KEY", "").strip()),
        "youtube_key_set": bool(os.getenv("YOUTUBE_API_KEY", "").strip()),
        "hf_token_set": bool(os.getenv("HF_TOKEN", "").strip()),
        "tesseract": pytesseract is not None,
        "pdf_reader": fitz is not None,
    }
    serper_key = os.getenv("SERPER_API_KEY", "").strip()
    if serper_key:
        try:
            test = requests.post(
                "https://google.serper.dev/search",
                headers={"X-API-KEY": serper_key, "Content-Type": "application/json"},
                json={"q": "india news", "num": 1},
                timeout=(8, 15),
            )
            report["serper_http_status"] = test.status_code
            if not test.ok:
                report["serper_error"] = test.text[:200]
        except requests.RequestException as error:
            report["serper_error"] = f"Serper tak pahunch nahi paaye ({error.__class__.__name__})."
    if not has_provider_key():
        report["problem"] = "GROQ_API_KEY .env mein nahi mila ya placeholder hai."
        return jsonify(report)
    headers = {"Authorization": f"Bearer {os.getenv('GROQ_API_KEY', '').strip()}"}
    try:
        models = requests.get(f"{GROQ_API_BASE}/models", headers=headers, timeout=(8, 15))
        report["models_http_status"] = models.status_code
        if models.ok:
            ids = sorted(item.get("id", "") for item in (models.json().get("data") or []))
            report["model_available"] = GROQ_MODEL in ids
            report["available_chat_models"] = [i for i in ids if not any(x in i for x in ("whisper", "guard", "orpheus", "tts"))][:15]
        else:
            report["models_error"] = models.text[:200]
        chat_test = requests.post(
            f"{GROQ_API_BASE}/chat/completions",
            headers={**headers, "Content-Type": "application/json"},
            json={**groq_chat_params(200), "messages": [{"role": "user", "content": "Say hi in one word."}]},
            timeout=(8, 30),
        )
        report["chat_http_status"] = chat_test.status_code
        if chat_test.ok:
            message = ((chat_test.json().get("choices") or [{}])[0]).get("message") or {}
            report["chat_reply"] = (message.get("content") or "")[:80]
        else:
            report["chat_error"] = chat_test.text[:300]
    except requests.RequestException as error:
        report["problem"] = f"Groq tak pahunch nahi paaye ({error.__class__.__name__}). Internet/firewall check karein."
    return jsonify(report)


@app.post("/api/transcribe")
def transcribe():
    if is_rate_limited():
        return jsonify({"error": "Please pause for a moment before trying again."}), 429
    if not has_provider_key():
        return jsonify({"error": "Voice transcription is not set up yet. Add your private key to the .env file and restart the website server."}), 503

    audio = request.files.get("audio")
    if audio is None or not audio.filename:
        return jsonify({"error": "No voice recording was received. Please try again."}), 400
    mime_type = (audio.mimetype or "").lower()
    allowed_types = {"audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/mpeg"}
    if mime_type not in allowed_types:
        return jsonify({"error": "This recording format is not supported. Please use a recent browser and try again."}), 415

    audio_bytes = audio.read(MAX_AUDIO_BYTES + 1)
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        return jsonify({"error": "That recording is too long. Please speak in shorter segments."}), 413
    if len(audio_bytes) < 512:
        return jsonify({"error": "I could not hear clear speech. Please move closer to the microphone and try again."}), 422

    try:
        transcript = request_transcription(audio_bytes, mime_type)
    except RuntimeError as error:
        if str(error) == "not_configured":
            return jsonify({"error": "Voice transcription is not set up yet. Add your private key to the .env file and restart the website server."}), 503
        if str(error) == "busy":
            return jsonify({"error": "Voice transcription is busy. Please try again shortly."}), 429
        if str(error) == "no_speech":
            return jsonify({"error": "I could not detect speech in that recording. Please try again."}), 422
        return jsonify({"error": "Voice transcription could not finish. Please try again."}), 502
    except requests.RequestException as error:
        app.logger.warning("Voice transcription request failed: %s", error.__class__.__name__)
        return jsonify({"error": "I could not reach the transcription service. Check your connection and try again."}), 502
    except ValueError:
        return jsonify({"error": "The transcription service returned an unreadable response."}), 502
    return jsonify({"text": transcript})


def image_mimetype(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def english_image_prompt(user_text: str) -> str:
    """Turn a Hindi/Hinglish request into a rich English image prompt. Returns 'REFUSED' for unsafe requests."""
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not has_provider_key():
        return user_text
    system = (
        "You write prompts for a text-to-image model. The user's request may be in Hindi, Hinglish or English. "
        "Reply with ONE English prompt only (max 60 words): subject, style, lighting, composition, mood. "
        "No quotes, no explanations. If the request is sexual, graphic violence, hateful, or the realistic likeness of a "
        "real private person, reply exactly: REFUSED"
    )
    try:
        response = requests.post(
            f"{GROQ_API_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={**groq_chat_params(500), "temperature": 0.7,
                  "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_text}]},
            timeout=(8, 20),
        )
        if response.ok:
            text = (((response.json().get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
            text = text.strip().strip('"')
            if text:
                return text[:600]
    except (requests.RequestException, ValueError):
        pass
    return user_text


def generate_image_bytes(prompt: str) -> bytes:
    """Hugging Face (FLUX) when HF_TOKEN is set; otherwise a free keyless fallback."""
    token = os.getenv("HF_TOKEN", "").strip()
    model = os.getenv("HF_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell").strip()
    attempts: list[str] = []
    if token:
        try:
            response = requests.post(
                f"https://router.huggingface.co/hf-inference/models/{model}",
                headers={"Authorization": f"Bearer {token}", "Accept": "image/png"},
                json={"inputs": prompt},
                timeout=(8, 90),
            )
            if response.ok and image_mimetype(response.content):
                return response.content
            attempts.append(f"hf-inference HTTP {response.status_code}")
        except requests.RequestException as error:
            attempts.append(f"hf-inference {error.__class__.__name__}")
        try:  # Same model through the Together provider (billed via the HF account)
            response = requests.post(
                "https://router.huggingface.co/together/v1/images/generations",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"model": model, "prompt": prompt, "response_format": "base64", "width": 1024, "height": 1024, "steps": 4},
                timeout=(8, 90),
            )
            if response.ok:
                item = ((response.json().get("data") or [{}])[0])
                encoded = item.get("b64_json") or item.get("base64")
                if encoded:
                    raw = base64.b64decode(encoded)
                    if image_mimetype(raw):
                        return raw
            attempts.append(f"together HTTP {response.status_code}")
        except (requests.RequestException, ValueError):
            attempts.append("together error")
    try:  # Keyless fallback (free, may be slower or rate limited)
        from urllib.parse import quote
        response = requests.get(
            f"https://image.pollinations.ai/prompt/{quote(prompt[:500])}",
            params={"width": 768, "height": 768, "nologo": "true"},
            timeout=(8, 90),
        )
        if response.ok and image_mimetype(response.content):
            return response.content
        attempts.append(f"fallback HTTP {response.status_code}")
    except requests.RequestException as error:
        attempts.append(f"fallback {error.__class__.__name__}")
    app.logger.warning("Image generation failed: %s", "; ".join(attempts))
    raise RuntimeError("image_failed")


@app.post("/api/image")
def make_image():
    if is_rate_limited("image", 8):
        return jsonify({"error": "Thodi der ruk kar image banayein."}), 429
    data = request.get_json(silent=True) or {}
    text = data.get("prompt")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "Kaisi image banani hai, ye bataiye."}), 400
    prompt = english_image_prompt(text.strip()[:500])
    if prompt.strip().upper().startswith("REFUSED"):
        return jsonify({"error": "Main is tarah ki image nahi bana sakta. Koi aur idea bataiye."}), 422
    try:
        image = generate_image_bytes(prompt)
    except RuntimeError:
        return jsonify({"error": "Image abhi nahi ban paayi. .env mein HF_TOKEN daalein ya thodi der baad try karein."}), 502
    response = app.response_class(image, mimetype=image_mimetype(image) or "image/png")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/youtube")
def youtube_lookup():
    """Find the first embeddable YouTube video for a song/query so the page can play it."""
    if is_rate_limited():
        return jsonify({"error": "Thoda ruk kar try karein."}), 429
    query = (request.args.get("q") or "").strip()[:150]
    if not query:
        return jsonify({"error": "Kaun sa gaana?"}), 400
    key = os.getenv("YOUTUBE_API_KEY", "").strip()
    if not key:
        return jsonify({"error": "YOUTUBE_API_KEY .env mein nahi hai."}), 503
    try:
        response = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={"part": "snippet", "type": "video", "maxResults": 1, "videoEmbeddable": "true",
                    "videoSyndicated": "true", "q": query, "key": key},
            timeout=(8, 15),
        )
    except requests.RequestException:
        return jsonify({"error": "YouTube tak pahunch nahi paaye."}), 502
    if not response.ok:
        app.logger.warning("YouTube search returned HTTP %s", response.status_code)
        return jsonify({"error": "YouTube search fail hui. API key check karein."}), 502
    items = (response.json() or {}).get("items") or []
    video_id = ((items[0].get("id") or {}).get("videoId") if items else "") or ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return jsonify({"error": "Koi video nahi mila."}), 404
    title = ((items[0].get("snippet") or {}).get("title") or query)[:150]
    return jsonify({"videoId": video_id, "title": title})


@app.post("/api/speak")
def speak():
    if is_rate_limited("speak", 90):
        return jsonify({"error": "Please pause for a moment before trying again."}), 429
    data = request.get_json(silent=True) or {}
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": " बोलने के लिए text नहीं मिला।"}), 400
    if not has_sarvam_key():
        return jsonify({"error": "Sarvam voice चालू करने के लिए .env में SARVAM_API_KEY डालें और server restart करें।"}), 503
    try:
        audio = request_sarvam_speech(text.strip())
    except RuntimeError as error:
        if str(error) == "busy":
            return jsonify({"error": "Sarvam voice अभी busy है। थोड़ी देर बाद फिर try करें।"}), 429
        return jsonify({"error": "Sarvam voice audio अभी नहीं बन पाई। API key और speaker settings जाँचें।"}), 502
    except (requests.RequestException, ValueError):
        return jsonify({"error": "Sarvam voice service तक पहुँचा नहीं जा सका।"}), 502
    response = app.response_class(audio, mimetype="audio/wav")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/ocr")
def ocr_image():
    """Read an uploaded image/PDF/text file with Tesseract and explain it intelligently."""
    if is_rate_limited():
        return jsonify({"error": "Please pause for a moment before trying again."}), 429
    upload = request.files.get("file") or request.files.get("image")
    if upload is None or not upload.filename:
        return jsonify({"error": "कोई file नहीं मिली। पहले file चुनें।"}), 400
    filename = Path(upload.filename).name[:120]
    data = upload.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        return jsonify({"error": "File बहुत बड़ी है। 8 MB से छोटी file use करें।"}), 413
    if len(data) < 16:
        return jsonify({"error": "File खाली या खराब लग रही है।"}), 422
    language = (request.form.get("language") or "eng+hin").lower()
    if not re.fullmatch(r"[a-z_+]{2,24}", language):
        language = "eng+hin"
    question = (request.form.get("question") or "").strip()[:1000]
    conversation_id = valid_conversation_id(request.form.get("conversation_id", ""))

    try:
        extracted = extract_file_text(data, filename, language)
    except RuntimeError as error:
        code = str(error)
        if code == "ocr_not_installed":
            return jsonify({"error": "OCR अभी उपलब्ध नहीं है। Tesseract और pytesseract install करके server restart करें."}), 503
        if code == "pdf_not_installed":
            return jsonify({"error": "PDF पढ़ने के लिए `pip install pymupdf` करके server restart करें."}), 503
        if code == "unsupported":
            return jsonify({"error": "यह file type supported नहीं है। Image (PNG/JPG/WEBP), PDF या text file भेजें."}), 415
        return jsonify({"error": "File पढ़ी नहीं जा सकी। साफ और सीधी file दोबारा try करें."}), 422

    if not extracted:
        return jsonify({"text": "", "reply": "इस file में readable text नहीं मिला। साफ़ और सीधी photo/scan भेजकर देखें।"})

    if conversation_id:
        with connect_db() as connection:
            save_document(connection, conversation_id, filename, extracted)
            save_message(connection, conversation_id, "user", f"📎 {filename}" + (f" — {question}" if question else ""))

    if not has_provider_key():
        return jsonify({"text": extracted, "reply": "File का text मिल गया है। Smart answer के लिए GROQ_API_KEY configure करें।"})

    prompt = (
        f"The user uploaded a file named \"{filename}\". Its text was extracted locally with OCR/text reading and is below.\n\n"
        + (f"USER'S QUESTION: {question}\n\nAnswer exactly that question using the file.\n\n" if question else
           "The user gave no question. Do this: (1) say in one line what kind of document this is, (2) give a clear summary of the key points, "
           "(3) pull out important details such as names, dates, amounts, deadlines or action items, (4) if it is a question paper, assignment, "
           "code, or problem, solve or explain it step by step. Then invite follow-up questions.\n\n")
        + "Rules: OCR can contain mistakes. Silently fix obvious OCR errors, but if a part is unreadable or ambiguous say so instead of inventing it. "
        "Do not repeat the whole text back.\n\n"
        f"FILE TEXT:\n{extracted}"
    )
    try:
        smart_reply = request_ai_reply([{"role": "user", "content": prompt}], max_tokens=2000)
    except (RuntimeError, requests.RequestException, ValueError) as error:
        app.logger.warning("File explanation failed: %s", error.__class__.__name__)
        return jsonify({"text": extracted, "reply": "File का text मिल गया है, लेकिन AI explanation अभी नहीं बन पाई। थोड़ी देर बाद फिर try करें।"})

    if conversation_id:
        with connect_db() as connection:
            save_message(connection, conversation_id, "assistant", smart_reply)
    return jsonify({"text": extracted, "reply": smart_reply})


@app.get("/api/history")
def history():
    conversation_id = valid_conversation_id(request.args.get("conversation_id", ""))
    if not conversation_id:
        return jsonify({"error": "Invalid conversation."}), 400
    with connect_db() as connection:
        rows = connection.execute(
            "SELECT role, content, created_at FROM messages "
            "WHERE conversation_id = ? ORDER BY id DESC LIMIT 50",
            (conversation_id,),
        ).fetchall()
    return jsonify({"messages": [dict(row) for row in reversed(rows)]})


@app.post("/api/clear")
def clear_conversation():
    data = request.get_json(silent=True) or {}
    conversation_id = valid_conversation_id(data.get("conversation_id"))
    if not conversation_id:
        return jsonify({"error": "Invalid conversation."}), 400
    with connect_db() as connection:
        connection.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        connection.execute("DELETE FROM documents WHERE conversation_id = ?", (conversation_id,))
    return jsonify({"ok": True})


@app.post("/api/chat")
def chat():
    if is_rate_limited():
        return jsonify({"error": "A little pause, please. Try again in a moment."}), 429

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Please send a text message."}), 400
    message = data.get("message")
    conversation_id = valid_conversation_id(data.get("conversation_id"))
    if not isinstance(message, str) or not message.strip():
        return jsonify({"error": "Please type or say a message first."}), 400
    message = message.strip()
    if len(message) > 3000:
        return jsonify({"error": "That message is too long. Please keep it under 3,000 characters."}), 400
    if not conversation_id:
        return jsonify({"error": "Please refresh the page and try again."}), 400

    if looks_like_creator_question(message):
        with connect_db() as connection:
            save_message(connection, conversation_id, "user", message)
            creator_reply = creator_reply_for(message)
            save_message(connection, conversation_id, "assistant", creator_reply)
        return jsonify({"reply": creator_reply, "conversation_id": conversation_id})

    if not has_provider_key():
        return jsonify({
            "error": "AI replies are not set up yet. Add your private API key to the .env file and restart the website server."
        }), 503

    with connect_db() as connection:
        save_message(connection, conversation_id, "user", message)
        rows = connection.execute(
            "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 12",
            (conversation_id,),
        ).fetchall()
    messages = [dict(row) for row in reversed(rows)]
    with connect_db() as connection:
        document = load_document(connection, conversation_id)
    document_context = ""
    if document:
        document_context = (
            f"The user earlier uploaded the file \"{document[0]}\". Its extracted text is below. "
            "Use it when the user's question refers to the file/document/image/PDF; otherwise ignore it. "
            "OCR may contain small mistakes.\n\nFILE TEXT:\n" + document[1][:9000]
        )

    web_context = ""
    if looks_like_web_question(message):
        search_failure = ""
        try:
            web_context = web_search_context(search_query_from(message), news=looks_like_news_question(message))
            if not web_context.strip():
                search_failure = "Google search mein is baare mein kuch nahi mila. Thoda alag tareeke se pooch kar dekhein."
        except RuntimeError as error:
            code = str(error)
            if code == "search_not_configured":
                search_failure = ("Live Google search abhi chalu nahi hai. .env mein SERPER_API_KEY daalein "
                                  "(ya free option ke liye `pip install ddgs`) aur server restart karein. "
                                  "Tab tak main score/news andaaze se nahi bataunga.")
            elif code == "busy":
                search_failure = "Search service abhi busy hai. Thodi der baad try karein."
            else:
                search_failure = "Live search abhi nahi ho paayi. Thodi der baad try karein."
        except (requests.RequestException, ValueError):
            search_failure = "Search service tak pahunch nahi paaya. Connection check karein."
        if search_failure:
            with connect_db() as connection:
                save_message(connection, conversation_id, "assistant", search_failure)
            return jsonify({"reply": search_failure, "conversation_id": conversation_id})
        now_ist = datetime.now(timezone.utc).astimezone(timezone(__import__("datetime").timedelta(hours=5, minutes=30)))
        document_context = (document_context + "\n\n" if document_context else "") + (
            f"LIVE WEB SEARCH RESULTS (fetched just now from Google, current date/time {now_ist:%A %d %B %Y, %I:%M %p} IST):\n"
            f"{web_context}\n\n"
            f"Today's date is {now_ist:%d %B %Y}. Your own training knowledge is old (it stops around 2024), so for anything current "
            "(news, who holds a post, prices, products, scores) trust ONLY these results and never present 2024 events as the latest. "
            "Mention the date of each news item when it is given. If every result is old, say you could not find fresh news. "
            "Answer the user's question using ONLY these results. Put the actual answer (for example the score, "
            "who is winning, the price, the weather) in the first sentence, then add one or two useful details. "
            "If the results do not contain the answer or look outdated, say so honestly instead of guessing, and "
            "never invent scores or numbers. Mention the source site briefly. Do not paste raw JSON or long URLs."
        )

    try:
        reply = request_ai_reply(messages, extra_system=document_context, max_tokens=1500)
    except RuntimeError as error:
        if str(error) == "not_configured":
            return jsonify({"error": "AI replies are not set up yet. Add your private API key to the .env file and restart the website server."}), 503
        if str(error) == "busy":
            return jsonify({"error": "The AI is busy right now. Please try again in a little while."}), 429
        if str(error) == "empty":
            return jsonify({"error": "I didn't receive a complete answer. Please try once more."}), 502
        status = str(error).removeprefix("upstream_")
        if status in {"401", "403"}:
            return jsonify({"error": "Groq API key galat ya band hai. console.groq.com par naya key banakar .env mein GROQ_API_KEY badlein aur server restart karein."}), 502
        if status in {"400", "404"}:
            return jsonify({"error": f"Groq ne request nahi maani (HTTP {status}). Model ({GROQ_MODEL}) aur default model dono reject hue. /api/diagnose kholkar available_chat_models list dekhein aur uska koi ID GROQ_MODEL mein daalein."}), 502
        if status.startswith("5"):
            return jsonify({"error": "Groq abhi down ya busy hai. Thodi der baad try karein."}), 502
        return jsonify({"error": "The AI service could not answer just now. /api/diagnose kholkar dekhein ki kya problem hai."}), 502
    except requests.RequestException as error:
        app.logger.warning("AI request failed: %s", error.__class__.__name__)
        return jsonify({"error": "I couldn't reach the AI service. Check your connection and try again."}), 502
    except ValueError:
        return jsonify({"error": "The AI service returned an unreadable response. Please try again."}), 502

    with connect_db() as connection:
        save_message(connection, conversation_id, "assistant", reply)
    return jsonify({"reply": reply, "conversation_id": conversation_id})


@app.errorhandler(413)
def too_large(_error):
    return jsonify({"error": "The request is too large."}), 413


@app.errorhandler(500)
def internal_error(_error):
    app.logger.exception("Unexpected application error")
    return jsonify({"error": "Something went wrong. Please try again."}), 500


init_db()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "3000"))
    app.run(host="0.0.0.0", port=port, debug=False)