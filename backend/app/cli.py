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
from .services.annotation_repairs import (
    AnnotationRepairError,
    apply_manifest,
    build_approved_manifest,
    build_repair_audit_report,
    build_repair_bundle,
    build_review_state,
    export_repair_snapshot,
    import_repair_bundle,
    read_json,
    write_json,
)

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


@cli.command(name="set-user-role")
def set_user_role(
    username: str = typer.Option(..., "--username", "-u"),
    role: str = typer.Option(..., "--role", help="One of annotator, manager, or admin"),
):
    """Change an existing user's role."""
    if role not in {"annotator", "manager", "admin"}:
        raise typer.BadParameter("role must be annotator, manager, or admin")
    with session_scope() as session:
        user = session.query(User).filter(User.username == username).one_or_none()
        if not user:
            raise typer.BadParameter(f"User '{username}' does not exist")
        user.role = role
        typer.echo(f"Updated '{username}' to role '{role}'")


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


@cli.command(name="export-repair-snapshot")
def export_annotation_repair_snapshot(
    category_id: int = typer.Option(..., "--category-id", min=1),
    output: Path = typer.Option(..., "--output", "-o"),
):
    """Export the exact latest-submitted dataset state needed for offline repair."""
    with session_scope() as session:
        snapshot = export_repair_snapshot(session, category_id)
    write_json(output, snapshot)
    typer.echo(f"Exported {len(snapshot['records'])} repair records to {output}")


@cli.command(name="build-repair-bundle")
def build_annotation_repair_bundle(
    snapshot_path: Path = typer.Argument(..., exists=True, readable=True),
    output: Path = typer.Option(..., "--output", "-o"),
    previous_manifest: Optional[Path] = typer.Option(None, "--previous-manifest"),
    frontend_projection: Optional[Path] = typer.Option(
        None,
        "--frontend-projection",
        exists=True,
        readable=True,
        help="Exact targets produced by AnnotationProductionParity.test.ts",
    ),
    target_overrides: Optional[Path] = typer.Option(
        None,
        "--target-overrides",
        exists=True,
        readable=True,
        help="Reviewer-confirmed targets as a JSON object or a {targets: {...}} object",
    ),
):
    """Create deterministic canonical proposals from a production snapshot."""
    try:
        previous = read_json(previous_manifest) if previous_manifest else None
        snapshot = read_json(snapshot_path)
        projections = None
        if frontend_projection:
            projection_rows = json.loads(frontend_projection.read_text())
            projections = {int(row["id"]): str(row["target"]) for row in projection_rows}
        overrides = None
        if target_overrides:
            override_payload = json.loads(target_overrides.read_text())
            override_rows = override_payload.get("targets", override_payload)
            overrides = {int(text_id): str(target) for text_id, target in override_rows.items()}
        bundle = build_repair_bundle(
            snapshot,
            previous,
            projections,
            overrides,
            require_frontend_projection=snapshot.get("format") == "annotation-repair-snapshot-v2",
        )
    except AnnotationRepairError as exc:
        raise typer.BadParameter(str(exc)) from exc
    write_json(output, bundle)
    typer.echo(f"Built repair batch {bundle['batch_id']} with {len(bundle['items'])} items")


@cli.command(name="audit-repair-bundle")
def audit_annotation_repair_bundle(
    bundle_path: Path = typer.Argument(..., exists=True, readable=True),
    output: Path = typer.Option(..., "--output", "-o"),
):
    """Summarize review-risk categories and their text IDs."""
    try:
        report = build_repair_audit_report(read_json(bundle_path))
    except AnnotationRepairError as exc:
        raise typer.BadParameter(str(exc)) from exc
    write_json(output, report)
    typer.echo(f"Audited {report['item_count']} repair items to {output}")


@cli.command(name="build-repair-parity-input")
def build_repair_parity_input(
    snapshot_path: Path = typer.Argument(..., exists=True, readable=True),
    output: Path = typer.Option(..., "--output", "-o"),
):
    """Extract approval-time rows for exact frontend rendering projection."""
    snapshot = read_json(snapshot_path)
    if snapshot.get("format") != "annotation-repair-snapshot-v2":
        raise typer.BadParameter("Approval-time parity input requires snapshot v2")
    rows = [
        {
            "id": int(record["text_id"]),
            "source": str(record["source"]),
            "annotations": record.get("approval_annotations") or [],
        }
        for record in snapshot.get("records") or []
    ]
    write_json(output, rows)
    typer.echo(f"Extracted {len(rows)} approval-time records to {output}")


@cli.command(name="import-repair-bundle")
def import_annotation_repair_bundle(bundle_path: Path = typer.Argument(..., exists=True, readable=True)):
    """Import an offline bundle into the local review queue."""
    try:
        with session_scope() as session:
            batch = import_repair_bundle(session, read_json(bundle_path))
            batch_id = batch.id
            count = batch.item_count
    except AnnotationRepairError as exc:
        raise typer.BadParameter(str(exc)) from exc
    typer.echo(f"Imported repair batch {batch_id} with {count} items")


@cli.command(name="export-repair-manifest")
def export_annotation_repair_manifest(
    batch_id: str = typer.Option(..., "--batch-id"),
    output: Path = typer.Option(..., "--output", "-o"),
):
    """Export a manifest only after every review item is approved."""
    try:
        with session_scope() as session:
            manifest = build_approved_manifest(session, batch_id)
    except AnnotationRepairError as exc:
        raise typer.BadParameter(str(exc)) from exc
    write_json(output, manifest)
    typer.echo(f"Exported approved manifest {manifest['manifest_hash']} to {output}")


@cli.command(name="export-repair-review-state")
def export_annotation_repair_review_state(
    batch_id: str = typer.Option(..., "--batch-id"),
    output: Path = typer.Option(..., "--output", "-o"),
):
    """Export partial decisions so unchanged approvals survive regeneration."""
    try:
        with session_scope() as session:
            review_state = build_review_state(session, batch_id)
    except AnnotationRepairError as exc:
        raise typer.BadParameter(str(exc)) from exc
    write_json(output, review_state)
    typer.echo(f"Exported review state {review_state['review_state_hash']} to {output}")


@cli.command(name="apply-repair-manifest")
def apply_annotation_repair_manifest(
    manifest_path: Path = typer.Argument(..., exists=True, readable=True),
    dry_run: bool = typer.Option(True, "--dry-run/--apply"),
    confirm_hash: Optional[str] = typer.Option(None, "--confirm-hash"),
    receipt_output: Optional[Path] = typer.Option(None, "--receipt-output"),
):
    """Verify or atomically apply a fully approved repair manifest."""
    manifest = read_json(manifest_path)
    if not dry_run and confirm_hash != manifest.get("manifest_hash"):
        raise typer.BadParameter("--confirm-hash must equal the manifest hash when using --apply")
    try:
        with session_scope() as session:
            receipt = apply_manifest(session, manifest, dry_run=dry_run)
    except AnnotationRepairError as exc:
        raise typer.BadParameter(str(exc)) from exc
    if receipt_output:
        write_json(receipt_output, receipt)
    typer.echo(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    cli()
