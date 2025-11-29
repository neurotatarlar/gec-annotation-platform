"""Seed default error types

Revision ID: 20240903_02_seed_error_types
Revises: 20240903_01_initial
Create Date: 2024-09-03 00:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20240903_02_seed_error_types"
down_revision = "20240903_01_initial"
branch_labels = None
depends_on = None


TAXONOMY = [
    {
        "category_en": "WordError",
        "category_tt": "Сүз хатасы",
        "en_name": "Spelling",
        "tt_name": "C/СүздәХата",
        "description": "Сүзне хата белән язу: хәрефләрнең җитмәү яки артык булу, тартык һәм сузык авазларны бутап язу, стандарт орфографияне бозу",
    },
    {
        "category_en": "WordError",
        "category_tt": "Сүз хатасы",
        "en_name": "Script",
        "tt_name": "ЯзуСистемасы",
        "description": "Кирил һәм латин язу системаларын кушып куллану, сүз эчендә язу системасын алыштыру яки стандарт булмаган транслитерация системасын куллану",
    },
    {
        "category_en": "WordError",
        "category_tt": "Сүз хатасы",
        "en_name": "Dialect",
        "tt_name": "Диалект",
        "description": "Әдәби татар телендә сүз булган очракта да диалект сүзен куллану",
    },
    {
        "category_en": "Punctuation",
        "category_tt": "Пунктуация",
        "en_name": "Punctuation",
        "tt_name": "Пунктуация",
        "description": "Өтерләрне, нокталарны, сорау/өндәү билгеләрен, куштырнакларны, дефисларны яки башка тыныш билгеләрен ялгыш куллану",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Case",
        "tt_name": "КилешХатасы",
        "description": "Ияләр белән килеш бәйләнешен дөрес кулланмау",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Possessive",
        "tt_name": "ИялекКушымчасы",
        "description": "Иялек кушымчаларын ялгыш куллану",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Agreement",
        "tt_name": "ИяХәбәрКилешүе",
        "description": "Ия - хәбәр арасында зат яки сан белән килешмәве",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "VerbTense",
        "tt_name": "Заман",
        "description": "Ялгыш заман куллану",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "VerbVoice",
        "tt_name": "ПассивАктив",
        "description": "Пассив яки актив формасын ялгыш куллану",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Particle",
        "tt_name": "Кисәкчә",
        "description": "Кисәкчәләрне ялгыш куллану (бит, инде, гына, да, һ.б.)",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Hyphen",
        "tt_name": "Сызык",
        "description": "Сызыкны ялгыш куллану",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Merge",
        "tt_name": "КушыпЯзу",
        "description": "Аерым языла торган сүзләрне кушып язу",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "Split",
        "tt_name": "АерыпЯзу",
        "description": "Бер сүзне ялгыш аерып язу",
    },
    {
        "category_en": "Grammar",
        "category_tt": "Грамматика",
        "en_name": "WordOrder",
        "tt_name": "СүзләрТәртибе",
        "description": "Җөмләдә сүзләр тәртибен бозу",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "WordChoice",
        "tt_name": "СүзКулланышы",
        "description": "Семантик яктан урынга килешмәгән сүз куллану",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "Calque",
        "tt_name": "Калька",
        "description": "Башка телдән татар теленә туры тәрҗемә итү",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "Collocation",
        "tt_name": "Изафә",
        "description": "Грамматик яктан дөрес, ләкин телгә хас булмаган итеп сүзләрне бәйләү",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "Paronym",
        "tt_name": "Пароним",
        "description": "Мәгънәсе белән аерыла торган һәм шул ук вакытта яңгырашы яки язылышы белән якын сүзләрне бутап куллану",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "Style",
        "tt_name": "Стиль",
        "description": "Гади һәм рәсми сөйләмне катыштырып куллану",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "Pleonasm",
        "tt_name": "Плеоназм",
        "description": "Бер үк мәгънәне бирүче сүзләрне бергә куллану",
    },
    {
        "category_en": "Fluency",
        "category_tt": "Шомалык",
        "en_name": "CodeSwitch",
        "tt_name": "ТелАлмаштыру",
        "description": "Татар телендә вариант булган очракта татар җөмләсендә башка телдән сүзтезмәсен куллану",
    },
]


COLOR_BY_CATEGORY = {
    "WordError": "#f97316",
    "Punctuation": "#38bdf8",
    "Grammar": "#a855f7",
    "Fluency": "#22c55e",
}


def upgrade() -> None:
    error_types = sa.table(
        "error_types",
        sa.column("id", sa.Integer()),
        sa.column("description", sa.Text()),
        sa.column("default_color", sa.String()),
        sa.column("default_hotkey", sa.String()),
        sa.column("is_active", sa.Boolean()),
        sa.column("category_en", sa.String()),
        sa.column("category_tt", sa.String()),
        sa.column("en_name", sa.String()),
        sa.column("tt_name", sa.String()),
    )

    conn = op.get_bind()
    existing = {
        (row.en_name, row.tt_name): row
        for row in conn.execute(sa.select(error_types.c.en_name, error_types.c.tt_name, error_types.c.id))
    }

    for entry in TAXONOMY:
        data = {
            **entry,
            "default_color": COLOR_BY_CATEGORY.get(entry["category_en"], "#f97316"),
            "default_hotkey": None,
            "is_active": True,
        }
        key = (entry.get("en_name"), entry.get("tt_name"))
        if key in existing:
            conn.execute(
                error_types.update()
                .where(error_types.c.id == existing[key].id)
                .values(**data)
            )
        else:
            conn.execute(error_types.insert().values(**data))


def downgrade() -> None:
    error_types = sa.table(
        "error_types",
        sa.column("en_name", sa.String()),
        sa.column("tt_name", sa.String()),
    )
    op.execute(
        error_types.delete().where(
            sa.tuple_(error_types.c.en_name, error_types.c.tt_name).in_(
                [(entry.get("en_name"), entry.get("tt_name")) for entry in TAXONOMY]
            )
        )
    )
