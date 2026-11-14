"""Configuration. All secrets come from the environment; nothing is hardcoded."""
import os
import re
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode
from dotenv import load_dotenv

load_dotenv()

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


def normalize_db_url(url: str) -> str:
    """Accept postgres:// (Render/Heroku style) and make Neon connections use TLS."""
    url = (url or "").strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        p = urlparse(url)
        q = dict(parse_qsl(p.query))
        if (p.hostname or "") not in LOCAL_HOSTS and "sslmode" not in q:
            q["sslmode"] = "require"
            url = urlunparse(p._replace(query=urlencode(q)))
    return url


def _engine_options(url: str) -> dict:
    opts = {"pool_pre_ping": True}
    if url.startswith("postgresql"):
        # Neon suspends idle compute and closes idle connections: recycle early, keep pool small.
        opts.update(pool_recycle=240, pool_size=5, max_overflow=5,
                    connect_args={"connect_timeout": 15, "keepalives": 1, "keepalives_idle": 30,
                                  "keepalives_interval": 10, "keepalives_count": 5})
    return opts


_DB = normalize_db_url(os.environ.get("DATABASE_URL", ""))


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "")
    SQLALCHEMY_DATABASE_URI = _DB
    SQLALCHEMY_ENGINE_OPTIONS = _engine_options(_DB)
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    JWT_EXPIRY_HOURS = min(int(os.environ.get("JWT_EXPIRY_HOURS", "24")), 168)
    CORS_ORIGINS = [o.strip().rstrip("/") for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    TRUST_PROXY = os.environ.get("TRUST_PROXY", "0") == "1"   # set to 1 on Render (X-Forwarded-For)
    LOGIN_MAX_FAILURES = int(os.environ.get("LOGIN_MAX_FAILURES", "5"))
    LOGIN_WINDOW_SECONDS = int(os.environ.get("LOGIN_WINDOW_SECONDS", "900"))
    MAX_CONTENT_LENGTH = 64 * 1024
    RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")   # email features answer 503 until both are set
    EMAIL_FROM = os.environ.get("EMAIL_FROM", "")           # e.g. HealthGuard Lite <no-reply@yourdomain.com>


def validate_config(cfg) -> None:
    """Fail fast at startup instead of misbehaving silently in production."""
    errs = []
    if len(cfg.get("SECRET_KEY", "")) < 32:
        errs.append("SECRET_KEY must be set and at least 32 characters.")
    if not cfg.get("SQLALCHEMY_DATABASE_URI"):
        errs.append("DATABASE_URL is not set.")
    origins = cfg.get("CORS_ORIGINS") or []
    if not origins:
        errs.append("CORS_ORIGINS is empty: the browser frontend would be blocked. Set it to your Vercel URL(s).")
    for o in origins:
        if "*" in o or not re.match(r"^https?://[^/\s]+$", o):
            errs.append(f"Invalid CORS origin {o!r} (no wildcards, no paths).")
        elif o.startswith("http://") and urlparse(o).hostname not in LOCAL_HOSTS:
            errs.append(f"Non-local CORS origin {o!r} must use https.")
    if errs:
        raise RuntimeError("Invalid configuration:\n- " + "\n- ".join(errs))
