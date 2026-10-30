"""Explicit token layout survives restoration, hydration and rendering."""
from types import SimpleNamespace as NS
from app.services.annotation_rendering import render_corrected_text


def test_explicit_layout_keeps_paragraph_after_token_count_changes():
    source = 'Alpha beta.\n\nGamma delta.'
    row = NS(id=1, start_token=0, end_token=0, replacement='Alpha extra', payload={
        'operation':'replace', 'before_tokens':['base-0'],
        'text_tokens':['Alpha','beta','.','Gamma','delta','.'],
        'preserve_source_layout': True,
        'after_tokens':[{'id':'a','text':'Alpha extra','origin':'inserted',
                         'space_before':False,'line_breaks_before':0}],
    })
    assert render_corrected_text(source,[row]) == 'Alpha extra beta.\n\nGamma delta.'


def test_explicit_layout_can_replace_a_cross_paragraph_span():
    source = 'Alpha.\nBeta.'
    row = NS(id=1,start_token=0,end_token=3,replacement='First.\n\nSecond.',payload={
        'operation':'replace','before_tokens':['base-0','base-1','base-2','base-3'],
        'text_tokens':['Alpha','.','Beta','.'],'preserve_source_layout':True,
        'after_tokens':[{'id':'a','text':'First.\n\nSecond.','origin':'inserted',
                         'space_before':False,'line_breaks_before':0}],
    })
    assert render_corrected_text(source,[row]) == 'First.\n\nSecond.'


def test_literal_whitespace_after_a_line_break_is_preserved():
    source = 'Alpha. Beta.'
    row = NS(id=1, start_token=2, end_token=2, replacement='Beta', payload={
        'operation': 'replace', 'before_tokens': ['base-2'],
        'text_tokens': ['Alpha', '.', 'Beta', '.'], 'preserve_source_layout': True,
        'after_tokens': [{'id': 'a', 'text': 'Beta', 'origin': 'inserted',
                          'space_before': True, 'line_breaks_before': 1,
                          'whitespace_before': '\n '}],
    })
    assert render_corrected_text(source, [row]) == 'Alpha.\n Beta.'
