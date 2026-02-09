"""
Typer-based admin CLI for managing users, categories, and imports, with optional database
overrides.
"""

import json
from pathlib import Path
from typing import Optional

import typer
from sqlalchemy.engine import URL, make_url

from .config import get_settings
from .database import configure_engine, session_scope
from .models import Annotation, Category, TextSample, User
from .services import auth as auth_service

cli = typer.Typer(help="Admin CLI for GEC annotation platform")


@cli.callback()
def configure_cli(
    database_url: Optional[str] = typer.Option(
        None,
        "--database-url",
        help="Full SQLAlchemy URL overriding settings.database.url",
    ),
    db_host: Optional[str] = typer.Option(None, help="Override database host"),
    db_port: Optional[int] = typer.Option(None, help="Override database port"),
    db_name: Optional[str] = typer.Option(None, help="Override database name"),
    db_user: Optional[str] = typer.Option(None, help="Override database username"),
    db_password: Optional[str] = typer.Option(None, help="Override database password"),
):
    """Optional CLI-wide options executed before each command."""
    if database_url:
        configure_engine(database_url)
        return

    if any(param is not None for param in (db_host, db_port, db_name, db_user, db_password)):
        base_settings = get_settings()
        base_url = make_url(base_settings.database.url)
        effective_url = URL.create(
            drivername=base_url.drivername,
            username=db_user or base_url.username,
            password=db_password if db_password is not None else base_url.password,
            host=db_host or base_url.host,
            port=db_port if db_port is not None else base_url.port,
            database=db_name or base_url.database,
            query=base_url.query,
        )
        configure_engine(effective_url.render_as_string(hide_password=False))


@cli.command(name="add-category")
def add_category(
    name: str = typer.Option(..., "--name", "-n", help="Category name"),
    description: Optional[str] = typer.Option(None, "--description", "-d", help="Optional description"),
):
    """Create or update a category with an optional description."""
    with session_scope() as session:
        category = session.query(Category).filter(Category.name == name).one_or_none()
        if category:
            category.description = description
            typer.echo(f"Updated category '{name}' description.")
        else:
            session.add(Category(name=name, description=description))
            typer.echo(f"Created category '{name}'.")


@cli.command(name="create-user")
def create_user(
    username: str = typer.Option(..., "--username", "-u", help="Username for the new account"),
    password: str = typer.Option(..., "--password", "-p", help="Password for the new account"),
    full_name: Optional[str] = typer.Option(None, "--full-name", "-n", help="Optional full name"),
    admin: bool = typer.Option(False, help="Create an admin instead of an annotator"),
):
    """Create a user (annotator by default)."""
    with session_scope() as session:
        if session.query(User).filter(User.username == username).first():
            typer.echo("User already exists")
            raise typer.Exit(code=1)
        user = User(
            username=username,
            password_hash=auth_service.get_password_hash(password),
            full_name=full_name,
            role="admin" if admin else "annotator",
        )
        session.add(user)
        typer.echo(f"Created user with username '{username}'{'' if not full_name else '(' + full_name +')'} and role '{'admin' if admin else 'annotator'}'")


@cli.command()
def import_texts(json_path: Path):
    """Import texts from a JSON object {category, required_annotations, content:[...]}."""
    payload = json.loads(json_path.read_text())
    if not isinstance(payload, dict):
        raise typer.BadParameter("JSON must be an object with category/content fields")

    category_name = payload.get("category")
    if not isinstance(category_name, str) or not category_name.strip():
        raise typer.BadParameter("'category' must be a non-empty string")

    required_annotations = payload.get("required_annotations", 2)
    if not isinstance(required_annotations, int) or required_annotations < 1:
        raise typer.BadParameter("'required_annotations' must be a positive integer")

    content_items = payload.get("content")
    if not isinstance(content_items, list) or not all(isinstance(text, str) for text in content_items):
        raise typer.BadParameter("'content' must be a list of text strings")

    with session_scope() as session:
        category = session.query(Category).filter(Category.name == category_name).one_or_none()
        if not category:
            category = Category(name=category_name)
            session.add(category)
            session.flush()

        for text_body in content_items:
            session.add(
                TextSample(
                    content=text_body,
                    category_id=category.id,
                    required_annotations=required_annotations,
                )
            )
        typer.echo(f"Imported {len(content_items)} texts into {category_name}")


@cli.command()
def export_annotations(output: Path):
    """Export annotations with metadata."""
    with session_scope() as session:
        rows = (
            session.query(Annotation)
            .order_by(Annotation.text_id, Annotation.author_id, Annotation.id)
            .all()
        )
        payload = [
            {
                "text_id": row.text_id,
                "annotation_id": row.id,
                "author_id": str(row.author_id),
                "start_token": row.start_token,
                "end_token": row.end_token,
                "replacement": row.replacement,
                "error_type_id": row.error_type_id,
                "payload": row.payload,
                "version": row.version,
            }
            for row in rows
        ]
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        typer.echo(f"Exported {len(payload)} annotations to {output}")


if __name__ == "__main__":
    cli()
