"""email auth: users.email_verified (existing users stay verified) + email_otps

Revision ID: b2d4f6a8c0e1
Revises: a1c2e3f4b5d6
"""
from alembic import op
import sqlalchemy as sa

revision = "b2d4f6a8c0e1"
down_revision = "a1c2e3f4b5d6"
branch_labels = None
depends_on = None


def upgrade():
    # server_default TRUE marks every pre-existing account as verified so nobody loses access;
    # the default is then dropped so new accounts must be verified explicitly.
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.true()))
    with op.batch_alter_table("users") as b:
        b.alter_column("email_verified", server_default=None)
    op.create_table(
        "email_otps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("purpose", sa.String(length=10), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "purpose", name="uq_email_otp_user_purpose"),
    )


def downgrade():
    op.drop_table("email_otps")
    with op.batch_alter_table("users") as b:
        b.drop_column("email_verified")
