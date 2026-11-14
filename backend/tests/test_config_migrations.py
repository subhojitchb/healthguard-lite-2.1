import os

import pytest
from flask_migrate import upgrade, check

from app import create_app, db
from config import normalize_db_url, validate_config

GOOD = {"SECRET_KEY": "k" * 32, "SQLALCHEMY_DATABASE_URI": "postgresql://u:p@h/db", "CORS_ORIGINS": ["https://app.vercel.app"]}


def test_valid_config_passes():
    validate_config(GOOD)
    validate_config({**GOOD, "CORS_ORIGINS": ["http://localhost:3000", "https://app.vercel.app"]})


@pytest.mark.parametrize("override", [
    {"SECRET_KEY": "short"}, {"SECRET_KEY": ""}, {"SQLALCHEMY_DATABASE_URI": ""}, {"CORS_ORIGINS": []},
    {"CORS_ORIGINS": ["*"]}, {"CORS_ORIGINS": ["https://*.vercel.app"]}, {"CORS_ORIGINS": ["http://example.com"]},
    {"CORS_ORIGINS": ["https://app.vercel.app/path"]},
])
def test_invalid_config_fails_fast(override):
    with pytest.raises(RuntimeError):
        validate_config({**GOOD, **override})


def test_normalize_db_url():
    assert normalize_db_url("postgres://u:p@ep-x.neon.tech/db").startswith("postgresql://")
    assert "sslmode=require" in normalize_db_url("postgresql://u:p@ep-x.neon.tech/db")
    assert normalize_db_url("postgresql://u:p@ep-x.neon.tech/db?sslmode=verify-full").count("sslmode") == 1
    assert "sslmode" not in normalize_db_url("postgresql://u:p@localhost/db")
    assert normalize_db_url("sqlite://") == "sqlite://"


def test_migrations_match_models(tmp_path):
    """Upgrading an empty database through the migrations must produce exactly the schema the models declare."""
    class Cfg:
        TESTING = True
        SECRET_KEY = "t" * 40
        SQLALCHEMY_DATABASE_URI = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path}/m.db"
        SQLALCHEMY_TRACK_MODIFICATIONS = False
        CORS_ORIGINS = ["http://localhost:3000"]
    app = create_app(Cfg)
    with app.app_context():
        db.drop_all()
        db.session.execute(db.text("DROP TABLE IF EXISTS alembic_version"))
        db.session.commit()
        upgrade(directory=os.path.join(os.path.dirname(__file__), "..", "migrations"))
        check(directory=os.path.join(os.path.dirname(__file__), "..", "migrations"))  # raises if models and migrations differ
