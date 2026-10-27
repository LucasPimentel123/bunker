(() => {
  const params=new URLSearchParams(location.search), preview=document.getElementById('preview');
  const requestedVariant=Number(params.get('v'))||1;
  if(requestedVariant===2&&params.get('full')==='1'){location.replace('guided.html?design=segments');return;}
  let variant=Math.min(5,Math.max(1,Number(params.get('v'))||1)), screen=params.get('screen')==='fees'?'fees':'assets';
  let busy=false, timer;
  const data=window.picnicGuidedInventory, networks=(data?.networks??[]).filter(n=>n.items.length), selected=new Set(networks.map(n=>n.id));
  const steps=['Acesso','Ativos','Taxas','Destino','Retirada'];
  const captions={
    1:'Essencial — DM Sans 38/500, coluna de 620 px. Só a etapa atual junto à pergunta e uma barra fina no topo. A opção mais próxima de um formulário conversacional.',
    2:'Cinco segmentos · refinado com a revisão do Claude — Manrope com mais presença, espaços com hierarquia, escolhas A/B e nenhum cartão repetindo a explicação.',
    3:'Editorial — Georgia 48/400 + DM Sans 16/400. Pergunta à esquerda, resposta à direita; mais personalidade e melhor uso da largura.',
    4:'Trilha lateral — DM Sans 34/500. Etapas em uma margem discreta; a área principal fica livre e o caminho continua visível.',
    5:'Panorâmico — Manrope 32/500, área de 880 px. Etapa atual e próxima no topo; redes em duas colunas, com menos altura e menos rolagem.'
  };
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=()=>networks.filter(n=>selected.has(n.id)).reduce((a,n)=>a+n.items.length,0);
  function sync(){
    const next=new URLSearchParams({v:String(variant),screen});if(params.get('full')==='1')next.set('full','1');history.replaceState(null,'','?'+next);
    document.getElementById('full-link').href=variant===2?'guided.html?design=segments':'?v='+variant+'&screen='+screen+'&full=1';
    document.body.classList.toggle('full',params.get('full')==='1');
  }
  function render(){
    const index=({assets:1,fees:2,funding:2,skipped:2,destination:3,summary:4})[screen],current=steps[index];
    preview.className='preview v'+variant;preview.dataset.screen=screen;document.getElementById('caption').textContent=captions[variant];
    document.querySelectorAll('[data-variant]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.variant)===variant)));
    document.getElementById('screen').value=screen;
    preview.setAttribute('aria-busy','false');
    document.getElementById('header-progress').innerHTML='<div class="current"><b>'+current+'</b><span class="count">'+(index+1)+' / 5</span>'+(variant===5?'<span class="next-label">→ '+steps[index+1]+'</span>':'')+'</div>'+(variant===2?'<div class="segments" aria-label="Etapa '+(index+1)+' de 5">'+steps.map((_,i)=>'<i class="'+(i<index?'complete':i===index?'active':'')+'"></i>').join('')+'</div>':'');
    document.getElementById('local-progress').innerHTML='<span class="count">'+String(index+1).padStart(2,'0')+' / 05</span> <b>'+current+'</b>';
    document.getElementById('rail').innerHTML=steps.map((name,i)=>'<li class="'+(i<index?'complete':i===index?'active':'')+'" '+(i===index?'aria-current="step"':'')+'>'+name+'</li>').join('');
    preview.querySelector('.top-progress').setAttribute('aria-valuenow',String(index+1));preview.querySelector('.top-progress i').style.width=(index+1)*20+'%';
    document.getElementById('question').textContent=screen==='assets'?'O que você quer levar?':'Adicionar saldo agora?';
    document.getElementById('lead').textContent=screen==='assets'?(data?networks.reduce((a,n)=>a+n.items.length,0)+' ativos em '+networks.length+' redes. Escolha o que quer retirar.':'O retrato de ativos não está disponível nesta instalação.'):'Para retirar na Gnosis, a carteira que paga as taxas precisa de xDAI.';
    if(variant===2&&screen==='fees'){document.getElementById('question').innerHTML='Adicionar xDAI<br>para retirar na Gnosis?';document.getElementById('lead').textContent='Esse saldo paga a taxa de rede da retirada.';}
    preview.querySelector('.study-note').textContent=variant===2&&screen==='fees'?'Estudo de design · cenário de saldo insuficiente · nenhuma carteira consultada, nenhum ativo movimentado.':'Estudo de design · sem movimentações';
    const answers=document.getElementById('answers');
    if(screen==='assets')answers.innerHTML='<div class="network-list">'+networks.map(n=>'<label class="network"><input type="checkbox" data-network="'+escape(n.id)+'" '+(selected.has(n.id)?'checked':'')+'><span class="logo">'+(window.picnicGuidedIcons?.networks[n.id]??'')+'</span><span class="name">'+escape(n.name)+'</span><span class="quantity">'+n.items.length+' '+(n.items.length===1?'ativo':'ativos')+'</span></label>').join('')+'</div>'+(networks.some(n=>n.status!=='complete')?'<p class="pending">Gnosis · consulta parcial no retrato de dados.</p>':'')+'<div class="cta"><button class="primary" id="continue" '+(!count()?'disabled':'')+'>Levar '+count()+' ativos</button><span class="enter">pressione Enter ↵</span></div><details><summary>Ver endereço e detalhes</summary><p>Safe do teste: '+escape(data?.account??'não carregada')+'<br>Retrato de '+escape(data?new Date(data.checkedAt).toLocaleString('pt-BR'):'data indisponível')+'. Nenhuma consulta ou retirada é executada neste estudo.</p></details>';
    else if(variant===2&&screen==='fees')answers.innerHTML='<div class="decision-options" role="group" aria-label="Como seguir com as taxas"><button class="decision-option" id="fund" aria-pressed="false"><span class="choice-key" aria-hidden="true">A</span><span>Adicionar xDAI</span><span class="choice-check" aria-hidden="true">✓</span></button><button class="decision-option" id="skip" aria-pressed="false"><span class="choice-key" aria-hidden="true">B</span><span>Pular esta rede por enquanto</span><span class="choice-check" aria-hidden="true">✓</span></button></div><p class="decision-consequence">Se pular, os ativos na Gnosis ficam onde estão.</p><p class="decision-help" id="feedback" role="status">Escolha para testar o fluxo com conexão e consulta reais.</p>';
    else answers.innerHTML='<div class="deposit"><strong>Taxas na Gnosis</strong><p>Envie xDAI pela rede Gnosis para a carteira que paga as taxas.</p></div><div class="fee-choices"><button class="primary" id="fund">Adicionar saldo</button><button class="text-action" id="skip">Deixar para depois</button></div><p class="pending" id="feedback" role="status">Cenário visual de saldo insuficiente; nenhuma carteira foi consultada.</p>';
    document.getElementById('previous').disabled=screen==='assets';document.getElementById('next').disabled=!canNext();sync();
  }
  function canNext(){return screen==='assets'&&count()>0;}
  function stop(){clearTimeout(timer);busy=false;}
  function back(){screen='assets';render();}
  function advance(){if(canNext()){screen='fees';render();}}
  document.querySelector('.options').addEventListener('click',e=>{const b=e.target.closest('[data-variant]');if(b){stop();variant=Number(b.dataset.variant);if(variant!==2&&!['assets','fees'].includes(screen))screen='fees';render();}});
  document.getElementById('screen').addEventListener('change',e=>{stop();screen=e.target.value;render();});
  document.getElementById('answers').addEventListener('change',e=>{const id=e.target.dataset.network;if(!id||busy)return;e.target.checked?selected.add(id):selected.delete(id);const b=document.getElementById('continue');b.textContent='Levar '+count()+' ativos';b.disabled=!count();document.getElementById('next').disabled=!canNext();});
  document.getElementById('answers').addEventListener('click',e=>{
    if(busy)return;const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.id==='continue'){advance();return;}
    if(b.id==='restart-study'){stop();screen='assets';render();return;}
    if(variant===2&&['fund','skip'].includes(b.id)){location.assign('guided.html?design=segments');return;}
    if(b.id==='fund')document.getElementById('feedback').textContent='Na próxima tela do fluxo, você veria o endereço da carteira para copiar.';
    if(b.id==='skip')document.getElementById('feedback').textContent='Os ativos dessa rede ficariam na origem. Este estudo não movimenta dinheiro.';
  });
  document.addEventListener('keydown',e=>{
    if(variant!==2||busy||e.repeat||e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.target.closest('input,select,textarea'))return;
    const id=screen==='fees'?{a:'fund',b:'skip'}[e.key.toLowerCase()]:undefined;
    if(id){e.preventDefault();document.getElementById(id).click();}
    else if(e.key==='Enter'&&!e.target.closest('button,summary')){e.preventDefault();advance();}
  });
  document.getElementById('previous').addEventListener('click',back);
  document.getElementById('next').addEventListener('click',advance);
  render();
})();
