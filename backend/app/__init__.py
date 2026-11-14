from flask import Flask, request
from flask_cors import CORS
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy
from werkzeug.middleware.proxy_fix import ProxyFix

db = SQLAlchemy()
migrate = Migrate()


def create_app(config=None):
    app = Flask(__name__)
    if config is None:
        from config import Config, validate_config
        app.config.from_object(Config)
        validate_config(app.config)
    else:
        app.config.from_object(config)
    if app.config.get("TRUST_PROXY"):
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)
    migrate.init_app(app, db)
    CORS(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
         allow_headers=["Content-Type", "Authorization"], methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
         max_age=600, supports_credentials=False)

    from . import models  # noqa: F401
    from .errors import register_error_handlers
    from .routes import bp
    register_error_handlers(app)
    app.register_blueprint(bp)

    @app.after_request
    def secure(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"   # private health data must never be cached
        return resp

    return app
