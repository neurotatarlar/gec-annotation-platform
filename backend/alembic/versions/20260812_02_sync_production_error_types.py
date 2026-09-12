"""Synchronize error types with the production taxonomy.

Revision ID: 20260812_02_sync_production_error_types
Revises: 20260812_01_repair_proposal_revisions
Create Date: 2026-08-12 12:00:00.000000
"""

from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert as pg_insert

revision = "20260812_02_sync_production_error_types"
down_revision = "20260812_01_repair_proposal_revisions"
branch_labels = None
depends_on = None


PRODUCTION_ERROR_TYPES = [
    (1, "Сүзне хата белән язу: хәрефләрнең җитмәү яки артык булу, тартык һәм сузык авазларны бутап язу, стандарт орфографияне бозу", 7, "#b46a3d", "shift+j", "Other", "Башкалар", "Spelling", "СүздәХата"),
    (2, "Кирил һәм латин язу системаларын кушып куллану, сүз эчендә язу системасын алыштыру яки стандарт булмаган транслитерация системасын куллану", 5, "#b46a3d", "shift+g", "Other", "Башкалар", "Script", "ЯзуСистемасы"),
    (3, "Әдәби татар телендә сүз булган очракта да диалект сүзен куллану", 2, "#b46a3d", "shift+s", "Other", "Башкалар", "Dialect", "Диалект"),
    (4, "Өтерләрне, нокталарны, сорау/өндәү билгеләрен, куштырнакларны, дефисларны яки башка тыныш билгеләрен ялгыш куллану", 4, "#4e78a8", "shift+f", "Other", "Башкалар", "Punctuation", "Пунктуация"),
    (5, "Ияләр белән килеш бәйләнешен дөрес кулланмау", 1, "#7a5c9c", "shift+q", "Grammar", "Грамматика", "Case", "КилешХатасы"),
    (6, "Иялек кушымчаларын ялгыш куллану", 6, "#7a5c9c", "shift+u", "Grammar", "Грамматика", "Possessive", "ИялекКушымчасы"),
    (7, "Ия - хәбәр арасында зат яки сан белән килешмәве", 9, "#7a5c9c", "shift+o", "Grammar", "Грамматика", "SubjectVerbAgreement", "ИяХәбәрКилешүе"),
    (8, "Ялгыш заман куллану", 10, "#7a5c9c", "shift+p", "Grammar", "Грамматика", "VerbTense", "Заман"),
    (9, "Пассив яки актив формасын ялгыш куллану", 11, "#7a5c9c", "shift+[", "Grammar", "Грамматика", "VerbVoice", "ПассивАктив"),
    (10, "Кисәкчәләрне ялгыш куллану (бит, инде, гына, да, һ.б.)", 5, "#7a5c9c", "shift+y", "Grammar", "Грамматика", "Particle", "Кисәкчә"),
    (11, "Сызыкны ялгыш куллану", 2, "#7a5c9c", "shift+e", "Grammar", "Грамматика", "Hyphen", "Сызык"),
    (12, "Аерым языла торган сүзләрне кушып язу", 3, "#7a5c9c", "shift+r", "Grammar", "Грамматика", "Merge", "ЯлгышКушыпЯзу"),
    (13, "Бер сүзне ялгыш аерып язу", 8, "#7a5c9c", "shift+i", "Grammar", "Грамматика", "Split", "ЯлгышАерыпЯзу"),
    (14, "Җөмләдә сүзләр тәртибен бозу", 12, "#7a5c9c", "shift+]", "Grammar", "Грамматика", "WordOrder", "СүзләрТәртибе"),
    (15, "Семантик яктан урынга килешмәгән сүз куллану", 7, "#3f7c5a", "shift+7", "Fluency", "Шомалык", "WordChoice", "СүзКулланышы"),
    (16, "Башка телдән татар теленә туры тәрҗемә итү", 1, "#3f7c5a", "shift+1", "Fluency", "Шомалык", "Calque", "Калька"),
    (17, "Грамматик яктан дөрес, ләкин телгә хас булмаган итеп сүзләрне бәйләү", 3, "#3f7c5a", "shift+3", "Fluency", "Шомалык", "Collocation", "Изафә"),
    (18, "Мәгънәсе белән аерыла торган һәм шул ук вакытта яңгырашы яки язылышы белән якын сүзләрне бутап куллану", 4, "#3f7c5a", "shift+4", "Fluency", "Шомалык", "Paronym", "Пароним"),
    (19, "Гади һәм рәсми сөйләмне катыштырып куллану", 6, "#3f7c5a", "shift+6", "Fluency", "Шомалык", "Style", "Стиль"),
    (20, "Бер үк мәгънәне бирүче сүзләрне бергә куллану", 5, "#3f7c5a", "shift+5", "Fluency", "Шомалык", "Pleonasm", "Плеоназм"),
    (21, "Татар телендә вариант булган очракта татар җөмләсендә башка телдән сүзтезмәсен куллану", 2, "#3f7c5a", "shift+2", "Fluency", "Шомалык", "CodeSwitch", "ТелАлмаштыру"),
    (22, "Башка категорияләргә туры киләмәгә хата", 8, "#b46a3d", "shift+k", "Other", "Башкалар", "Undefiined", "Билгесез"),
    (23, "Ия һәм хәбәр югалу", 4, "#7a5c9c", "shift+t", "Grammar", "Грамматика", "MissingSubjVerb", "ЮгалганИяХәбәр"),
    (24, "Тартым кушымчасын дөрес кулланмау", 7, "#7a5c9c", "shift+w", "Grammar", "Грамматика", "Possessive", "Тартым"),
    (25, "Мәгънәне тулырак белдерүчу сүз югалган", 3, "#b46a3d", "shift+d", "Other", "Башкалар", "MissingWord", "ЮгалганСүз"),
    (26, "Баш хәрефтән языла торган сүзне юл хәрефеннән язу яки киресенчә", 1, "#b46a3d", "shift+a", "Other", "Башкалар", "CapitalLowerLetter", "БашЮлХәреф"),
    (27, "Бер җөмлә булып язылган текст чынлыкта ике яки күбрәк җөмләгә бүленергә тиеш, яисә киресенчә, бер бөтен булырга тиешле фикер ялгыш рәвештә аерым җөмләләргә бүлеп язылган (нәтиҗәдә өлешләрнең берсе тулы булмый яки икенчесенә бәйле кала).", 6, "#b46a3d", "shift+h", "Other", "Башкалар", "SentenceBoundaries", "ҖөмләЧикләре"),
    (28, None, 1, "#94a3b8", None, None, None, "noop", None),
]

