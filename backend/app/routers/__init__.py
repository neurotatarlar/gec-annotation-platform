"""
Router aggregation for the FastAPI application.
"""

from . import auth, categories, dashboard, error_types, reports, texts

__all__ = ["auth", "categories", "dashboard", "error_types", "reports", "texts"]
