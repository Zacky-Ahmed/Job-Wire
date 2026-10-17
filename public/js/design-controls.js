(() => {
 let open=null, counter=0;
 const chevron='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
 function close(refocus=false){if(!open)return;const {button,panel}=open;panel.remove();button.setAttribute('aria-expanded','false');open=null;if(refocus)button.focus()}
 function enhance(select){
  if(select.dataset.enhanced)return;select.dataset.enhanced='true';
  const wrapper=document.createElement('span');wrapper.className='select-control';
  const button=document.createElement('button');button.type='button';button.className='select-trigger';
  const label=select.getAttribute('aria-label')||select.closest('label')?.childNodes[0]?.textContent.trim()||'Choose option';
  button.setAttribute('aria-label',label);button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
  const id='select-list-'+(++counter);button.setAttribute('aria-controls',id);
  select.before(wrapper);wrapper.append(select,button);select.hidden=true;select.tabIndex=-1;select.setAttribute('aria-hidden','true');
  const sync=()=>{button.innerHTML='<span>'+String(select.options[select.selectedIndex]?.textContent||'Choose option').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</span>'+chevron;button.disabled=select.disabled};sync();select.addEventListener('invalid',()=>button.focus());select.addEventListener('change',sync);
  function show(last=false){
   if(open?.button===button){close();return}close();
   const panel=document.createElement('div');panel.className='select-popover';panel.id=id;panel.setAttribute('role','listbox');panel.setAttribute('aria-label',label);
   const items=[...select.options].map((option,index)=>{const item=document.createElement('button');item.type='button';item.className='select-option';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.disabled=option.disabled;item.tabIndex=-1;const text=document.createElement('span');text.textContent=option.textContent;const check=document.createElement('span');check.className='select-check';check.textContent=option.selected?'✓':'';item.append(text,check);item.onclick=()=>{select.selectedIndex=index;sync();close(true);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}))};panel.append(item);return item});
   (select.closest('dialog')||document.body).append(panel);open={button,panel};button.setAttribute('aria-expanded','true');
   const rect=button.getBoundingClientRect();panel.style.width=Math.min(Math.max(rect.width,230),innerWidth-24)+'px';panel.style.left=Math.min(Math.max(12,rect.left),innerWidth-panel.offsetWidth-12)+'px';
   const height=Math.min(panel.scrollHeight,300);panel.style.top=(rect.bottom+height+12>innerHeight?Math.max(12,rect.top-height-8):rect.bottom+8)+'px';
   let active=last?items.length-1:Math.max(0,select.selectedIndex);items[active]?.focus();let typed='',timer;
   panel.onkeydown=e=>{const valid=items.filter(x=>!x.disabled);let pos=valid.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();pos=e.key==='Home'?0:e.key==='End'?valid.length-1:(pos+(e.key==='ArrowDown'?1:-1)+valid.length)%valid.length;valid[pos]?.focus()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true)}
    else if(e.key==='Tab'){close(true)}
    else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&e.key!==' '){typed+=e.key.toLowerCase();clearTimeout(timer);timer=setTimeout(()=>typed='',600);valid.find(x=>x.textContent.toLowerCase().startsWith(typed))?.focus()}
   };
  }
  button.onclick=()=>show();button.onkeydown=e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();show(e.key==='ArrowUp')}};
 }
 function scan(){document.querySelectorAll('select:not([data-enhanced]):not([multiple])').forEach(enhance);if(open&&!open.button.isConnected)close()}
 new MutationObserver(scan).observe(document.getElementById('workspaceMain'),{childList:true,subtree:true});
 document.addEventListener('pointerdown',e=>{if(open&&!open.panel.contains(e.target)&&!open.button.contains(e.target))close()});
 window.addEventListener('resize',()=>close());window.addEventListener('scroll',e=>{if(open&&!open.panel.contains(e.target))close()},{capture:true});window.addEventListener('hashchange',()=>close());scan();
})();