COLUMNS = (
    "id",
    "description",
    "sort_order",
    "default_color",
    "default_hotkey",
    "category_en",
    "category_tt",
    "en_name",
    "tt_name",
)
ROWS = [dict(zip(COLUMNS, values)) | {"is_active": True} for values in PRODUCTION_ERROR_TYPES]
BY_ID = {row["id"]: row for row in ROWS}
SAME_MEANING_ALIASES = {(7, "Agreement")}
RELOCATIONS = {(24, "noop"): 28, (25, "CapitalLowerLetter"): 26}


def _reference_counts(conn: sa.Connection, error_type_id: int) -> tuple[int, int]:
    annotation_count = conn.scalar(
        sa.text("SELECT count(*) FROM annotations WHERE error_type_id = :id"),
        {"id": error_type_id},
    )
    preference_count = conn.scalar(
        sa.text("SELECT count(*) FROM user_error_types WHERE error_type_id = :id"),
        {"id": error_type_id},
    )
    return int(annotation_count or 0), int(preference_count or 0)


def _relocate_references(conn: sa.Connection, source_id: int, target_id: int) -> None:
    conn.execute(
        sa.text(
            """
            DELETE FROM user_error_types source
            USING user_error_types target
            WHERE source.error_type_id = :source_id
              AND target.error_type_id = :target_id
              AND source.user_id = target.user_id
            """
        ),
        {"source_id": source_id, "target_id": target_id},
    )
    conn.execute(
        sa.text("UPDATE user_error_types SET error_type_id = :target_id WHERE error_type_id = :source_id"),
        {"source_id": source_id, "target_id": target_id},
    )
    conn.execute(
        sa.text("UPDATE annotations SET error_type_id = :target_id WHERE error_type_id = :source_id"),
        {"source_id": source_id, "target_id": target_id},
    )
    conn.execute(
        sa.text(
            """
            UPDATE annotation_versions
            SET snapshot = jsonb_set(
                snapshot,
                '{error_type_id}',
                to_jsonb(CAST(:target_id AS integer)),
                false
            )
            WHERE snapshot ->> 'error_type_id' = :source_text
            """
        ),
        {
            "source_text": str(source_id),
            "target_id": target_id,
        },
    )


