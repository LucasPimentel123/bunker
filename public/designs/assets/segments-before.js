(() => {
  const params=new URLSearchParams(location.search), preview=document.getElementById('preview');
  let variant=Math.min(5,Math.max(1,Number(params.get('v'))||1)), screen=params.get('screen')==='fees'?'fees':'assets';
  const data=window.picnicGuidedInventory, networks=(data?.networks??[]).filter(n=>n.items.length), selected=new Set(networks.map(n=>n.id));
  const steps=['Acesso','Ativos','Taxas','Destino','Retirada'];
  const captions={
    1:'Essencial — DM Sans 38/500, coluna de 620 px. Só a etapa atual junto à pergunta e uma barra fina no topo. A opção mais próxima de um formulário conversacional.',
    2:'Cinco segmentos — Manrope 36/500, coluna de 700 px. Cinco traços no canto superior direito mostram o caminho sem uma fila de breadcrumbs.',
    3:'Editorial — Georgia 48/400 + DM Sans 16/400. Pergunta à esquerda, resposta à direita; mais personalidade e melhor uso da largura.',
    4:'Trilha lateral — DM Sans 34/500. Etapas em uma margem discreta; a área principal fica livre e o caminho continua visível.',
    5:'Panorâmico — Manrope 32/500, área de 880 px. Etapa atual e próxima no topo; redes em duas colunas, com menos altura e menos rolagem.'
  };
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=()=>networks.filter(n=>selected.has(n.id)).reduce((a,n)=>a+n.items.length,0);
  function sync(){
    const next=new URLSearchParams({v:String(variant),screen});if(params.get('full')==='1')next.set('full','1');history.replaceState(null,'','?'+next);
    document.getElementById('full-link').href='?v='+variant+'&screen='+screen+'&full=1';
    document.body.classList.toggle('full',params.get('full')==='1');
  }
  function render(){
    const index=screen==='assets'?1:2,current=steps[index];
    preview.className='preview v'+variant;document.getElementById('caption').textContent=captions[variant];
    document.querySelectorAll('[data-variant]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.variant)===variant)));
    document.getElementById('screen').value=screen;
    document.getElementById('header-progress').innerHTML='<div class="current"><b>'+current+'</b><span class="count">'+(index+1)+' / 5</span>'+(variant===5?'<span class="next-label">→ '+steps[index+1]+'</span>':'')+'</div>'+(variant===2?'<div class="segments" aria-label="Etapa '+(index+1)+' de 5">'+steps.map((_,i)=>'<i class="'+(i<index?'complete':i===index?'active':'')+'"></i>').join('')+'</div>':'');
    document.getElementById('local-progress').innerHTML='<span class="count">'+String(index+1).padStart(2,'0')+' / 05</span> <b>'+current+'</b>';
    document.getElementById('rail').innerHTML=steps.map((name,i)=>'<li class="'+(i<index?'complete':i===index?'active':'')+'" '+(i===index?'aria-current="step"':'')+'>'+name+'</li>').join('');
    preview.querySelector('.top-progress').setAttribute('aria-valuenow',String(index+1));preview.querySelector('.top-progress i').style.width=(index+1)*20+'%';
    document.getElementById('question').textContent=screen==='assets'?'O que você quer levar?':'Adicionar saldo agora?';
    document.getElementById('lead').textContent=screen==='assets'?(data?networks.reduce((a,n)=>a+n.items.length,0)+' ativos em '+networks.length+' redes. Escolha o que quer retirar.':'O retrato de ativos não está disponível nesta instalação.'):'Para retirar na Gnosis, a carteira que paga as taxas precisa de xDAI.';
    const answers=document.getElementById('answers');
    if(screen==='assets')answers.innerHTML='<div class="network-list">'+networks.map(n=>'<label class="network"><input type="checkbox" data-network="'+escape(n.id)+'" '+(selected.has(n.id)?'checked':'')+'><span class="logo">'+(window.picnicGuidedIcons?.networks[n.id]??'')+'</span><span class="name">'+escape(n.name)+'</span><span class="quantity">'+n.items.length+' '+(n.items.length===1?'ativo':'ativos')+'</span></label>').join('')+'</div>'+(networks.some(n=>n.status!=='complete')?'<p class="pending">Gnosis · consulta parcial no retrato de dados.</p>':'')+'<div class="cta"><button class="primary" id="continue" '+(!count()?'disabled':'')+'>Levar '+count()+' ativos</button><span class="enter">pressione Enter ↵</span></div><details><summary>Ver endereço e detalhes</summary><p>Safe do teste: '+escape(data?.account??'não carregada')+'<br>Retrato de '+escape(data?new Date(data.checkedAt).toLocaleString('pt-BR'):'data indisponível')+'. Nenhuma consulta ou retirada é executada neste estudo.</p></details>';
    else answers.innerHTML='<div class="deposit"><strong>Taxas na Gnosis</strong><p>Envie xDAI pela rede Gnosis para a carteira que paga as taxas.</p></div><div class="fee-choices"><button class="primary" id="fund">Adicionar saldo</button><button class="text-action" id="skip">Deixar para depois</button></div><p class="pending" id="feedback" role="status">Cenário visual de saldo insuficiente; nenhuma carteira foi consultada.</p>';
    document.getElementById('previous').disabled=screen==='assets';document.getElementById('next').disabled=screen==='fees'||!count();sync();
  }
  document.querySelector('.options').addEventListener('click',e=>{const b=e.target.closest('[data-variant]');if(b){variant=Number(b.dataset.variant);render();}});
  document.getElementById('screen').addEventListener('change',e=>{screen=e.target.value;render();});
  document.getElementById('answers').addEventListener('change',e=>{const id=e.target.dataset.network;if(!id)return;e.target.checked?selected.add(id):selected.delete(id);const b=document.getElementById('continue');b.textContent='Levar '+count()+' ativos';b.disabled=!count();document.getElementById('next').disabled=!count();});
  document.getElementById('answers').addEventListener('click',e=>{if(e.target.id==='continue'&&count()){screen='fees';render();}if(e.target.id==='fund')document.getElementById('feedback').textContent='Na próxima tela do fluxo, você veria o endereço da carteira para copiar.';if(e.target.id==='skip')document.getElementById('feedback').textContent='Os ativos dessa rede ficariam na origem. Este estudo não movimenta dinheiro.';});
  document.getElementById('previous').addEventListener('click',()=>{screen='assets';render();});
  document.getElementById('next').addEventListener('click',()=>{if(count()){screen='fees';render();}});
  render();
})();
