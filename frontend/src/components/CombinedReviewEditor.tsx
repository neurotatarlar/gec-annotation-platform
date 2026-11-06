import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { useAuthedApi } from '../api/client';
import { useI18n } from '../context/I18nContext';
import { TokenEditor } from './TokenEditor';
import { ReviewAuthor } from './CombinedTokenReview';
export function CombinedReviewEditor({textId,categoryId,source,currentUserId}:{textId:number;categoryId:number;source:string;currentUserId:string}) {
 const api=useAuthedApi();const location=useLocation();const {t}=useI18n();
 const query=useQuery<{default_author_id:string;authors:ReviewAuthor[]}>({queryKey:['annotation-review',textId],queryFn:async()=>(await api.get(`/api/texts/${textId}/annotation-review`)).data});
 const params=new URLSearchParams(location.search);params.set('mode','edit');
 if(query.isLoading)return <p>{t('common.loading')}</p>;
 if(query.isError||!query.data)return <div role="alert">{t('annotationReview.loadError')}<button onClick={()=>query.refetch()}>{t('annotationReview.refresh')}</button></div>;
 const primary=query.data.authors.find(a=>a.author_id===query.data.default_author_id)??query.data.authors[0];
 return <><div style={{display:'flex',gap:12,color:'#cbd5e1',marginBottom:10}}>
 <span>{t('annotationReview.readOnly')} · {query.data.authors.map(a=>a.full_name||a.username).join(', ')}</span><Link to={`${location.pathname}?${params}`}>{t('annotationReview.editMine')}</Link>
 </div><TokenEditor key={`review-${textId}`} textId={textId} categoryId={categoryId} initialText={source} currentUserId={currentUserId}
 readOnly reviewAuthors={query.data.authors} reviewAnnotations={primary?.annotations??[]}/></>;
}
