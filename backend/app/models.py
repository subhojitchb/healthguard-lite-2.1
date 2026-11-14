from datetime import datetime, timezone
from . import db

def now(): return datetime.now(timezone.utc)

class Timestamps:
    created_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)

class User(db.Model, Timestamps):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=now, onupdate=now, nullable=False)
    # Bumped on logout: invalidates every JWT issued before (server-side revocation for stateless tokens).
    token_version = db.Column(db.Integer, nullable=False, default=0, server_default="0")
    profile = db.relationship("UserProfile", uselist=False, backref="user", cascade="all, delete-orphan")

class UserProfile(db.Model, Timestamps):
    __tablename__ = "user_profiles"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    phone_number = db.Column(db.String(20))
    date_of_birth = db.Column(db.Date)
    profile_picture_url = db.Column(db.String(500))
    updated_at = db.Column(db.DateTime(timezone=True), default=now, onupdate=now, nullable=False)

class HealthRecord(db.Model):
    __tablename__ = "health_records"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    heart_rate = db.Column(db.Integer)
    spo2 = db.Column(db.Integer)
    measurement_type = db.Column(db.String(30), nullable=False, default="camera_ppg")
    signal_quality = db.Column(db.Float)
    recorded_at = db.Column(db.DateTime(timezone=True), default=now, nullable=False)
    __table_args__ = (db.Index("ix_health_user_time", "user_id", "recorded_at"),
                      db.CheckConstraint("heart_rate IS NULL OR heart_rate BETWEEN 30 AND 220", name="ck_hr_range"),
                      db.CheckConstraint("spo2 IS NULL OR spo2 BETWEEN 50 AND 100", name="ck_spo2_range"))

class ActivityRecord(db.Model, Timestamps):
    __tablename__ = "activity_records"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    steps = db.Column(db.Integer, nullable=False)
    duration_seconds = db.Column(db.Integer, nullable=False, default=0)
    started_at = db.Column(db.DateTime(timezone=True), nullable=False)
    ended_at = db.Column(db.DateTime(timezone=True), nullable=False)
    client_id = db.Column(db.String(36))  # client-generated UUID: makes retried saves idempotent
    __table_args__ = (db.Index("ix_activity_user_time", "user_id", "started_at"),
                      db.UniqueConstraint("user_id", "client_id", name="uq_activity_user_client"),
                      db.CheckConstraint("steps >= 0", name="ck_steps_nonneg"))

class EmergencyContact(db.Model, Timestamps):
    __tablename__ = "emergency_contacts"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    contact_name = db.Column(db.String(100), nullable=False)
    phone_number = db.Column(db.String(20), nullable=False)
    relationship = db.Column(db.String(50))
    __table_args__ = (db.UniqueConstraint("user_id", "phone_number", name="uq_contact_user_phone"),)

class EmergencyEvent(db.Model, Timestamps):
    __tablename__ = "emergency_events"
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    latitude = db.Column(db.Float)
    longitude = db.Column(db.Float)
    event_status = db.Column(db.String(30), nullable=False, default="activated")
    __table_args__ = (db.Index("ix_event_user_time", "user_id", "created_at"),)
