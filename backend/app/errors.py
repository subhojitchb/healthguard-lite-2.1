from flask import jsonify
from sqlalchemy.exc import OperationalError
from werkzeug.exceptions import HTTPException


class ApiError(Exception):
    def __init__(self, message, status=400, headers=None):
        super().__init__(message)
        self.message, self.status, self.headers = message, status, headers or {}


def register_error_handlers(app):
    from . import db

    @app.errorhandler(ApiError)
    def api_error(e):
        return jsonify(ok=False, error=e.message), e.status, e.headers

    @app.errorhandler(HTTPException)
    def http_error(e):
        return jsonify(ok=False, error=e.description if e.code < 500 else "Server error"), e.code

    @app.errorhandler(OperationalError)
    def db_down(e):
        db.session.rollback()
        app.logger.error("Database unavailable: %s", e)
        return jsonify(ok=False, error="Database temporarily unavailable. Please retry."), 503

    @app.errorhandler(Exception)
    def unexpected(e):
        db.session.rollback()
        app.logger.exception(e)
        return jsonify(ok=False, error="Internal server error"), 500