def _retire_historical_identity(conn: sa.Connection, row: dict[str, object]) -> None:
    identity = json.dumps(
        {key: row[key] for key in COLUMNS if key != "id"} | {"id": row["id"]},
        ensure_ascii=False,
    )
    conn.execute(
        sa.text(
            """
            UPDATE annotation_versions
            SET snapshot = jsonb_set(snapshot, '{error_type_id}', 'null'::jsonb, false)
                || jsonb_build_object('legacy_error_type', CAST(:identity AS jsonb))
            WHERE snapshot ->> 'error_type_id' = :source_text
            """
        ),
        {"identity": identity, "source_text": str(row["id"])},
    )


def upgrade() -> None:
    conn = op.get_bind()
    error_types = sa.table(
        "error_types",
        sa.column("id", sa.Integer()),
        sa.column("description", sa.Text()),
        sa.column("sort_order", sa.Integer()),
        sa.column("default_color", sa.String()),
        sa.column("default_hotkey", sa.Text()),
        sa.column("category_en", sa.String()),
        sa.column("category_tt", sa.String()),
        sa.column("en_name", sa.String()),
        sa.column("tt_name", sa.String()),
        sa.column("is_active", sa.Boolean()),
    )
    existing = {
        int(row.id): dict(row._mapping)
        for row in conn.execute(sa.select(error_types).order_by(error_types.c.id))
    }

    for error_type_id, current in existing.items():
        canonical = BY_ID.get(error_type_id)
        if not canonical or current["en_name"] == canonical["en_name"]:
            continue
        identity = (error_type_id, current["en_name"])
        if identity in RELOCATIONS or identity in SAME_MEANING_ALIASES:
            continue
        annotation_count, preference_count = _reference_counts(conn, error_type_id)
        if annotation_count or preference_count:
            raise RuntimeError(
                f"Cannot replace error type {error_type_id} ({current['en_name']!r}); "
                f"it has {annotation_count} annotation and {preference_count} preference references"
            )

    for (source_id, source_name), target_id in RELOCATIONS.items():
        current = existing.get(source_id)
        if not current or current["en_name"] != source_name:
            continue
        target = BY_ID[target_id]
        conn.execute(pg_insert(error_types).values(**target).on_conflict_do_nothing(index_elements=["id"]))
        _relocate_references(conn, source_id, target_id)

    for error_type_id, current in existing.items():
        canonical = BY_ID.get(error_type_id)
        if not canonical or current["en_name"] == canonical["en_name"]:
            continue
        identity = (error_type_id, current["en_name"])
        if identity not in RELOCATIONS and identity not in SAME_MEANING_ALIASES:
            _retire_historical_identity(conn, current)

    for row in ROWS:
        statement = pg_insert(error_types).values(**row)
        conn.execute(
            statement.on_conflict_do_update(
                index_elements=["id"],
                set_={key: statement.excluded[key] for key in row if key != "id"},
            )
        )

    conn.execute(
        sa.text(
            """
            SELECT setval(
                pg_get_serial_sequence('error_types', 'id'),
                GREATEST((SELECT max(id) FROM error_types), 1),
                true
            )
            """
        )
    )


def downgrade() -> None:
    # This migration reconciles environment-specific data. Recreating overwritten local
    # definitions would corrupt IDs after new annotations use the production taxonomy.
    pass
