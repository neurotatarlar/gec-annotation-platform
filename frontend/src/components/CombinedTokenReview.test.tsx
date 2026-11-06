import {render,screen,fireEvent} from '@testing-library/react';
import {it,expect} from 'vitest';
import {CombinedTokenReview} from './CombinedTokenReview';
const author=(name:string,value:string,type=1)=>({author_id:name,username:name,target:value+' world',annotations:[{id:name,replacement:value,error_type_id:type,error_type_name:'Spelling',payload:{operation:'replace',before_tokens:['base-0'],text_tokens:['hello','world']}}]});
it('uses the opened author and reveals attribution and alternatives on click',()=>{
 const {container}=render(<CombinedTokenReview source="hello world" authors={[author('Rafida','hi'),author('Rinat','hey')]}/>);
 const details=container.querySelector('details')!;
 expect(details.open).toBe(false);expect(screen.getByText('hi',{selector:'span'})).toBeVisible();
 expect(screen.getByText('+1')).toBeVisible();
 fireEvent.click(details.querySelector('summary')!);expect(details.open).toBe(true);
 expect(screen.getByText('Rinat',{selector:'strong'})).toBeVisible();
 fireEvent.keyDown(document,{key:'Escape'});expect(details.open).toBe(false);
});
it('collapses equivalent corrections while retaining both authors',()=>{
 const {container}=render(<CombinedTokenReview source="hello world" authors={[author('A','hi'),author('B','hi')]}/>);
 expect(container.querySelectorAll('details')).toHaveLength(1);expect(screen.queryByText('+1')).toBeNull();
 expect(container.querySelector('summary')?.title).toContain('A');expect(container.querySelector('summary')?.title).toContain('B');
});
it('does not collapse differing error types and keeps unmappable records available',()=>{
 const bad=author('C','unknown');bad.annotations[0].payload.text_tokens=['missing'];
 render(<CombinedTokenReview source="hello world" authors={[author('A','hi'),author('B','hi',2),bad]}/>);
 expect(screen.getByText('+1')).toBeVisible();expect(screen.getByText(/Saved position|annotationReview.unplaced/)).toBeInTheDocument();
});
it('shows a linked move at its source and destination',()=>{
 const a=author('A','gamma');a.annotations[0].payload={operation:'move',before_tokens:['base-2'],text_tokens:['alpha','beta','gamma'],move_from:2,move_to:0,move_len:1} as any;
 const {container}=render(<CombinedTokenReview source="alpha beta gamma" authors={[a]}/>);
 const markers=container.querySelectorAll('[data-group-move]');expect(markers).toHaveLength(2);expect(markers[0].getAttribute('data-group-move')).toBe(markers[1].getAttribute('data-group-move'));
});
