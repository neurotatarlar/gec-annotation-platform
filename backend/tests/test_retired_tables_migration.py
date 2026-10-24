"""Verify retired table cleanup leaves annotation data intact."""

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def load_migration():
    path = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/20261024_01_drop_annotation_repair_tables.py"
    )
    spec = importlib.util.spec_from_file_location("retired_tables_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("include_applications", [False, True])
def test_cleanup_preserves_annotations_and_tolerates_missing_tables(include_applications):
    engine = sa.create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
        connection.exec_driver_sql("CREATE TABLE annotations (id INTEGER PRIMARY KEY, body TEXT)")
        connection.exec_driver_sql("INSERT INTO annotations VALUES (1, 'saved annotation')")
        connection.exec_driver_sql(
            "CREATE TABLE annotation_repair_batches (id INTEGER PRIMARY KEY)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE annotation_repair_items "
            "(id INTEGER PRIMARY KEY, batch_id INTEGER REFERENCES annotation_repair_batches(id))"
        )
        connection.exec_driver_sql(
            "CREATE TABLE annotation_repair_proposal_revisions "
            "(id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES annotation_repair_items(id))"
        )
        connection.exec_driver_sql("INSERT INTO annotation_repair_batches VALUES (1)")
        connection.exec_driver_sql("INSERT INTO annotation_repair_items VALUES (1, 1)")
        connection.exec_driver_sql("INSERT INTO annotation_repair_proposal_revisions VALUES (1, 1)")
        if include_applications:
            connection.exec_driver_sql(
                "CREATE TABLE annotation_repair_applications (id INTEGER PRIMARY KEY)"
            )
            connection.exec_driver_sql("INSERT INTO annotation_repair_applications VALUES (1)")
        # An absent applications table represents partially cleaned installations.
        migration = load_migration()
        with Operations.context(MigrationContext.configure(connection)):
            migration.upgrade()
            migration.upgrade()
        assert sa.inspect(connection).get_table_names() == ["annotations"]
        assert connection.exec_driver_sql("SELECT body FROM annotations").scalar_one() == (
            "saved annotation"
        )


def test_cleanup_downgrade_requires_backup():
    with pytest.raises(RuntimeError, match="restore a database backup"):
        load_migration().downgrade()
