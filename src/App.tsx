import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, Columns2, Rows2, FilePlus2, FileText, FolderOpen, Grid2X2, GripVertical, HelpCircle, LibraryBig, LoaderCircle, Maximize2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, Sparkles, Star, Upload, X, Clock3, Pencil, Trash2, ExternalLink, Pin, PinOff, Minimize2, Undo2, Redo2 } from 'lucide-react';
import type { Bootstrap, PaperDocument, Settings, TextSelection, Workspace } from '../shared/types';
import Library from './components/Library';
import RemovedArticles from './components/RemovedArticles';
import SettingsModal from './components/SettingsModal';
import AssistantPanel from './components/AssistantPanel';
import PdfPane from './components/PdfPane';
import useBackgroundIndex from './pdf/useBackgroundIndex';
import useReadingLayout from './hooks/useReadingLayout';
import useFloatingAssistant from './hooks/useFloatingAssistant';
import useDocumentEdits from './hooks/useDocumentEdits';
import { FILE_MANAGER, PLATFORM, PLATFORM_LABEL, shortcutLabel } from './platform';

type Navigation = {page:number;nonce:number};
const errorText=(e:unknown)=>e instanceof Error?e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''):String(e);

export default function App(){
  const [data,setData]=useState<Bootstrap|null>(null),[bootError,setBootError]=useState('');
  const [activeId,setActiveId]=useState<string|null>(null),[filter,setFilter]=useState<'all'|'favorites'|'recent'|'removed'>('all');
  const [settingsOpen,setSettingsOpen]=useState(false);
  const readingLayout=useReadingLayout();
  const sidebar=readingLayout.navigationExpanded,assistant=readingLayout.assistantOpen;
  const readerBody=useRef<HTMLDivElement>(null),assistantElement=useRef<HTMLDivElement>(null);
  const [readerWidth,setReaderWidth]=useState(0);
  const [busy,setBusy]=useState(false),[toast,setToast]=useState<{text:string;error:boolean}|null>(null);
  const [selection,setSelection]=useState<TextSelection|null>(null),[activePane,setActivePane]=useState<'left'|'right'>('left');
  const [nav,setNav]=useState<{left?:Navigation;right?:Navigation}>({});
  const [dragging,setDragging]=useState(false),[metadata,setMetadata]=useState(false),[docMenu,setDocMenu]=useState<string|null>(null);
  const [help,setHelp]=useState(false),[confirm,setConfirm]=useState<{title:string;description:string;action:()=>Promise<void>}|null>(null);
  const [rename,setRename]=useState<PaperDocument|null>(null);
  const [layoutMenu,setLayoutMenu]=useState(false);
  const [annotationHost,setAnnotationHost]=useState<HTMLElement|null>(null);
  useEffect(()=>{
    if(!annotationHost)return;
    const stack=annotationHost.closest<HTMLElement>('.reader-stack');if(!stack)return;
    const observer=new ResizeObserver(entries=>stack.style.setProperty('--annotation-clearance',`${Math.ceil(entries[0].contentRect.height)+12}px`));
    observer.observe(annotationHost);return()=>{observer.disconnect();stack.style.removeProperty('--annotation-clearance');};
  },[annotationHost]);
  const [annotationTool,setAnnotationTool]=useState<{color:string;armed:boolean;kind?:'highlight'|'underline'|'strikeout'}>({color:'#f5ce65',armed:false,kind:'highlight'});
  const [askFocus,setAskFocus]=useState<{workspaceId:string;nonce:number}>();
  const paneContainer=useRef<HTMLDivElement>(null),dragDepth=useRef(0);
  const activeRef=useRef<Workspace|undefined>(undefined);
  const workspace=data?.workspaces.find(w=>w.id===activeId);activeRef.current=workspace;
  const inform=useCallback((text:string,error=false)=>setToast({text,error}),[]);
  const onError=useCallback((text:string)=>inform(text,true),[inform]);
  const update=useCallback((ws:Workspace)=>setData(previous=>previous?{...previous,workspaces:previous.workspaces.some(w=>w.id===ws.id)?previous.workspaces.map(w=>w.id===ws.id&&w.updatedAt<=ws.updatedAt?ws:w):[ws,...previous.workspaces]}:previous),[]);
  const documentEdits=useDocumentEdits(activeId??undefined,update,onError);
  const refresh=useCallback(async()=>{try{setData(await window.folio.bootstrap());}catch(e){onError(errorText(e));}},[onError]);
  useBackgroundIndex(workspace,async(id,doc,index)=>{update(await window.folio.indexDocument(id,doc,index));},onError);
  useEffect(()=>{if(!window.folio)return;return window.folio.onPrepareClose(async()=>{const pending:Promise<void>[]=[];window.dispatchEvent(new CustomEvent('folio:flush-notes',{detail:pending}));await Promise.all(pending);});},[]);
  const run=useCallback(async(action:()=>Promise<void>)=>{setBusy(true);try{await action();}catch(e){onError(errorText(e));}finally{setBusy(false);}},[onError]);
  const changeAnnotationToolbar=useCallback(async(annotationToolbar:'floating'|'fixed')=>{
    if(!data?.settings)return;
    try{const settings=await window.folio.saveSettings({...data.settings,annotationToolbar});setData(previous=>previous?{...previous,settings}:previous);}
    catch(e){onError(errorText(e));}
  },[data?.settings,onError]);
  useEffect(()=>{
    if(!window.folio){setBootError('请在 Folio 桌面应用中使用。开发运行：npm run dev');return;}
    void window.folio.bootstrap().then(setData).catch(e=>setBootError(errorText(e)));
    return window.folio.onOpen(ws=>{update(ws);setActiveId(ws.id);setFilter(value=>value==='removed'?'all':value);setSelection(null);});
  },[update]);
  useEffect(()=>{document.documentElement.dataset.theme=data?.settings.theme??'light';},[data?.settings.theme]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),toast.error?12000:5000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{setSelection(null);setNav({});setDocMenu(null);setActivePane('left');readingLayout.exitFocus();setAnnotationTool(value=>({...value,armed:false}));},[activeId]);

  const patch=useCallback(async(id:string,value:Parameters<typeof window.folio.updateWorkspace>[1])=>{try{const ws=await window.folio.updateWorkspace(id,value);update(ws);return ws;}catch(e){onError(errorText(e));}},[update,onError]);
  const open=useCallback((id:string)=>{setActiveId(id);setFilter(value=>value==='removed'?'all':value);void patch(id,{lastReadAt:Date.now()});},[patch]);
  const create=useCallback((paths?:string[])=>void run(async()=>{const ws=await window.folio.createWorkspace(paths);if(ws){update(ws);open(ws.id);}}),[run,update,open]);
  const addDocuments=useCallback((paths?:string[])=>{const ws=activeRef.current;if(!ws)return;void run(async()=>{const next=await window.folio.importDocuments(ws.id,paths);if(next){update(next);inform('PDF 已加入当前文章工作区');}});},[run,update,inform]);
  const toggleSplit=useCallback(()=>{const ws=activeRef.current;if(!ws)return;void patch(ws.id,{layout:{...ws.layout,split:!ws.layout.split,rightId:ws.layout.rightId||ws.documents.find(d=>d.id!==ws.layout.leftId)?.id||ws.layout.leftId}});},[patch]);
  const setLayout=useCallback((direction:'vertical'|'horizontal'|'none')=>{const ws=activeRef.current;if(!ws)return;setLayoutMenu(false);void patch(ws.id,{layout:{...ws.layout,split:direction!=='none',direction:direction==='none'?ws.layout.direction:direction,ratio:direction!==ws.layout.direction?50:ws.layout.ratio,rightId:ws.layout.rightId||ws.documents.find(d=>d.id!==ws.layout.leftId)?.id||ws.layout.leftId}});},[patch]);
  useEffect(()=>{if(!window.folio)return;return window.folio.onCommand(command=>{
    if(command==='settings')setSettingsOpen(true);if(command==='import')create();if(command==='supplement')addDocuments();if(command==='library'){setActiveId(null);setFilter('all');}if(command==='split')toggleSplit();if(command==='assistant')readingLayout.toggleAssistant();
    if(command==='focus-reading'&&activeRef.current)readingLayout.toggleFocus();
    if(command==='undo'||command==='redo')documentEdits.undo(command);
    if(command==='split-vertical')setLayout('vertical');if(command==='split-horizontal')setLayout('horizontal');if(command==='split-none')setLayout('none');
    if(command==='export'&&activeRef.current)void run(async()=>{const result=await window.folio.exportMarkdown(activeRef.current!.id,'file');if(result)inform(`笔记已导出：${result.path}`);});
  });},[create,addDocuments,toggleSplit,setLayout,run,inform,readingLayout.toggleAssistant,readingLayout.toggleFocus,documentEdits.undo]);
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(e.key==='Escape'){setDocMenu(null);setHelp(false);}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[]);

  const navigate=(docId:string,page:number)=>{
    if(!workspace)return;
    const pane=workspace.layout.split&&workspace.layout.rightId===docId?'right':'left';
    if(pane==='left'&&workspace.layout.leftId!==docId)void patch(workspace.id,{layout:{...workspace.layout,leftId:docId}});
    setNav(v=>({...v,[pane]:{page,nonce:Date.now()}}));setActivePane(pane);
  };
  const splitFromPane=(side:'left'|'right',doc:PaperDocument,direction:'vertical'|'horizontal'|'none')=>{
    const ws=activeRef.current;if(!ws)return;
    setActivePane(side);setLayoutMenu(false);
    if(direction!=='none'&&!ws.layout.split){
      void patch(ws.id,{layout:{...ws.layout,split:true,direction,leftId:doc.id,rightId:doc.id,ratio:50}});
    }else setLayout(direction);
  };
  const drop=(event:React.DragEvent)=>{
    event.preventDefault();setDragging(false);dragDepth.current=0;
    const paths=Array.from(event.dataTransfer.files).map(file=>window.folio.pathForFile(file)).filter(Boolean);
    if(!paths.length)return;if(workspace)addDocuments(paths);else create(paths);
  };
  const resize=(event:React.PointerEvent)=>{
    event.preventDefault();const area=paneContainer.current;if(!area||!workspace)return;
    const ws=workspace;let ratio=ws.layout.ratio;
    const horizontal=ws.layout.direction==='horizontal';
    const move=(e:PointerEvent)=>{const rect=area.getBoundingClientRect();ratio=Math.max(28,Math.min(72,(horizontal?(e.clientY-rect.top)/rect.height:(e.clientX-rect.left)/rect.width)*100));area.style.setProperty('--split-ratio',`${ratio}%`);};
    const finish=()=>{document.body.classList.remove('resizing');window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);void patch(ws.id,{layout:{...ws.layout,ratio}});};
    document.body.classList.add('resizing');window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});
  };
  useEffect(()=>{
    const element=readerBody.current;if(!element)return;
    const observer=new ResizeObserver(entries=>setReaderWidth(Math.round(entries[0].contentRect.width)));
    observer.observe(element);return()=>observer.disconnect();
  },[activeId]);
  const resizeAssistant=(event:React.PointerEvent)=>{
    event.preventDefault();const element=assistantElement.current;if(!element)return;
    const startX=event.clientX,startWidth=element.getBoundingClientRect().width;
    let width=startWidth;
    const move=(pointer:PointerEvent)=>{width=Math.max(320,Math.min(600,startWidth+startX-pointer.clientX));element.style.setProperty('--assistant-width',`${width}px`);};
    const finish=()=>{document.body.classList.remove('resizing-assistant');window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);readingLayout.resizeAssistant(width);};
    document.body.classList.add('resizing-assistant');window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',finish,{once:true});
  };
  const deleteWorkspace=(ws:Workspace)=>setConfirm({title:'移除这篇论文？',description:'PDF、笔记、批注和对话会一起保留在「已移除文章」中，不会自动清理。你可以随时从那里恢复。',action:async()=>{await window.folio.deleteWorkspace(ws.id);setData(await window.folio.bootstrap());if(activeId===ws.id)setActiveId(null);inform('论文已移至「已移除文章」，可随时恢复');}});
  const restoreRemoved=async(id:string)=>{try{await window.folio.restoreWorkspace(id);setData(await window.folio.bootstrap());inform('论文已恢复到文献库，PDF 与阅读记录均已保留');}catch(e){onError(errorText(e));}};
  const purgeRemoved=async(id:string)=>{try{if(await window.folio.purgeWorkspace(id)){setData(await window.folio.bootstrap());inform('已彻底删除这篇论文及其工作区文件');}}catch(e){onError(errorText(e));}};
  const removeDoc=(doc:PaperDocument)=>{if(!workspace)return;const ws=workspace;setDocMenu(null);setConfirm({title:'移除此 PDF？',description:'文件会移到文章文件夹内的 .removed 目录，保留原件。此文件的阅读批注不再显示在当前工作区。',action:async()=>{update(await window.folio.removeDocument(ws.id,doc.id));await documentEdits.refresh(ws.id);}});};

  const horizontal=workspace?.layout.direction==='horizontal';
  const assistantDocked=readingLayout.preferences.assistantMode==='docked'&&readerWidth-readingLayout.preferences.assistantWidth>=(workspace?.layout.split&&!horizontal?840:460);
  const floatingAssistant=useFloatingAssistant({container:readerBody,panel:assistantElement,enabled:Boolean(workspace)&&assistant&&!assistantDocked,workspaceId:workspace?.id,position:readingLayout.preferences.assistantPosition,onMove:readingLayout.moveAssistant,onResize:readingLayout.resizeAssistant});

  if(bootError)return <div className="boot-screen"><BookOpen size={44}/><h1>Folio</h1><p>{bootError}</p><button onClick={()=>location.reload()}>重新加载</button></div>;
  if(!data)return <div className="boot-screen"><div className="brand-mark"><BookOpen size={30}/></div><h1>Folio</h1><LoaderCircle className="spin" size={20}/><p>正在打开你的阅读空间…</p></div>;

  const left=workspace?.documents.find(d=>d.id===workspace.layout.leftId)??workspace?.documents[0];
  const right=workspace?.documents.find(d=>d.id===workspace.layout.rightId)??workspace?.documents[1]??left;
  const paneLabel=(side:'left'|'right')=>horizontal?(side==='left'?'上方':'下方'):(side==='left'?'左侧':'右侧');
  const renderPane=(side:'left'|'right',doc:PaperDocument|undefined)=>doc&&workspace?<section className={`reading-column ${activePane===side?'is-active':''}`} aria-label={`${paneLabel(side)}阅读区`} onPointerDownCapture={()=>setActivePane(side)}>
    <header className="document-tab"><span className={`document-role ${doc.role}`}>{doc.role==='main'?'正文':'补充'}</span><FileText size={14}/><select aria-label={`${paneLabel(side)} PDF`} value={doc.id} onChange={e=>void patch(workspace.id,{layout:{...workspace.layout,[side==='left'?'leftId':'rightId']:e.target.value}})}>{workspace.documents.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select><ChevronDown size={12}/>{side==='right'&&<button className="icon-button" title="关闭第二阅读区" onClick={toggleSplit}><X size={14}/></button>}</header>
    <PdfPane key={`${workspace.id}-${side}-${doc.id}`} workspaceId={workspace.id} document={{...doc,view:workspace.layout.views?.[side]?.documentId===doc.id?workspace.layout.views[side]!.state:doc.view}} readingTheme={data.settings.readingTheme} editBusy={documentEdits.busy} annotationToolbar={data.settings.annotationToolbar} annotationToolbarHost={annotationHost} annotationTool={annotationTool} onAnnotationToolChange={value=>setAnnotationTool(previous=>({...previous,...value}))} onAnnotationToolbarChange={mode=>void changeAnnotationToolbar(mode)} active={activePane===side} onActivate={()=>setActivePane(side)} onDocumentPatch={async value=>{try{if(value.view)update(await window.folio.updateView(workspace.id,doc.id,side,value.view));const rest={...value};delete rest.view;if(Object.keys(rest).length)await documentEdits.editDocument(workspace.id,doc.id,rest);}catch(e){onError(errorText(e));throw e;}}} onIndexed={index=>void window.folio.indexDocument(workspace.id,doc.id,index).then(update).catch(e=>onError(errorText(e)))} onSelection={setSelection} onAsk={value=>{setSelection(value);readingLayout.openAssistant();setAskFocus({workspaceId:workspace.id,nonce:Date.now()});}} onError={onError} navigation={nav[side]} onSplit={direction=>splitFromPane(side,doc,direction)}/>
  </section>:<div className="no-pdf"><FileText size={35}/><h3>给这篇论文添加 PDF</h3><p>导入的旧笔记已保留，可以在这里继续阅读。</p><button className="primary-button" onClick={()=>addDocuments()}><Plus size={15}/> 添加 PDF</button></div>;

  return <div className={`folio-app ${readingLayout.focused&&workspace?'focus-reading':''}`} data-platform={PLATFORM} onDragEnter={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth.current++;setDragging(true);}}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDragLeave={e=>{e.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);}}} onDrop={drop}>
    <div className="titlebar"><div className="traffic-space"/><span className="titlebar-label">Folio <span>/</span> {workspace?'阅读工作区':filter==='removed'?'已移除文章':'个人文献库'}</span><div className="titlebar-right"><span className="local-dot"/> 本地保存 <span className="titlebar-separator"/> 为专注而留白</div></div>
    <div className="app-body">
      {(!workspace||sidebar)&&<aside className={`app-sidebar ${workspace?'in-workspace':''}`}>
        <button className="brand" onClick={()=>{setActiveId(null);setFilter('all');}} title="返回论文库"><span className="brand-mark"><BookOpen size={21} strokeWidth={1.6}/></span><strong>folio<span>阅读，亦是思考。</span></strong></button>
        <div className="sidebar-section-label">你的阅读空间</div>
        <nav className="main-navigation">{[{id:'all' as const,label:'全部论文',icon:LibraryBig,count:data.workspaces.length},{id:'recent' as const,label:'最近阅读',icon:Clock3},{id:'favorites' as const,label:'我的收藏',icon:Star,count:data.workspaces.filter(w=>w.favorite).length},{id:'removed' as const,label:'已移除文章',icon:Trash2,count:data.removedWorkspaces.length}].map(item=><button key={item.id} className={!workspace&&filter===item.id?'selected':''} onClick={()=>{setActiveId(null);setFilter(item.id);if(item.id==='removed')void refresh();}}><item.icon size={17}/><span>{item.label}</span>{item.count!==undefined&&<small>{item.count}</small>}</button>)}</nav>
        {workspace?<><div className="sidebar-rule"/><div className="sidebar-section-label">当前文章 <button className="icon-button" title={`在 ${FILE_MANAGER} 中打开文件夹`} onClick={()=>void window.folio.revealWorkspace(workspace.id).catch(e=>onError(errorText(e)))}><FolderOpen size={14}/></button></div><button className="workspace-name" title="编辑论文信息" onClick={()=>setMetadata(true)}>{workspace.title}<Pencil size={12}/></button><div className="workspace-files">{workspace.documents.map(doc=><div className={`workspace-file ${left?.id===doc.id||workspace.layout.split&&right?.id===doc.id?'selected':''}`} key={doc.id}><button className="file-main" title={`在${activePane==='left'?'左':'右'}侧打开 ${doc.name}`} onClick={()=>void patch(workspace.id,{layout:{...workspace.layout,[activePane==='right'&&workspace.layout.split?'rightId':'leftId']:doc.id}})}><span className={`file-icon ${doc.role}`}><FileText size={17}/></span><span><strong>{doc.name}</strong><small>{doc.role==='main'?'正文':'补充材料'} · {doc.pageCount?`${doc.pageCount} 页`:'待读取'}</small></span></button><button className="icon-button file-more" title={`${doc.name} 选项`} onClick={()=>setDocMenu(docMenu===doc.id?null:doc.id)}><MoreHorizontal size={14}/></button>{docMenu===doc.id&&<><div className="menu-dismiss" onClick={()=>setDocMenu(null)}/><div className="file-menu"><button onClick={()=>{setRename(doc);setDocMenu(null);}}><Pencil size={13}/> 重命名</button><button onClick={()=>{setDocMenu(null);void window.folio.updateDocument(workspace.id,doc.id,{role:'main'}).then(update).catch(e=>onError(errorText(e)));}}><BookOpen size={13}/> 设为正文</button><button onClick={()=>{setDocMenu(null);void patch(workspace.id,{layout:{...workspace.layout,rightId:doc.id,split:true}});}}><Columns2 size={13}/> 在第二阅读区打开</button><button className="danger" onClick={()=>removeDoc(doc)}><Trash2 size={13}/> 移除文件</button></div></>}</div>)}</div><button className="add-attachment" onClick={()=>addDocuments()} disabled={busy}><Plus size={15}/> 添加补充材料</button><div className="sidebar-paper-tags">{workspace.tags.map(t=><span key={t}>#{t}</span>)}</div></>:<div className="sidebar-note"><span>THE READING ROOM</span><p>让论文成为知识，<br/>让灵感有处安放。</p><div className="sidebar-note-line"/></div>}
        <div className="sidebar-bottom"><button onClick={()=>setHelp(true)}><HelpCircle size={16}/><span>阅读小贴士</span><kbd>?</kbd></button><button onClick={()=>setSettingsOpen(true)}><Settings2 size={16}/><span>设置与连接</span><kbd>{shortcutLabel(',')}</kbd></button><div className="local-profile"><span className="profile-avatar">F</span><div><strong>我的本地空间</strong><small>Folio {data.version} · {PLATFORM_LABEL}</small></div><span className="local-dot"/></div></div>
      </aside>}
      {workspace&&!sidebar&&!readingLayout.focused&&<aside className="app-rail" aria-label="精简导航"><button className="rail-brand" aria-label="返回文献库" title="返回文献库" onClick={()=>setActiveId(null)}><BookOpen size={21}/></button><button aria-label="文章与补充材料" title="文章与补充材料" onClick={readingLayout.toggleNavigation}><FolderOpen size={19}/></button><button aria-label="全部论文" title="全部论文" onClick={()=>{setActiveId(null);setFilter('all');}}><LibraryBig size={18}/></button><button aria-label="已移除文章" title="已移除文章" onClick={()=>{setActiveId(null);setFilter('removed');}}><Trash2 size={18}/></button><span className="rail-spacer"/><button aria-label="阅读小贴士" title="阅读小贴士" onClick={()=>setHelp(true)}><HelpCircle size={18}/></button><button aria-label="设置与连接" title="设置与连接" onClick={()=>setSettingsOpen(true)}><Settings2 size={18}/></button></aside>}
      <main className={`app-main ${workspace?'reader-main':'library-main'}`}>
        {workspace?<><header className="workspace-topbar"><button className="icon-button" aria-label={sidebar?'收起文章导航':'展开文章导航'} title={sidebar?'收起文章导航':'展开文章导航'} onClick={readingLayout.toggleNavigation}>{sidebar?<PanelLeftClose size={17}/>:<PanelLeftOpen size={17}/>}</button><button className="back-button" onClick={()=>setActiveId(null)}><ArrowLeft size={15}/><span>文献库</span></button><span className="breadcrumb-separator">/</span><button className="workspace-top-title" onClick={()=>setMetadata(true)} title="编辑论文信息">{workspace.title}</button><div className="workspace-top-actions"><button className="icon-button" aria-label="撤销上一步" title={`撤销批注或目录编辑 · ${shortcutLabel('Z')}`} disabled={!documentEdits.canUndo} onMouseDown={event=>event.preventDefault()} onClick={()=>documentEdits.undo('undo',true)}><Undo2 size={16}/></button><button className="icon-button" aria-label="重做上一步" title={`重做 · ${shortcutLabel('⇧ Z')}`} disabled={!documentEdits.canRedo} onMouseDown={event=>event.preventDefault()} onClick={()=>documentEdits.undo('redo',true)}><Redo2 size={16}/></button><button className={`icon-button ${workspace.favorite?'favorite':''}`} title={workspace.favorite?'取消收藏':'收藏论文'} onClick={()=>void patch(workspace.id,{favorite:!workspace.favorite})}><Star size={16} fill={workspace.favorite?'currentColor':'none'}/></button><button className="top-action" title="添加补充材料" onClick={()=>addDocuments()} disabled={busy}>{busy?<LoaderCircle size={15} className="spin"/>:<FilePlus2 size={15}/>}<span>添加 PDF</span></button><span className="action-divider"/><div className="layout-control"><button className={`top-action ${workspace.layout.split?'is-selected':''}`} aria-label="阅读布局" title="选择阅读布局" aria-expanded={layoutMenu} onClick={()=>setLayoutMenu(v=>!v)}>{horizontal&&workspace.layout.split?<Rows2 size={16}/>:<Columns2 size={16}/>}<span>{workspace.layout.split?(horizontal?'上下分割':'左右分割'):'单栏'}</span><ChevronDown size={10}/></button>{layoutMenu&&<><div className="menu-dismiss" onClick={()=>setLayoutMenu(false)}/><div className="layout-menu" role="menu"><span>阅读布局</span><button role="menuitemradio" aria-checked={!workspace.layout.split} onClick={()=>setLayout('none')}><FileText size={16}/><span>单栏阅读<small>专注当前文档</small></span>{!workspace.layout.split&&<Check size={14}/>}</button><button role="menuitemradio" aria-checked={workspace.layout.split&&!horizontal} onClick={()=>setLayout('vertical')}><Columns2 size={16}/><span>纵向分割 · 左右<small>正文与补充材料并排对照</small></span>{workspace.layout.split&&!horizontal&&<Check size={14}/>}</button><button role="menuitemradio" aria-checked={workspace.layout.split&&horizontal} onClick={()=>setLayout('horizontal')}><Rows2 size={16}/><span>横向分割 · 上下<small>保留页面宽度，比较图表与段落</small></span>{workspace.layout.split&&horizontal&&<Check size={14}/>}</button><footer>每个区域都可独立打开同一或不同 PDF</footer></div></>}</div><button className={`top-action focus-toggle ${readingLayout.focused?'is-selected':''}`} aria-label={readingLayout.focused?'退出专注阅读':'专注阅读'} title={`专注阅读 · ${shortcutLabel('⇧ F')}`} aria-pressed={readingLayout.focused} onClick={readingLayout.toggleFocus}>{readingLayout.focused?<Minimize2 size={16}/>:<Maximize2 size={16}/>}<span>{readingLayout.focused?'退出专注':'专注阅读'}</span></button><button className={`top-action ai-toggle ${assistant?'is-selected':''}`} aria-label="阅读伙伴" aria-expanded={assistant} title={`显示 / 隐藏 AI · ${shortcutLabel('J')}`} onClick={readingLayout.toggleAssistant}><Sparkles size={16}/><span>阅读伙伴</span></button></div></header><div className="reader-body" ref={readerBody}><div className="reader-stack"><div ref={setAnnotationHost} role="group" aria-label="共用批注工具栏" data-active-pane={activePane} className={`shared-annotation-host ${data.settings.annotationToolbar??'floating'}`}/><div className={`pdf-columns ${workspace.layout.split?'split':''} ${horizontal?'horizontal':''}`} style={{'--split-ratio':`${workspace.layout.ratio}%`} as React.CSSProperties} ref={paneContainer}>{renderPane('left',left)}{workspace.layout.split&&<><div className="split-divider" role="separator" aria-label="调整分栏宽度" aria-orientation={horizontal?"horizontal":"vertical"} tabIndex={0} onPointerDown={resize} onKeyDown={e=>{if((horizontal?['ArrowUp','ArrowDown']:['ArrowLeft','ArrowRight']).includes(e.key)){e.preventDefault();void patch(workspace.id,{layout:{...workspace.layout,ratio:Math.max(28,Math.min(72,workspace.layout.ratio+(['ArrowRight','ArrowDown'].includes(e.key)?2:-2)))}});}}}><GripVertical size={12}/></div>{renderPane('right',right)}</>}</div><footer className="reader-status"><span><span className="local-dot"/> 阅读进度与笔记保存在本机</span><button onClick={()=>void window.folio.revealWorkspace(workspace.id).catch(e=>onError(errorText(e)))}><FolderOpen size={11}/> 文章文件夹 <ExternalLink size={10}/></button><span>{workspace.documents.length} 个 PDF · {workspace.documents.reduce((n,d)=>n+d.annotations.length,0)} 条批注</span></footer></div>{<div ref={assistantElement} className={`assistant-shell ${assistantDocked?'is-docked':'is-overlay'}`} data-open={assistant} style={{display:assistant?undefined:'none','--assistant-width':`${readingLayout.preferences.assistantWidth}px`} as React.CSSProperties}><div className="assistant-resize-handle" role="separator" aria-label="调整阅读伙伴宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={600} aria-valuenow={readingLayout.preferences.assistantWidth} tabIndex={0} onPointerDown={assistantDocked?resizeAssistant:floatingAssistant.resize} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();readingLayout.resizeAssistant(readingLayout.preferences.assistantWidth+(event.key==='ArrowLeft'?20:-20));}}}/>{readingLayout.preferences.assistantMode==='docked'&&!assistantDocked&&<div className="assistant-space-notice">窗口较窄，阅读伙伴暂时浮出显示</div>}<AssistantPanel key={workspace.id} workspace={workspace} settings={data.settings} selection={selection} focusRequest={askFocus} dragHandleProps={floatingAssistant.dragHandleProps} panelControls={<><button className="fl-icon-button" aria-label={readingLayout.preferences.assistantMode==='docked'?'取消固定阅读伙伴':'固定阅读伙伴'} title={readingLayout.preferences.assistantMode==='docked'?'改为浮出显示':'固定在右侧'} aria-pressed={readingLayout.preferences.assistantMode==='docked'} onClick={readingLayout.toggleDocked}>{readingLayout.preferences.assistantMode==='docked'?<PinOff size={15}/>:<Pin size={15}/>}</button><button className="fl-icon-button" aria-label="关闭阅读伙伴" title="关闭阅读伙伴" onClick={readingLayout.closeAssistant}><X size={16}/></button></>} onClearSelection={()=>setSelection(null)} onWorkspace={update} onSettings={()=>setSettingsOpen(true)} onError={onError} onNavigate={navigate}/></div>}</div></>:<><div className="library-topbar"><div><span className="tiny-app-icon"><Grid2X2 size={14}/></span> LIBRARY <span>/</span> YOUR PERSONAL COLLECTION</div><button onClick={()=>setSettingsOpen(true)}><span className={`connection-dot ${data.settings.providers[data.settings.activeProvider].hasKey?'connected':''}`}/>{data.settings.providers[data.settings.activeProvider].hasKey?'AI 已连接':'连接 DeepSeek'}<ArrowRight size={13}/></button></div>{filter==='removed'?<RemovedArticles items={data.removedWorkspaces} onRestore={restoreRemoved} onPurge={purgeRemoved}/>:<Library workspaces={data.workspaces} onOpen={open} onCreate={()=>create()} onDemo={()=>void run(async()=>{const ws=await window.folio.createDemo();update(ws);open(ws.id);})} onToggleFavorite={ws=>void patch(ws.id,{favorite:!ws.favorite})} onDelete={deleteWorkspace} filter={filter} busy={busy}/>}</>}
      </main>
    </div>
    {dragging&&<div className="drop-overlay"><div><span><Upload size={32}/></span><h2>{workspace?'加入这篇论文的工作区':'开始一篇新的阅读'}</h2><p>松开鼠标，导入 PDF 或文章文件夹</p><small>正文和补充材料可以一起拖入</small></div></div>}
    {settingsOpen&&<SettingsModal settings={data.settings} onClose={()=>setSettingsOpen(false)} onSaved={(settings:Settings)=>{setData(d=>d?{...d,settings}:d);inform('设置已保存');}} onRefresh={()=>void refresh()} onError={onError}/>}
    {metadata&&workspace&&<MetadataModal workspace={workspace} onClose={()=>setMetadata(false)} onSave={async value=>{await patch(workspace.id,value);setMetadata(false);}}/>}
    {rename&&workspace&&<SimpleModal title="重命名 PDF" onClose={()=>setRename(null)}><form onSubmit={e=>{e.preventDefault();const name=String(new FormData(e.currentTarget).get('name')??'').trim();if(name)void run(async()=>{update(await window.folio.updateDocument(workspace.id,rename.id,{name}));setRename(null);});}}><label>显示名称<input name="name" defaultValue={rename.name} autoFocus required/></label><div className="modal-actions"><button type="button" onClick={()=>setRename(null)}>取消</button><button className="primary-button" type="submit">保存</button></div></form></SimpleModal>}
    {confirm&&<SimpleModal title={confirm.title} onClose={()=>setConfirm(null)}><p>{confirm.description}</p><div className="modal-actions"><button onClick={()=>setConfirm(null)}>取消</button><button className="danger-button" disabled={busy} onClick={()=>void run(async()=>{await confirm.action();setConfirm(null);})}>{busy?'处理中…':'确认移除'}</button></div></SimpleModal>}
    {help&&<SimpleModal title="给阅读留一点空间" onClose={()=>setHelp(false)}><div className="help-items"><p><Columns2 size={20}/><span><strong>让正文与证据并排</strong>选择左右或上下分割，在两个阅读区分别选择 PDF。也可以打开同一文件。拖动分隔线调整比例。</span></p><p><Pencil size={20}/><span><strong>在纸页上留下想法</strong>选中文字后可从工具栏或右键菜单添加高亮、下划线、删除线；撤销和重做也适用于目录编辑。</span></p><p><Sparkles size={20}/><span><strong>从一个好问题开始</strong>阅读伙伴默认浮出，不挤压 PDF；可固定到右侧。专注阅读会暂时收起导航与助手，并保留草稿。设置中填写自己的 API Key 后即可提问。</span></p><p><FolderOpen size={20}/><span><strong>把笔记带回自己的知识库</strong>选择 Obsidian 仓库，在「笔记」中导出。设置中的完整备份包含 PDF 和所有阅读记录。</span></p></div><div className="shortcut-list"><span>导入论文 <kbd>{shortcutLabel('O')}</kbd></span><span>文档搜索 <kbd>{shortcutLabel('F')}</kbd></span><span>切换助手 <kbd>{shortcutLabel('J')}</kbd></span><span>专注阅读 <kbd>{shortcutLabel('⇧ F')}</kbd></span><span>撤销编辑 <kbd>{shortcutLabel('Z')}</kbd></span><span>重做编辑 <kbd>{shortcutLabel('⇧ Z')}</kbd></span><span>切换分栏 <kbd>{shortcutLabel('\\')}</kbd></span></div></SimpleModal>}
    {toast&&<div className={`app-toast ${toast.error?'error':''}`} role={toast.error?'alert':'status'}>{toast.error?<HelpCircle size={17}/>:<Check size={17}/>}<span>{toast.text}</span><button onClick={()=>setToast(null)} aria-label="关闭通知"><X size={15}/></button></div>}
  </div>;
}

function SimpleModal({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}){
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{const handler=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();onClose();}};window.addEventListener('keydown',handler);ref.current?.focus();return()=>window.removeEventListener('keydown',handler);},[onClose]);
  return <div className="modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div ref={ref} className="simple-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header><h2>{title}</h2><button className="icon-button" title="关闭" onClick={onClose}><X size={18}/></button></header>{children}</div></div>;
}
function MetadataModal({workspace,onClose,onSave}:{workspace:Workspace;onClose:()=>void;onSave:(value:Partial<Workspace>)=>Promise<void>}){
  const [saving,setSaving]=useState(false);
  return <SimpleModal title="论文信息" onClose={onClose}><form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);setSaving(true);void onSave({title:String(data.get('title')).trim(),authors:String(data.get('authors')),journal:String(data.get('journal')),doi:String(data.get('doi')).trim(),tags:String(data.get('tags')).split(/[,，]/).map(t=>t.trim()).filter(Boolean)}).finally(()=>setSaving(false));}}><label>论文标题<input name="title" defaultValue={workspace.title} required autoFocus/></label><label>作者<input name="authors" defaultValue={workspace.authors} placeholder="作者姓名"/></label><div className="form-row"><label>期刊<input name="journal" defaultValue={workspace.journal}/></label><label>DOI<input name="doi" defaultValue={workspace.doi} placeholder="10.xxxx/…"/></label></div><label>研究标签<input name="tags" defaultValue={workspace.tags.join(', ')} placeholder="用逗号分隔，用于检索与跨文章记忆召回"/></label><div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving?'保存中…':'保存信息'}</button></div></form></SimpleModal>;
}
