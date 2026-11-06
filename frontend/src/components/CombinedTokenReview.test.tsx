import {render,screen} from '@testing-library/react';
import {it,expect} from 'vitest';
import {CombinedTokenReview} from './CombinedTokenReview';
it('keeps overlapping author alternatives separate on the original passage',()=>{
 render(<CombinedTokenReview source="hello world" authors={['one','two'].map((name,i)=>({author_id:name,username:name,target:name+' world',annotations:[{id:i,replacement:name,error_type_name:'Spelling',payload:{operation:'replace',before_tokens:['base-0'],text_tokens:['hello','world']}}]}))}/>);
 expect(screen.getByText('one')).toBeInTheDocument();expect(screen.getByText('two')).toBeInTheDocument();expect(screen.getByText('hello')).toBeInTheDocument();
});
