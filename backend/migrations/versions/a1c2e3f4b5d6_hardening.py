"""hardening: token_version, activity client_id (idempotent saves), spo2 range check

Revision ID: a1c2e3f4b5d6
Revises: 54d519dd3cdb
"""
from alembic import op
import sqlalchemy as sa

revision = "a1c2e3f4b5d6"
down_revision = "54d519dd3cdb"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("token_version", sa.Integer(), server_default="0", nullable=False))
    with op.batch_alter_table("activity_records") as b:
        b.add_column(sa.Column("client_id", sa.String(length=36), nullable=True))
        b.create_unique_constraint("uq_activity_user_client", ["user_id", "client_id"])
    with op.batch_alter_table("health_records") as b:
        b.create_check_constraint("ck_spo2_range", "spo2 IS NULL OR spo2 BETWEEN 50 AND 100")


def downgrade():
    with op.batch_alter_table("health_records") as b:
        b.drop_constraint("ck_spo2_range", type_="check")
    with op.batch_alter_table("activity_records") as b:
        b.drop_constraint("uq_activity_user_client", type_="unique")
        b.drop_column("client_id")
    with op.batch_alter_table("users") as b:
        b.drop_column("token_version")
