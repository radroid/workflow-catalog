/* Reusable quiz + triage widgets. Options must be the same length (words and, where possible, characters) so formatting never leaks the answer.
   Usage: <div class="quiz" data-quiz='{"q":"...","opts":["...","..."],"answer":1,"why":"..."}'></div>
          <div class="quiz" data-triage='{"items":[{"text":"...","verdict":"accept|pushback","why":"..."}]}'></div> */
(function(){
  function el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }
  function quiz(root, cfg){
    root.appendChild(el('p','q',cfg.q));
    const opts = el('div','opts'); root.appendChild(opts);
    const fb = el('div','fb',''); root.appendChild(fb);
    let done=false;
    cfg.opts.forEach((o,i)=>{ const b=el('button',null,o); b.type='button'; b.addEventListener('click',()=>{ if(done) return; done=true; const right = i===cfg.answer; b.dataset.state = right?'right':'wrong'; if(!right) opts.children[cfg.answer].dataset.state='right'; fb.className='fb '+(right?'ok':''); fb.textContent=(right?'Right. ':'Not quite. ')+cfg.why; window.__quizScore && window.__quizScore(right); }); opts.appendChild(b); });
  }
  function triage(root, cfg){
    const list = el('div','opts'); root.appendChild(list); const fb = el('div','fb',''); root.appendChild(fb);
    cfg.items.forEach(item=>{
      const row = el('div','card'); row.style.margin='0'; row.innerHTML = `<div style="margin-bottom:10px">${item.text}</div>`;
      const btns = el('div'); btns.style.display='flex'; btns.style.gap='8px';
      ['accept','pushback'].forEach(v=>{ const b=el('button',null, v==='accept'?'Accept as is':'Push it back'); b.type='button'; b.addEventListener('click',()=>{ if(row.dataset.done) return; row.dataset.done='1'; const right = v===item.verdict; b.dataset.state = right?'right':'wrong'; const note = el('div','fb '+(right?'ok':''), (right?'Right. ':'Not quite. ')+item.why); row.appendChild(note); window.__quizScore && window.__quizScore(right); }); btns.appendChild(b); });
      row.appendChild(btns); list.appendChild(row);
    });
  }
  let right=0,total=0; const scoreEl=document.querySelector('[data-score]');
  window.__quizScore = ok => { total++; if(ok) right++; if(scoreEl) scoreEl.textContent = `${right}/${total} answered correctly`; };
  document.querySelectorAll('.quiz[data-quiz]').forEach(r=>quiz(r, JSON.parse(r.dataset.quiz)));
  document.querySelectorAll('.quiz[data-triage]').forEach(r=>triage(r, JSON.parse(r.dataset.triage)));
})();
