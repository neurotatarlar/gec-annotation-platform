import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { hydrateFromServerAnnotations, buildTextFromTokensWithBreaks, computeLineBreaksFromText, buildTokenFragment, buildAnnotationsPayloadStandalone, deriveMoveMarkers, deriveCorrectionCards } from './TokenEditorModel';

describe('explicit annotation token layout', () => {
  it('preserves paragraphs when an edit changes the token count', () => {
    const source = 'Alpha beta.\n\nGamma delta.';
    const items = [{id:1,start_token:0,end_token:0,replacement:'Alpha extra',payload:{
      operation:'replace',before_tokens:['base-0'],text_tokens:['Alpha','beta','.','Gamma','delta','.'],
      preserve_source_layout:true,after_tokens:[{id:'a',text:'Alpha extra',origin:'inserted',space_before:false,line_breaks_before:0}]
    }}];
    const hydrated = hydrateFromServerAnnotations({items,initialText:source})!;
    expect(buildTextFromTokensWithBreaks(hydrated.present.tokens,computeLineBreaksFromText(source)))
      .toBe('Alpha extra beta.\n\nGamma delta.');
    const gamma = hydrated.present.tokens.find(t=>t.text==='Gamma')!;
    expect(buildTokenFragment(gamma)).toHaveProperty('line_breaks_before',2);
  });
  it('round-trips an insertion anchor without consuming the anchored source word', async () => {
    const source='Alpha beta';
    const items=[{id:1,start_token:1,end_token:1,replacement:',',error_type_id:4,payload:{
      schema_version:2,client_correction_id:'comma',operation:'insert',before_tokens:['base-0'],
      text_tokens:['Alpha','beta'],preserve_source_layout:true,
      after_tokens:[{id:'a',text:',',origin:'inserted',space_before:false,line_breaks_before:0}]
    }}];
    const h=hydrateFromServerAnnotations({items,initialText:source})!;
    const moveMarkers=deriveMoveMarkers(h.present.tokens);
    const saved=await buildAnnotationsPayloadStandalone({initialText:source,tokens:h.present.tokens,
      originalTokens:h.present.originalTokens,moveMarkers,correctionCards:deriveCorrectionCards(h.present.tokens,moveMarkers),
      correctionTypeMap:h.typeMap,includeClientCorrectionId:true});
    expect(saved[0].payload.operation).toBe('insert');
    expect(saved[0].payload.client_correction_id).toBe('comma');
    const reload=hydrateFromServerAnnotations({items:saved,initialText:source})!;
    expect(buildTextFromTokensWithBreaks(reload.present.tokens,[])).toBe('Alpha, beta');
  });
  it('preserves literal line breaks inside a replacement', () => {
    const source='Alpha.\nBeta.';
    const items=[{id:1,start_token:0,end_token:3,replacement:'First.\n\nSecond.',payload:{
      operation:'replace',before_tokens:['base-0','base-1','base-2','base-3'],
      text_tokens:['Alpha','.','Beta','.'],preserve_source_layout:true,
      after_tokens:[{id:'a',text:'First.\n\nSecond.',origin:'inserted',space_before:false,line_breaks_before:0}]
    }}];
    const hydrated=hydrateFromServerAnnotations({items,initialText:source})!;
    expect(buildTextFromTokensWithBreaks(hydrated.present.tokens,computeLineBreaksFromText(source))).toBe('First.\n\nSecond.');
  });
});


describe.skipIf(!process.env.ANNOTATION_PARITY_INPUT)('confirmed dataset reload', () => {
  it('round-trips hydrated corrections through the canonical save payload', async () => {
    const rows=JSON.parse(fs.readFileSync(process.env.ANNOTATION_PARITY_INPUT!, 'utf8'));
    const results=[];
    for (const row of rows) {
      if (!row.annotations.length) continue;
      const h=hydrateFromServerAnnotations({items:row.annotations,initialText:row.source})!;
      const moveMarkers=deriveMoveMarkers(h.present.tokens);
      const correctionCards=deriveCorrectionCards(h.present.tokens,moveMarkers);
      const annotations=await buildAnnotationsPayloadStandalone({initialText:row.source,tokens:h.present.tokens,
        originalTokens:h.present.originalTokens,correctionCards,correctionTypeMap:h.typeMap,moveMarkers,allowUnassigned:true,includeClientCorrectionId:true});
      const reload=hydrateFromServerAnnotations({items:annotations,initialText:row.source})!;
      const target=buildTextFromTokensWithBreaks(reload?.present.tokens ?? h.present.originalTokens,computeLineBreaksFromText(row.source));
      results.push({id:row.id,source:row.source,annotations,target});
      expect(target, `text ${row.id}`).toBe(row.target);
    }
    if(process.env.ANNOTATION_ROUNDTRIP_OUTPUT) fs.writeFileSync(process.env.ANNOTATION_ROUNDTRIP_OUTPUT,JSON.stringify(results));
  });
});
