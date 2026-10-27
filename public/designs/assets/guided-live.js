/* Verified discovery, wallet/gas checks and explicit guardian recovery.
   Passkey identification signs a local discovery challenge. Asset withdrawals remain demonstrative. */
(() => {
  const root = document.getElementById('picnic-one-step'), scene = root.querySelector('.pb-scene'), back = root.querySelector('.pb-back'), forward = root.querySelector('.pb-forward');
  const marks = window.picnicGuidedIcons;
  let inventory, networks = [], available = [], source, sourceAbort, walletConnectAbort, detachSource = () => {};
  const rpcUrls = {1:'https://eth.drpc.org',10:'https://mainnet.optimism.io',56:'https://bsc-dataseed.bnbchain.org',100:'https://rpc.gnosischain.com',137:'https://polygon.drpc.org',8453:'https://mainnet.base.org',42161:'https://arb1.arbitrum.io/rpc',43114:'https://api.avax.network/ext/bc/C/rpc',999:'https://rpc.hyperliquid.xyz/evm',4663:'https://rpc.mainnet.chain.robinhood.com'};
  const state = {screen:'access',accessCheck:undefined,recoveryTarget:'',recovery:undefined,recoveryOwner:'',recoveryIndex:0,recoverySkipped:new Set(),recoveryExcluded:new Set(),recoverySending:false,recoveryMessage:'',walletConnect:undefined,method:'passkey',passkeyHint:undefined,passkeyReady:false,discoveryMessage:'',sourceWallet:'',sourceProvider:undefined,sourceName:'',candidates:[],discoveryIssues:[],scanDone:0,scanTotal:10,selected:new Set(available.map(n=>n.id)),skipped:new Set(),destination:'',payer:'',walletName:'',provider:undefined,busy:false,sent:0,epoch:0,gas:{},funding:undefined,error:''};
  let legacyWalletId=0;
  const providers = new Map(), timers = new Set(), history = [];
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const copyIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  const copiedIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  const short = value => value ? value.slice(0,6)+'…'+value.slice(-4) : '';
  const selected = () => available.filter(n=>state.selected.has(n.id));
  const count = () => selected().reduce((sum,n)=>sum+n.items.length,0);
  const chain = n => `<span class="pb-real-chain">${marks?.networks[n.id] ?? ''}</span>`;
  const eyebrow = text => `<p class="pb-eyebrow"><span class="pb-dot"></span>${escape(text)}</p>`;
  const action = (label,disabled=false) => `<div class="pb-actions"><button class="pb-primary" type="button" data-action="next" ${disabled?'disabled':''}>${escape(label)}</button><span class="pb-enter">pressione Enter ↵</span></div>`;
  const stage = () => ({access:0,'connect-source':0,'passkey-discover':0,'passkey-confirm':0,discover:0,'check-access':0,'recover-access':0,'recovery-loading':0,'recovery-owner':0,'recovery-network':0,'recovery-overview':0,account:0,'no-account':0,scan:1,assets:1,fees:2,fund:2,skipped:2,destination:3,move:4,done:4}[state.screen]);
  const hasPayer=()=>!!state.provider&&/^0x[a-f0-9]{40}$/i.test(state.payer)&&!/^0x0{39}[01]$/i.test(state.payer);
  const gasFor=id=>state.gas[id]?.payer?.toLowerCase()===state.payer.toLowerCase()?state.gas[id]:undefined;
  const unresolved = () => selected().filter(n=>gasFor(n.id)?.status!=='available');
  const ready=()=>!!inventory&&hasPayer()&&selected().length>0&&!unresolved().length;
  const canFund=()=>hasPayer()&&state.selected.has(state.funding)&&gasFor(state.funding)?.status==='empty';
  function amount(value){const n=Number(value);return !Number.isFinite(n)?escape(value):n>0&&n<0.000001?'&lt; 0,000001':n.toLocaleString('pt-BR',{maximumFractionDigits:6});}
  function nativeAmount(value){const s=value.toString().padStart(19,'0');return amount(s.slice(0,-18)+'.'+s.slice(-18));}
  function cancel(){walletConnectAbort?.abort();walletConnectAbort=undefined;state.walletConnect=undefined;root.classList.remove('pb-answer-leaving','pb-answer-entering');sourceAbort?.abort();sourceAbort=undefined;timers.forEach(clearTimeout);timers.clear();state.epoch++;}
  function later(fn,ms){const epoch=state.epoch;const id=setTimeout(()=>{timers.delete(id);if(epoch===state.epoch)fn();},ms);timers.add(id);}
  function syncForward(){
    forward.disabled=state.busy||!(state.screen==='recovery-owner'&&!recoveryOwnerError()||state.screen==='assets'&&count()>0||state.screen==='fees'&&state.payer&&selected().length&&!unresolved().length||state.screen==='destination'&&validDestination()&&state.payer&&!unresolved().length);
    forward.setAttribute('aria-label',forward.disabled?'Conclua a decisão desta tela para continuar':'Próxima pergunta');
  }
  function chrome(){
    const index=stage(),done=state.screen==='done';
    root.querySelectorAll('.pb-road>span').forEach((el,i)=>{if(i===index&&!done)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');el.querySelector('b').textContent=i<index||done?'✓':String(i+1);});
    const value=done?100:state.screen==='move'?80+20*state.sent/Math.max(selected().length,1):index*20;
    root.querySelector('.pb-track').setAttribute('aria-valuenow',String(Math.round(value)));
    root.querySelector('.pb-track').setAttribute('aria-valuetext',done?'Prévia concluída':`Etapa ${index+1} de 5`);
    root.querySelector('.pb-fill').style.width=(value||3)+'%';
    const stepName=['Acesso','Ativos','Taxas','Destino','Retirada'][index];
    root.querySelector('.pb-step-label').textContent=done?'Concluído':stepName;
    root.querySelector('.pb-step-count').textContent=done?'5 / 5':`${index+1} / 5`;
    root.querySelector('.pb-segments').innerHTML=[0,1,2,3,4].map(i=>`<i class="${done||i<index?'complete':i===index?'active':''}"></i>`).join('');
    root.querySelector('.pb-step-progress').setAttribute('aria-label',done?'Demonstração concluída':`${stepName}, etapa ${index+1} de 5`);
    back.disabled=state.screen==='access'||state.recoverySending;
    back.querySelector('.pb-nav-tip').textContent=state.screen==='done'?'Rever escolhas':state.busy?'Cancelar e voltar':'Voltar';
    syncForward();
    back.setAttribute('aria-label',state.screen==='done'?'Rever escolhas':state.busy?'Cancelar espera e voltar':'Voltar à decisão anterior');
  }
  const walletLine = () => `<div class="pb-wallet-line"><span>Carteira que paga as taxas<small>${escape(state.walletName)} · ${escape(state.payer)}</small></span><button type="button" class="pb-link" data-action="change-wallet" ${state.busy?'disabled':''}>Trocar</button></div>`;
  function walletIcon(w){
    const icon=typeof w.icon==='string'&&w.icon.length<200000&&/^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(w.icon)?w.icon:({rabby:'assets/wallets/rabby.svg',phantom:'assets/wallets/phantom.svg',metamask:'assets/wallets/metamask.svg',coinbase:'assets/wallets/coinbase.svg',brave:'assets/wallets/brave.svg'})[w.brand]??'';
    return `<span class="pb-wallet-icon" aria-hidden="true">${icon?`<img src="${escape(icon)}" alt="" width="36" height="36">`:marks?.ui.wallet??'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M16 11h5v5h-5a2.5 2.5 0 0 1 0-5Z"/></svg>'}</span>`;
  }
  function isWalletChoiceScreen(){return state.screen==='connect-source'||state.screen==='fees'&&!state.payer;}
  function walletBrand(provider,info={}){
    const domains={'io.rabby':'rabby','io.metamask':'metamask','app.phantom':'phantom','com.coinbase.wallet':'coinbase','com.brave.wallet':'brave'};
    if(info.rdns)return domains[info.rdns]??'rdns:'+info.rdns;
    // Most injected wallets also claim isMetaMask; check their own flag first.
    if(provider.isRabby)return 'rabby';if(provider.isPhantom)return 'phantom';if(provider.isCoinbaseWallet)return 'coinbase';if(provider.isBraveWallet)return 'brave';if(provider.isMetaMask)return 'metamask';
    return ({rabby:'rabby','rabby wallet':'rabby',metamask:'metamask',phantom:'phantom','phantom wallet':'phantom','coinbase wallet':'coinbase','brave wallet':'brave'})[info.name?.toLowerCase()]??'';
  }
  function collectInjectedWallets(){
    let changed=false;
    try{
      const injected=window.ethereum;
      const candidates=Array.isArray(injected?.providers)&&injected.providers.length?injected.providers:[injected];
      for(const provider of candidates){try{
        if(!provider?.request||provider.isWalletConnect)continue;
        const brand=walletBrand(provider);
        if([...providers.values()].some(w=>w.provider===provider||brand&&w.brand===brand))continue;
        const name=({rabby:'Rabby Wallet',phantom:'Phantom',coinbase:'Coinbase Wallet',brave:'Brave Wallet',metamask:'MetaMask'})[brand]??'Carteira do navegador';
        providers.set('legacy-'+(++legacyWalletId),{provider,name,brand,legacy:true});changed=true;
      }catch{/* One broken injected getter must not hide other wallets. */}}
    }catch{/* EIP-6963 still works when the global ethereum getter throws. */}
    return changed;
  }
  function announceWallet(event){
    const d=event.detail;if(!d?.info?.uuid||!d?.provider?.request||typeof d.info.name!=='string')return;
    let brand='';try{brand=walletBrand(d.provider,d.info);}catch{}
    const id='eip6963:'+d.info.uuid,existing=providers.get(id);
    if(existing?.provider===d.provider&&existing.name===d.info.name&&existing.icon===d.info.icon&&existing.brand===brand)return;
    for(const [key,w] of providers){if(key!==id&&(w.provider===d.provider||brand&&w.brand===brand))providers.delete(key);}
    providers.set(id,{provider:d.provider,name:d.info.name,icon:d.info.icon,brand});
    if(!state.busy&&isWalletChoiceScreen())render();
  }
  function refreshWalletDiscovery(){
    const changed=collectInjectedWallets();
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    if(changed&&!state.busy&&isWalletChoiceScreen())render();
  }
  function beginWalletDiscovery(){
    refreshWalletDiscovery();
    // Some extensions inject after page scripts, or only after the tab gains focus.
    for(const ms of [250,1000,3000])later(()=>{if(isWalletChoiceScreen())refreshWalletDiscovery();},ms);
  }
  function walletChoices(forSource=false){
    if(state.walletConnect)return `<div class="pb-qr-wallet">${state.walletConnect.qr?`<img class="pb-wallet-qr" src="${escape(state.walletConnect.qr)}" width="288" height="288" alt="QR code WalletConnect"><p class="pb-note">Escaneie com sua carteira ou abra neste dispositivo.</p><div class="pb-actions"><a class="pb-primary pb-open-wallet" href="${escape(state.walletConnect.uri)}">Abrir carteira</a><button class="pb-link" data-action="copy-qr">Copiar conexão</button></div>`:'<p role="status">Preparando o QR code…</p><div class="pb-mini-track"><div class="pb-mini-fill pb-indeterminate" style="width:30%"></div></div>'}<button class="pb-link" data-action="cancel-qr">Cancelar conexão</button></div>`;
    collectInjectedWallets();
    return `<div class="pb-wallet-options">${[...providers].filter(([id])=>id!=='walletconnect').sort(([,a],[,b])=>Number(a.name==='Carteira do navegador')-Number(b.name==='Carteira do navegador')).map(([id,w])=>`<button type="button" class="pb-choice pb-wallet-choice" ${forSource?'data-source-provider':'data-provider'}="${escape(id)}" ${state.busy?'disabled':''}>${walletIcon(w)}<span><strong>${escape(w.name)}</strong><small>${forSource?'Conectar para encontrar sua conta':'Conectar para pagar as taxas'}</small></span></button>`).join('')}<button type="button" class="pb-choice pb-wallet-choice" data-action="walletconnect" data-source="${forSource?'yes':'no'}" ${state.busy?'disabled':''}><span class="pb-wallet-icon pb-walletconnect-icon" aria-hidden="true"><svg viewBox="0 0 32 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8a15 15 0 0 1 22 0M2 13l7 7 7-7 7 7 7-7"/></svg></span><span><strong>Outra carteira</strong><small>Conectar com QR code · WalletConnect</small></span></button></div>${![...providers.keys()].some(id=>id!=='walletconnect')?'<p class="pb-note">Nenhuma extensão detectada neste navegador ainda. <button type="button" class="pb-link" data-action="find-wallets">Buscar carteiras instaladas</button></p>':''}`;
  }
  async function connectQr(forSource){
    if(state.busy)return;const epoch=state.epoch;state.busy=true;state.error='';state.walletConnect={};walletConnectAbort=new AbortController();const signal=AbortSignal.any([walletConnectAbort.signal,AbortSignal.timeout(180000)]);render();
    try{const {connectQrWallet}=await import('./runtime/guided-wallet.js');if(epoch!==state.epoch)return;const provider=await connectQrWallet(signal,(uri,qr)=>{if(epoch===state.epoch){state.walletConnect={uri,qr};render();}});if(epoch!==state.epoch){void provider.disconnect();return;}
      walletConnectAbort=undefined;state.walletConnect=undefined;state.busy=false;
      // Connection already authorized via QR. Reuse the same account checks as extensions.
      const wrapped={request:args=>args.method==='eth_requestAccounts'?Promise.resolve(provider.accounts):provider.request(args),on:(...args)=>provider.on(...args),removeListener:(...args)=>provider.removeListener(...args)};
      providers.set('walletconnect',{provider:wrapped,name:provider.session?.peer?.metadata?.name||'WalletConnect'});
      if(forSource)await connectSource('walletconnect');else await connectWallet('walletconnect');
    }catch(error){if(epoch===state.epoch){walletConnectAbort=undefined;state.walletConnect=undefined;state.busy=false;state.error=error.name==='TimeoutError'?'O QR code expirou. Abra outra conexão.':'A conexão não foi concluída. Tente novamente.';render();}}
  }
  function fees(){
    if(state.walletConnect)return eyebrow('Conectar carteira')+`<h2>Abra sua carteira no celular.</h2>${walletChoices()}`;
    if(!state.payer)return eyebrow('Carteira para as taxas')+`<h2>${state.method==='passkey'?'Sua passkey assina.<br>Uma carteira paga as taxas.':'Qual carteira paga as taxas?'}</h2><p class="pb-lead">Conecte uma carteira externa com saldo para as taxas.</p>${walletChoices()}${state.busy?'<p role="status">Confirme a conexão na sua carteira…</p>':''}<p class="pb-note">A conexão só compartilha seu endereço. Não pede assinatura nem movimenta dinheiro.</p>`;
    if(state.busy)return eyebrow('Conferindo as taxas')+`<h2>Vamos conferir<br>o saldo de gás.</h2><p class="pb-lead">Consultando as ${selected().length} redes da carteira conectada.</p>${walletLine()}<p role="status" class="pb-status">${selected().filter(n=>state.gas[n.id]).length} de ${selected().length} redes consultadas…</p>`;
    const missing=unresolved()[0];
    if(missing){
      const failed=gasFor(missing.id)?.status!=='empty',symbol=missing.symbol==='XDAI'?'xDAI':missing.symbol;
      return `<section class="pb-gas-step"><div class="pb-gas-context">${chain(missing)}<span>${escape(missing.name)}</span><span class="pb-gas-meta">${missing.items.length} ativos selecionados</span></div><h2>${failed?'Vamos conferir as taxas?':'Adicionar saldo agora?'}</h2><p class="pb-lead">${failed?'Não conseguimos consultar o saldo desta rede. Tente novamente ou deixe esta rede para depois.':`Para retirar na ${escape(missing.name)}, a carteira que paga as taxas precisa de ${escape(symbol)}.`}</p><div class="pb-payer-compact"><div><span class="pb-gas-label">Carteira para as taxas · ${escape(state.walletName)}</span><details><summary>${escape(short(state.payer))}</summary><p class="pb-source-address">${escape(state.payer)}</p></details></div><button type="button" class="pb-link" data-action="change-wallet">Trocar</button>${!failed?`<span class="pb-gas-balance">0 ${escape(symbol)}</span>`:''}</div><div class="pb-decision-options"><button type="button" class="pb-decision" data-action="${failed?'retry-gas':'fund'}"><span>${failed?'Conferir novamente':`Adicionar ${escape(symbol)}`}</span></button><button type="button" class="pb-decision" data-action="skip"><span>Pular esta rede por enquanto</span></button></div><p class="pb-note">Se deixar para depois, os ${missing.items.length} ativos desta rede continuam na sua Safe.</p></section>`;
    }
    return eyebrow('Saldo para taxas encontrado')+`<h2>Há saldo para taxas.</h2><p class="pb-lead">Encontramos moeda nativa nas ${selected().length} redes selecionadas. O custo final precisa ser estimado antes de enviar.</p>${walletLine()}<details><summary>Ver saldos para taxas</summary>${selected().map(n=>`<p>${escape(n.name)} · ${nativeAmount(state.gas[n.id].balance)} ${escape(n.symbol)}</p>`).join('')}</details>${action('Escolher destino')}`;
  }
  function render(){
    root.dataset.screen=state.screen;
    const guarded=guard(state.screen);if(guarded!==state.screen){cancel();state.busy=false;state.screen=guarded;}
    const focusedWallet=scene.contains?.(document.activeElement)&&document.activeElement?.dataset?.sourceProvider||scene.contains?.(document.activeElement)&&document.activeElement?.dataset?.provider;
    const restoreFocus=scene.contains?.(document.activeElement);
    chrome();
    if(state.screen==='access')scene.innerHTML=eyebrow('Recupere sua conta')+`<h2>Como você quer<br>recuperar sua conta?</h2><p class="pb-lead">Escolha o que você tem em mãos.</p><div class="pb-choices"><button type="button" class="pb-choice" data-method="wallet"><span class="pb-choice-head">${marks?.ui.wallet??''}</span><span><strong>Com uma carteira</strong><small>Uma carteira vinculada à sua conta</small></span></button><button type="button" class="pb-choice" data-method="passkey"><span class="pb-choice-head">${marks?.ui['key-round']??''}</span><span><strong>Com uma passkey</strong><small>Digital, Face ID ou gerenciador de senhas. Você também precisará de uma carteira para pagar as taxas.</small></span></button></div><p><button type="button" class="pb-link" data-method="security-key">Com uma chave de segurança (YubiKey)</button></p><details class="pb-magic-help"><summary>Entrava com e-mail?</summary><p>Exporte sua carteira pela Magic, importe em uma carteira externa e volte para escolher “Com uma carteira”.</p><p class="pb-note">O link da Picnic na Magic ainda não está confirmado nesta prévia.</p></details><p class="pb-note">A identificação e a recuperação de acesso são reais. A retirada continua demonstrativa.</p>`;
    if(state.screen==='connect-source')scene.innerHTML=eyebrow('Acesso · carteira externa')+`<h2>Qual carteira você quer usar?</h2><p class="pb-lead">Conecte a carteira vinculada à sua conta Picnic. Vamos procurar suas contas e seus ativos.</p>${walletChoices(true)}${state.busy?'<p role="status" class="pb-note">Confirme a conexão na carteira. Você pode cancelar aqui enquanto espera.</p>':''}<p class="pb-note">A conexão compartilha seu endereço. Não pede assinatura.</p>`;
    if(state.screen==='discover'||state.screen==='scan')scene.innerHTML=eyebrow(state.screen==='discover'?'Identificando sua conta':'Consultando os ativos')+`<h2>${state.screen==='discover'?'Procurando sua conta.':'Buscando seus ativos.'}</h2><p class="pb-lead">${state.screen==='discover'?'Verificando as contas vinculadas à carteira que você conectou.':'Consultando todas as redes da Safe identificada.'}</p><p class="pb-source-address">${escape(state.screen==='discover'?state.sourceWallet:source)}</p><div class="pb-mini-track" role="progressbar" aria-label="Consulta das redes" ${state.screen==='scan'?`aria-valuenow="${state.scanDone}" aria-valuemax="${state.scanTotal}" aria-valuemin="0"`:''}><div class="pb-mini-fill ${state.screen==='discover'?'pb-indeterminate':''}" style="width:${state.screen==='discover'?30:100*state.scanDone/state.scanTotal}%"></div></div><p class="pb-status" role="status">${state.screen==='discover'?'A descoberta pode levar alguns minutos. Você pode cancelar e voltar.':`${state.scanDone} de ${state.scanTotal} redes consultadas`}</p>`;
    if(state.screen==='check-access')scene.innerHTML=eyebrow('Acesso')+`<h2>Conferindo quem controla a conta.</h2><p class="pb-lead">Vamos verificar se esta carteira já pode autorizar a retirada.</p><p class="pb-source-address">${escape(source)}</p><div class="pb-mini-track" role="progressbar" aria-label="Verificando acesso"><div class="pb-mini-fill pb-indeterminate" style="width:30%"></div></div>`;
    if(state.screen==='recover-access'){
      const checks=state.accessCheck?.networks??[], guardian=checks.some(n=>n.status==='guardian');
      scene.innerHTML=eyebrow('Recuperar acesso')+`<h2>Você tem a passkey?</h2><p class="pb-lead">${guardian?'A carteira conectada é seu guardian. Escolha como recuperar o acesso à conta.':'Escolha como recuperar o acesso à conta que encontramos.'}</p><div class="pb-decision-options"><button type="button" class="pb-decision" data-action="access-passkey"><span>Tenho a passkey</span></button><button type="button" class="pb-decision" data-action="no-passkey"><span>Não tenho a passkey</span></button></div>${checks.some(n=>n.status==='unknown')?`<p class="pb-error">${escape(checks.filter(n=>n.status==='unknown').map(n=>n.name).join(', '))}: verificação indisponível. O acesso ainda não foi confirmado.</p>`:''}`;
    }
    if(state.screen==='recovery-loading')scene.innerHTML=eyebrow('Recuperar acesso')+`<h2>Preparando a recuperação.</h2><p class="pb-lead">Conferindo guardians, aprovações e prazos nas redes da sua conta.</p><div class="pb-mini-track" role="progressbar" aria-label="Preparando recuperação"><div class="pb-mini-fill pb-indeterminate" style="width:30%"></div></div>`;
    if(state.screen==='recovery-owner')scene.innerHTML=eyebrow('Recuperar acesso')+`<h2>Qual carteira vai controlar sua conta?</h2><p class="pb-lead">Use outra carteira sua. Ela vai substituir a passkey no controle da Safe. Seus ativos continuam na conta.</p><form><label class="pb-field" for="pb-owner">Endereço da nova carteira</label><input id="pb-owner" class="pb-address pb-owner-address" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(state.recoveryOwner)}" aria-describedby="pb-owner-error"><p id="pb-owner-error" class="pb-error" role="alert" ${!state.recoveryOwner||!recoveryOwnerError()?'hidden':''}>${state.recoveryOwner?escape(recoveryOwnerError()):''}</p>${action('Continuar',!!recoveryOwnerError())}</form><p class="pb-note">O novo owner nunca pode ser a carteira conectada, a própria Safe ou um guardian.</p>`;
    if(state.screen==='recovery-network')scene.innerHTML=recoveryScreen();
    if(state.screen==='recovery-overview')scene.innerHTML=recoveryOverview();
    if(state.screen==='account')scene.innerHTML=eyebrow('Contas vinculadas')+`<h2>Qual conta quer consultar?</h2><p class="pb-lead">Esta carteira tem ${state.candidates.length} contas identificadas.</p><div class="pb-account-options">${state.candidates.map(a=>`<button type="button" class="pb-choice" data-account="${escape(a)}"><span class="pb-source-address">${escape(a)}</span></button>`).join('')}</div>${state.discoveryIssues.length?'<p class="pb-note">A descoberta ficou parcial. Outras contas podem não ter sido encontradas.</p>':''}`;
    if(state.screen==='no-account')scene.innerHTML=eyebrow('Conta ainda não identificada')+`<h2>Nenhuma conta confirmada.</h2><p class="pb-lead">${state.discoveryIssues.length?'Parte da descoberta não respondeu. Isso não significa que sua conta não existe.':'Não encontramos uma Safe vinculada a esta carteira nas redes consultadas.'}</p><p class="pb-source-address">${escape(state.sourceWallet)}</p><div class="pb-gas-actions"><button type="button" class="pb-primary" data-action="retry-discovery">Tentar novamente</button><button type="button" class="pb-secondary" data-action="change-source">Trocar carteira</button></div>`;
    if(state.screen==='passkey-discover')scene.innerHTML=eyebrow('Identificando sua passkey')+`<h2>Vamos encontrar sua conta.</h2><p class="pb-lead">${escape(state.discoveryMessage)}</p><div class="pb-mini-track"><div class="pb-mini-fill pb-indeterminate" style="width:30%"></div></div><p class="pb-note">A passkey autoriza apenas a identificação. Nenhuma retirada é assinada.</p>`;
    if(state.screen==='passkey-confirm')scene.innerHTML=eyebrow('Confirmar a identificação')+`<h2>Confirme a mesma passkey.</h2><p class="pb-lead">Encontramos contas para mais de uma chave candidata. Uma segunda verificação identifica qual é a sua.</p><div class="pb-actions"><button class="pb-primary" data-action="confirm-passkey">Confirmar passkey</button></div>`;
    if(state.screen==='assets'){
      const problems=networks.filter(n=>n.status!=='complete');
      scene.innerHTML=eyebrow(source?`Safe consultada · ${short(source)}`:'Consulta indisponível')+`<h2>O que você quer levar?</h2><p class="pb-lead">${inventory?`${available.reduce((sum,n)=>sum+n.items.length,0)} ativos em ${available.length} redes. Tudo vem selecionado.`:'Os dados reais ainda não foram carregados. Atualize após concluir a consulta.'}</p><div class="pb-networks">${available.map(n=>`<label class="pb-network"><input type="checkbox" data-network="${n.id}" ${state.selected.has(n.id)?'checked':''}>${chain(n)}<span class="pb-network-name">${escape(n.name)}</span><span class="pb-network-count">${n.items.length} ${n.items.length===1?'ativo':'ativos'}</span></label>`).join('')}</div>${problems.length?`<p class="pb-error">Consulta parcial: ${problems.map(n=>escape(n.name)).join(', ')}. Alguns saldos ainda são desconhecidos.</p>`:''}${action('Levar '+count()+' ativos',!count())}${!available.length?'<p class="pb-note">Nenhum ativo confirmado nesta consulta. Você pode repetir a consulta ou voltar e escolher outra conta.</p><button class="pb-link" data-action="retry-assets">Consultar novamente</button>':''}<details><summary>Ver ativos, endereço e detalhes da consulta</summary><p class="pb-source-address">${escape(source)}</p>${source?'<button type="button" class="pb-link" data-action="copy-source">Copiar endereço da Safe</button>':''}${state.discoveryIssues.length?'<p>A descoberta de contas ficou parcial. Outras contas podem não ter sido encontradas.</p>':''}<p>Consulta: ${inventory?escape(new Date(inventory.checkedAt).toLocaleString('pt-BR')):'pendente'}. Saldos registrados nesse momento.</p><div class="pb-table-wrap"><table class="pb-assets"><thead><tr><th>Ativo</th><th>Rede</th><th>Saldo</th></tr></thead><tbody>${available.flatMap(n=>n.items.map(item=>`<tr><td>${item.kind==='card'?'Cartão · ':''}${escape(item.name)}${['position','mamo'].includes(item.kind)?'<small> · investimento</small>':''}</td><td>${escape(n.name)}</td><td>${amount(item.balance)}</td></tr>`)).join('')}</tbody></table></div>${networks.map(n=>`<p>${escape(n.name)} · ${n.status==='complete'?n.items.length?'consultada':'nenhum saldo encontrado no catálogo':'consulta incompleta'}${n.block?` · bloco ${escape(n.block)}`:''}</p>`).join('')}</details>`;
    }
    if(state.screen==='destination')scene.innerHTML=eyebrow('Destino')+`<h2>Pra onde vamos levar?</h2><p class="pb-lead">Cole o endereço da carteira que vai receber os ativos.<br>É nela que você vai receber os ativos.</p><form><label class="pb-field" for="pb-recipient">Endereço da carteira de destino</label><input id="pb-recipient" class="pb-address" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escape(state.destination)}" aria-describedby="pb-destination-error"><p id="pb-destination-error" class="pb-error" role="alert" ${!state.destination||validDestination()?'hidden':''}>${state.destination?escape(destinationError()):''}</p>${action('Continuar',!validDestination())}</form><p class="pb-note">Pode ser a mesma carteira que paga as taxas. O destino deve ser diferente da Safe de origem.</p>`;
    if(state.screen==='fees')scene.innerHTML=fees();
    if(state.screen==='fund'){
      const n=networks.find(n=>n.id===state.funding),symbol=n.symbol==='XDAI'?'xDAI':n.symbol;
      scene.innerHTML=`<section class="pb-gas-step"><div class="pb-gas-context">${chain(n)}<span>${escape(n.name)}</span><span class="pb-gas-meta">Saldo para taxas</span></div><h2>Adicione ${escape(symbol)}.</h2><p class="pb-lead">Envie pela rede ${escape(n.name)} para a carteira abaixo.</p><div class="pb-deposit-address"><span class="pb-source-address">${escape(state.payer)}</span><button type="button" class="pb-copy-icon" data-action="copy-payer" aria-label="Copiar endereço da carteira para taxas" title="Copiar endereço">${copyIcon}</button><span class="pb-copy-feedback" role="status"></span></div><div class="pb-gas-actions"><button type="button" class="pb-primary" data-action="next" ${state.busy?'disabled':''}>${state.busy?'<span class="pb-gas-spinner" aria-hidden="true"></span> Conferindo saldo…':'Conferir depósito'}</button><button type="button" class="pb-secondary" data-action="skip" ${state.busy?'disabled':''}>Deixar para depois</button></div><p class="pb-note" ${state.busy?'role="status"':''}>${state.busy?'Consultando o saldo desta carteira na rede…':'Depois de enviar, confira se o saldo chegou. O custo da retirada será estimado antes de assinar.'}</p></section>`;
    }
    if(state.screen==='skipped')scene.innerHTML=eyebrow('Nenhuma rede selecionada')+`<h2>Tudo continua<br>na sua Safe.</h2><p class="pb-lead">Você pulou todas as redes. Nenhum ativo foi retirado. Pode voltar e escolher quais quer preparar.</p>${action('Rever redes')}`;
    if(state.screen==='move'){
      const n=selected()[state.sent];
      scene.innerHTML=eyebrow(`Prévia da retirada · rede ${state.sent+1} de ${selected().length}`)+`<h2>${state.sent?'Vamos para a próxima.':'Uma etapa por vez.'}</h2><p class="pb-lead">Cada lote pede uma confirmação na carteira. Uma rede pode precisar de várias transações.</p><div class="pb-tx"><div class="pb-tx-head">${chain(n)}<span>${escape(n.name)}</span><small>Prévia</small></div><div class="pb-tx-body"><strong>${n.items.length} ativos selecionados</strong><span>Destino ${escape(short(state.destination))}</span></div><div class="pb-tx-progress"><div class="pb-mini-track" role="progressbar" aria-label="Prévia desta etapa" aria-valuemin="0" aria-valuemax="3" aria-valuenow="1"><div class="pb-mini-fill" style="width:33%"></div></div><p class="pb-status" role="status">Os lotes reais ainda precisam ser montados e simulados.</p></div></div>${action('Demonstrar esta etapa')}<p class="pb-note">Nenhuma assinatura ou transação será solicitada nesta prévia.</p>`;
    }
    if(state.screen==='done')scene.innerHTML=`<div class="pb-done-mark" aria-hidden="true">✓</div>${eyebrow('Prévia concluída')}<h2>Prévia concluída.<br>Nada foi enviado.</h2><p class="pb-lead">${count()} ativos selecionados · ${selected().length} redes percorridas na demonstração.</p><div class="pb-wallet-line"><span>Destino escolhido<small>${escape(state.destination)}</small></span><span class="pb-check">✓</span></div>${state.skipped.size?`<p class="pb-note">Redes puladas: ${available.filter(n=>state.skipped.has(n.id)).map(n=>escape(n.name)).join(', ')}.</p>`:''}<p class="pb-note">Todos os saldos continuam na origem.</p>${action('Recomeçar a prévia')}`;
    if(state.recoveryExcluded.size&&['recovery-owner','recovery-network'].includes(state.screen)&&state.recovery?.complete)scene.insertAdjacentHTML('beforeend',`<details><summary>${state.recoveryExcluded.size} rede(s) deixada(s) para depois</summary><p>A recuperação não será executada nessas redes.</p><button class="pb-link" data-action="restore-recovery-checks" ${state.busy?'disabled':''}>Retomar verificação</button></details>`);
    if(state.error)scene.insertAdjacentHTML('beforeend',`<p class="pb-error" role="alert">${escape(state.error)}</p>`);
    const heading=scene.querySelector('h2');heading?.setAttribute('tabindex','-1');
    if(restoreFocus&&isWalletChoiceScreen()&&focusedWallet){scene.querySelectorAll?.('button').forEach(button=>{if(button.dataset.sourceProvider===focusedWallet||button.dataset.provider===focusedWallet)button.focus({preventScroll:true});});}else if(restoreFocus&&!isWalletChoiceScreen())heading?.focus({preventScroll:true});
  }
  function guard(screen){
    if(['assets','fees','fund','destination','move','done'].includes(screen)&&!inventory)return state.method==='wallet'?'connect-source':'access';
    if(['assets','fees','fund','destination','move','done'].includes(screen)&&state.method==='wallet'&&!externalAccessReady())return 'recover-access';
    if(screen==='fund'&&!canFund())return 'fees';
    if(['destination','move'].includes(screen)&&!ready())return 'fees';
    if(screen==='move'&&!validDestination())return 'destination';
    return screen;
  }
  function go(screen,remember=true){
    screen=guard(screen);root.dataset.screen=screen;
    if(remember&&screen!==state.screen)history.push({screen:state.screen,funding:state.funding});
    cancel();state.busy=false;state.error='';state.screen=screen;render();
    (scene.querySelector('h2')??scene).focus({preventScroll:true});scene.parentElement?.scrollTo?.({top:0,behavior:'instant'});
    if(isWalletChoiceScreen())beginWalletDiscovery();
  }
  function goBack(){
    if(back.disabled||state.recoverySending)return;
    if(state.screen==='done'){history.length=0;state.sent=0;go('assets',false);return;}
    let previous=history.pop();
    while(previous&&previous.screen===state.screen&&!previous.restoreNetwork&&previous.recoveryIndex===undefined)previous=history.pop();
    let target=previous?.screen??({'check-access':'connect-source','recovery-loading':'recover-access','recovery-owner':'recover-access','recovery-overview':'recover-access','recovery-network':'recovery-owner','recover-access':'connect-source','passkey-discover':'access','passkey-confirm':'access','connect-source':'access',discover:'connect-source',scan:'connect-source',account:'connect-source','no-account':'connect-source',assets:state.method==='wallet'?'connect-source':'access',fees:'assets',destination:'fees',fund:'fees',skipped:'assets',move:'destination'}[state.screen]??'access');
    if(state.recoveryTarget&&['passkey-discover','passkey-confirm'].includes(state.screen)){source=state.recoveryTarget;state.candidates=[source];target='recover-access';}
    if(['destination','move'].includes(target)&&(!state.payer||unresolved().length))target=state.screen==='fees'?'assets':'fees';
    if(previous?.recoveryIndex!==undefined)state.recoveryIndex=previous.recoveryIndex;
    if(previous?.restoreRecoveryChain!==undefined)state.recoverySkipped.delete(previous.restoreRecoveryChain);
    if(previous?.restoreNetwork){state.selected.add(previous.restoreNetwork);state.skipped.delete(previous.restoreNetwork);}
    if(previous?.funding)state.funding=previous.funding;
    if(state.screen==='move')state.sent=0;
    go(target,false);
    if(target==='fees'&&state.payer){const missing=selected().filter(n=>!state.gas[n.id]).map(n=>n.id);if(missing.length)void checkGas(missing);}
  }
  function destinationError(){
    const value=state.destination.trim().toLowerCase();
    if(!/^0x[a-f0-9]{40}$/.test(value)||/^0x0{39}[01]$/.test(value))return 'Informe um endereço válido de carteira, começando com 0x.';
    if(value===source?.toLowerCase())return 'Esse é o endereço da Safe de origem. Use outra carteira.';
    return '';
  }
  function validDestination(){return !destinationError();}
  function validateInput(){const field=scene.querySelector('.pb-address');state.destination=field.value.trim();const error=scene.querySelector('#pb-destination-error');error.textContent=state.destination?destinationError():'';error.hidden=!error.textContent;field.setAttribute('aria-invalid',String(!!error.textContent));scene.querySelector('[data-action=next]').disabled=!validDestination();syncForward();}
  async function rpc(n,method,params){
    if(!['eth_chainId','eth_getBalance'].includes(method))throw Error('Somente consulta permitida.');
    const response=await fetch(rpcUrls[n.chainId],{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('Rede indisponível.');const body=await response.json();
    if(body.error||body.id!==1||body.jsonrpc!=='2.0'||typeof body.result!=='string'||!/^0x[\da-f]+$/i.test(body.result))throw Error('Resposta inválida.');return body.result;
  }
  async function activePayer(){
    const provider=state.provider,payer=state.payer;if(!provider||!payer)throw Error('Conecte a carteira que paga as taxas.');
    let timer;try{const accounts=await Promise.race([provider.request({method:'eth_accounts'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('A carteira não respondeu. Reconecte.')),10000);})]);if(!Array.isArray(accounts)||accounts[0]?.toLowerCase()!==payer.toLowerCase()||state.provider!==provider||state.payer!==payer)throw Error('A conta mudou. Reconecte para conferir as taxas.');return payer;}finally{clearTimeout(timer);}
  }
  async function checkGas(ids=selected().map(n=>n.id)){
    if(state.busy||!state.payer)return;const payer=state.payer,epoch=state.epoch;state.busy=true;state.error='';if(state.screen!=='fund')ids.forEach(id=>delete state.gas[id]);render();
    try{await activePayer();await Promise.all(ids.map(async id=>{const n=networks.find(n=>n.id===id);let result;try{if(BigInt(await rpc(n,'eth_chainId',[]))!==BigInt(n.chainId))throw Error('Rede incorreta.');const balance=BigInt(await rpc(n,'eth_getBalance',[payer,'latest']));result={status:balance===0n?'empty':'available',balance,payer,checkedAt:Date.now()};}catch{result={status:'error',payer,checkedAt:Date.now()};}if(state.epoch===epoch&&state.payer===payer){state.gas[id]=result;const status=scene.querySelector('.pb-status');if(state.screen==='fees'&&status)status.textContent=`${selected().filter(n=>state.gas[n.id]).length} de ${selected().length} redes consultadas…`;}}));await activePayer();if(state.epoch!==epoch||state.payer!==payer)return;state.busy=false;if(state.screen==='fund'){if(state.gas[state.funding]?.status==='available'){go('fees',false);return;}if(state.gas[state.funding]?.status!=='empty'){go('fees',false);state.error='Não foi possível conferir o depósito. Tente novamente.';render();return;}state.error='O saldo ainda está zerado. Aguarde o depósito confirmar e confira novamente.';}render();}catch(error){if(state.epoch===epoch){detachWallet();state.provider=undefined;state.payer='';state.gas={};go('fees',false);state.error=error.message;render();}}
  }
  let detachWallet=()=>{};
  async function requestWallet(provider){let timer;try{return await Promise.race([provider.request({method:'eth_requestAccounts'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('A carteira não respondeu. Tente de novo.')),60000);})]);}finally{clearTimeout(timer);}}
  async function connectWallet(id){
    const choice=providers.get(id);if(!choice||state.busy)return;const epoch=state.epoch;state.busy=true;state.error='';render();
    try{const accounts=await requestWallet(choice.provider);if(state.epoch!==epoch)return;if(!Array.isArray(accounts)||!/^0x[a-f0-9]{40}$/i.test(accounts[0]??'')||/^0x0{39}[01]$/i.test(accounts[0]))throw Error('A carteira não informou um endereço válido.');detachWallet();state.provider=choice.provider;state.payer=accounts[0];state.walletName=choice.name;state.gas={};
      const changed=()=>{if(state.provider!==choice.provider)return;detachWallet();state.provider=undefined;state.payer='';state.gas={};go('fees',false);state.error='A conta conectada mudou. Reconecte para conferir o endereço e as taxas.';render();};
      choice.provider.on?.('accountsChanged',changed);choice.provider.on?.('disconnect',changed);
      detachWallet=()=>{choice.provider.removeListener?.('accountsChanged',changed);choice.provider.removeListener?.('disconnect',changed);};
      state.busy=false;await checkGas();
    }catch(error){if(state.epoch===epoch){state.busy=false;state.error=error.code===4001?'Conexão cancelada. Você pode tentar novamente.':error.message;render();}}
  }
  function dropPayer(message){detachWallet();state.provider=undefined;state.payer='';state.walletName='';state.gas={};state.funding=undefined;go('fees',false);state.error=message;render();}
  function animateChoice(button,fn){
    if(state.busy)return;state.busy=true;chrome();button?.setAttribute('aria-pressed','true');root.classList.add('pb-answer-leaving');
    later(()=>{root.classList.remove('pb-answer-leaving');state.busy=false;fn();root.classList.add('pb-answer-entering');},window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?0:180);
  }
  async function openFunding(button){
    const n=unresolved()[0];if(!n||gasFor(n.id)?.status!=='empty'||!hasPayer())return;const epoch=state.epoch;state.busy=true;chrome();
    try{await activePayer();if(epoch!==state.epoch)return;state.busy=false;state.funding=n.id;animateChoice(button,()=>go('fund'));}catch(error){if(epoch===state.epoch)dropPayer(error.message);}
  }
  async function advanceVerified(target){
    const epoch=state.epoch;state.busy=true;chrome();
    try{await verifySource();}catch(error){if(epoch===state.epoch){if(state.method==='wallet')changedSource();else{restart();state.error=error.message;render();}}return;}
    if(epoch!==state.epoch)return;
    try{await activePayer();if(epoch!==state.epoch)return;state.busy=false;go(target);}catch(error){if(epoch===state.epoch)dropPayer(error.message);}
  }
  function skipNetwork(){const n=state.screen==='fund'?networks.find(n=>n.id===state.funding):unresolved()[0];if(!n)return;history.push({screen:'fees',restoreNetwork:n.id});state.selected.delete(n.id);state.skipped.add(n.id);go(selected().length?'fees':'skipped',false);}
  function demonstrate(){state.busy=true;chrome();const button=scene.querySelector('[data-action=next]'),status=scene.querySelector('.pb-status'),bar=scene.querySelector('.pb-mini-fill'),meter=scene.querySelector('[role=progressbar]');button.disabled=true;button.textContent='Demonstrando…';scene.querySelector('.pb-enter').hidden=true;status.textContent='Exemplo: aguardando confirmação na carteira';later(()=>{status.textContent='Exemplo: aguardando confirmação da rede';bar.style.width='67%';meter.setAttribute('aria-valuenow','2');},1000);later(()=>{status.textContent='Exemplo: etapa concluída ✓';bar.style.width='100%';meter.setAttribute('aria-valuenow','3');state.sent++;chrome();later(()=>go(state.sent>=selected().length?'done':'move'),550);},2200);}
  function setInventory(value){inventory=value;networks=value?.networks??[];available=networks.filter(n=>n.items.length);source=value?.account;state.selected=new Set(available.map(n=>n.id));state.skipped.clear();}
  function resetSession(){detachSource();detachSource=()=>{};detachWallet();state.provider=undefined;state.payer='';state.walletName='';state.sourceProvider=undefined;state.sourceWallet='';state.sourceName='';state.destination='';state.gas={};state.passkeyReady=false;state.passkeyHint=undefined;state.accessCheck=undefined;state.recoveryTarget='';state.recovery=undefined;state.recoveryOwner='';state.recoveryIndex=0;state.recoverySkipped.clear();state.recoveryExcluded.clear();state.recoveryMessage='';window.picnicGuidedDiscovery?.resetPasskey?.();state.candidates=[];state.discoveryIssues=[];state.sent=0;state.funding=undefined;history.length=0;setInventory(undefined);}
  function restart(){resetSession();go('access',false);}
  function startMethod(method){resetSession();state.passkeyHint=method==='security-key'?'security-key':undefined;state.method=method==='security-key'?'passkey':method;if(state.method==='passkey')void discoverWithPasskey();else go('connect-source');}
  function changedSource(){resetSession();state.method='wallet';go('connect-source',false);state.error='A carteira mudou. Conecte novamente para identificar sua conta e consultar os ativos.';render();}
  async function verifySource(){if(state.method==='passkey'){if(!state.passkeyReady)throw Error('Identifique sua passkey novamente.');return;}const provider=state.sourceProvider,wallet=state.sourceWallet;if(!provider||!wallet)throw Error('Conecte a carteira de acesso novamente.');let timer;try{const accounts=await Promise.race([provider.request({method:'eth_accounts'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('A carteira não respondeu. Tente conectar novamente.')),10000);})]);if(provider!==state.sourceProvider||wallet!==state.sourceWallet||accounts?.[0]?.toLowerCase()!==wallet.toLowerCase())throw Error('A carteira mudou. Conecte novamente.');}finally{clearTimeout(timer);}}
  async function connectSource(id){
    const choice=providers.get(id);if(!choice||state.busy)return;const epoch=state.epoch;state.busy=true;state.error='';setInventory(undefined);render();
    try{const accounts=await requestWallet(choice.provider);if(epoch!==state.epoch)return;if(!Array.isArray(accounts)||!/^0x[a-f0-9]{40}$/i.test(accounts[0]??'')||/^0x0{39}[01]$/i.test(accounts[0]))throw Error('A carteira não informou um endereço válido.');detachSource();detachWallet();state.sourceProvider=choice.provider;state.sourceWallet=accounts[0];state.sourceName=choice.name;state.provider=choice.provider;state.payer=accounts[0];state.walletName=choice.name;state.gas={};choice.provider.on?.('accountsChanged',changedSource);choice.provider.on?.('disconnect',changedSource);detachSource=()=>{choice.provider.removeListener?.('accountsChanged',changedSource);choice.provider.removeListener?.('disconnect',changedSource);};state.busy=false;await discoverSource();}catch(error){if(epoch===state.epoch){state.busy=false;state.error=error.code===4001?'Conexão cancelada. Escolha uma carteira para continuar.':error.message;render();}}
  }
  async function discoverSource(){
    setInventory(undefined);state.candidates=[];state.discoveryIssues=[];go('discover');state.busy=true;render();const epoch=state.epoch;sourceAbort=new AbortController();const signal=sourceAbort.signal;
    try{if(!window.picnicGuidedDiscovery)throw Error('O módulo de consulta não carregou. Atualize a página e tente novamente.');await verifySource();if(signal.aborted)return;const result=await window.picnicGuidedDiscovery.discover(state.sourceWallet,signal);if(epoch!==state.epoch)return;await verifySource();if(epoch!==state.epoch)return;state.candidates=[...new Set(result.addresses)];state.discoveryIssues=result.issues;if(result.addresses.length===1){await scanSource(result.addresses[0]);return;}go(result.addresses.length?'account':'no-account',false);}catch(error){if(epoch===state.epoch){go('no-account',false);state.discoveryIssues=['Descoberta incompleta.'];state.error=error.message;render();}}
  }
  async function discoverWithPasskey(confirm=false){
    setInventory(undefined);state.passkeyReady=false;state.candidates=[];state.discoveryIssues=[];state.discoveryMessage='Confirme a passkey no seu dispositivo.';go('passkey-discover',false);state.busy=true;render();const epoch=state.epoch;sourceAbort=new AbortController();const signal=sourceAbort.signal;
    try{const api=window.picnicGuidedDiscovery;if(!api?.discoverPasskey)throw Error('O módulo de passkey não carregou. Atualize a página.');const result=await (confirm?api.confirmPasskey:api.discoverPasskey)(signal,message=>{if(epoch!==state.epoch)return;state.discoveryMessage=message;const text=scene.querySelector('.pb-lead');if(text)text.textContent=message;},state.passkeyHint);if(epoch!==state.epoch)return;state.discoveryIssues=result.issues;if(result.needsSecond){go('passkey-confirm',false);return;}state.candidates=[...new Set(result.addresses)];if(state.recoveryTarget){state.candidates=state.candidates.filter(a=>a.toLowerCase()===state.recoveryTarget.toLowerCase());if(!state.candidates.length){source=state.recoveryTarget;state.candidates=[state.recoveryTarget];go('recover-access',false);state.error='Esta passkey não confirmou acesso à conta escolhida. Use a passkey desta conta.';render();return;}}state.method='passkey';state.passkeyReady=!!state.candidates.length;if(state.candidates.length===1){await scanSource(state.candidates[0]);return;}go(state.candidates.length?'account':'no-account',false);}catch(error){if(epoch===state.epoch){if(state.recoveryTarget){source=state.recoveryTarget;state.candidates=[state.recoveryTarget];}go(state.recoveryTarget?'recover-access':'access',false);state.error=error.name==='NotAllowedError'?'Não foi possível usar a passkey. Se apareceu um QR code, escolha outra opção no navegador e selecione sua chave de segurança, ou tente “Com uma chave de segurança”.':error.message;render();}}
  }
  function externalAccessReady(){const c=state.accessCheck;return !!c?.ready&&c.account.toLowerCase()===source?.toLowerCase()&&c.wallet.toLowerCase()===state.sourceWallet.toLowerCase();}
  async function scanSource(account){
    if(!state.candidates.some(a=>a.toLowerCase()===account.toLowerCase()))return;
    setInventory(undefined);source=account;state.accessCheck=undefined;state.scanDone=0;state.scanTotal=10;go(state.method==='wallet'?'check-access':'scan',state.screen==='account');state.busy=true;render();const epoch=state.epoch;sourceAbort=new AbortController();const signal=sourceAbort.signal;
    try{await verifySource();if(signal.aborted)return;
      if(state.method==='wallet'){
        const check=window.picnicGuidedDiscovery?.checkAccess;
        if(!check)throw Error('Não foi possível carregar a verificação de acesso. Atualize e tente novamente.');
        const access=await check(account,state.sourceWallet,signal);if(epoch!==state.epoch)return;
        await verifySource();if(epoch!==state.epoch)return;state.accessCheck=access;
        if(!externalAccessReady()){go('recover-access',false);return;}
        state.screen='scan';render();
      }
      const result=await window.picnicGuidedDiscovery.scan(account,signal,(done,total)=>{if(epoch!==state.epoch)return;state.scanDone=done;state.scanTotal=total;const meter=scene.querySelector('[role=progressbar]');meter?.setAttribute('aria-valuenow',String(done));meter?.setAttribute('aria-valuemax',String(total));const fill=scene.querySelector('.pb-mini-fill');if(fill)fill.style.width=100*done/total+'%';const status=scene.querySelector('.pb-status');if(status)status.textContent=`${done} de ${total} redes consultadas`;});if(epoch!==state.epoch)return;await verifySource();if(epoch!==state.epoch)return;setInventory(result);go('assets',false);}catch(error){if(epoch===state.epoch){setInventory(undefined);go('no-account',false);state.discoveryIssues=['Consulta incompleta.'];state.error=error.message;render();}}
  }
  function recoveryDelay(seconds){const value=Number(seconds);return value>=86400?(value/86400).toLocaleString('pt-BR')+' dia'+(value===86400?'':'s'):value>=3600?(value/3600).toLocaleString('pt-BR')+' hora'+(value===3600?'':'s'):(value/60).toLocaleString('pt-BR')+' minuto'+(value===60?'':'s');}
  function recoveryEntries(){return (state.recovery?.networks??[]).flatMap(n=>n.modules.map(m=>({n,m})));}
  function recoveryOwnerError(){
    const value=state.recoveryOwner.trim().toLowerCase();
    if(!/^0x[a-f0-9]{40}$/.test(value)||/^0x0{39}[01]$/i.test(value)||state.recovery?.owner===state.recoveryOwner&&state.recovery?.ownerProblem==='invalid')return 'Informe um endereço válido de carteira.';
    if(value===source?.toLowerCase())return 'Use outra carteira, diferente da Safe.';
    if(value===state.sourceWallet.toLowerCase()||(state.recovery?.guardians??[]).some(g=>g.toLowerCase()===value))return 'O novo owner não pode ser a carteira conectada nem um guardian.';
    return '';
  }
  function recoveryScreen(){
    const data=state.recovery, entries=recoveryEntries(), entry=entries[Math.min(state.recoveryIndex,Math.max(0,entries.length-1))];
    if(!data)return eyebrow('Recuperar acesso')+`<h2>Vamos conferir a recuperação.</h2><div class="pb-actions"><button class="pb-primary" data-action="refresh-recovery" ${state.busy?'disabled aria-busy="true"':''}>${state.busy?'Conferindo redes…':'Tentar novamente'}</button></div>${state.busy?recoveryProgress():''}`;
    if(data.pending?.length)return eyebrow('Transação enviada')+`<h2>Aguardando confirmação.</h2><p class="pb-lead">Confira o resultado antes de enviar outra transação.</p>${data.pending.map(t=>`<p class="pb-source-address">${escape(t.hash)}</p>`).join('')}<button class="pb-primary" data-action="recovery-receipt" ${state.busy?'disabled':''}>Conferir confirmação</button>${recoveryProgress()}`;
    if(state.recoveryExcluded.size&&!data.networks.length&&!data.incompleteNetworks?.length)return eyebrow('Recuperar acesso')+`<h2>Redes deixadas para depois.</h2><p class="pb-lead">Nenhuma rede foi liberada para recuperação. Você pode retomar a verificação ou voltar ao início.</p><div class="pb-actions"><button class="pb-primary" data-action="restore-recovery-checks">Retomar verificação</button><button class="pb-link" data-action="recovery-restart">Voltar ao início</button></div>`;
    if(!data.complete)return eyebrow('Recuperar acesso')+`<h2>Falta conferir algumas redes.</h2><p class="pb-lead">Tente novamente ou deixe estas redes para depois. A recuperação continua apenas nas redes verificadas.</p><p>${escape(data.issues.join(', '))}</p>${state.busy?recoveryProgress():''}<div class="pb-actions"><button class="pb-primary" data-action="refresh-recovery" ${state.busy?'disabled aria-busy="true"':''}>${state.busy?'Conferindo redes…':'Tentar novamente'}</button>${data.incompleteNetworks?.length?`<button class="pb-link" data-action="skip-incomplete-recovery">${data.incompleteNetworks.length===1?'Pular esta rede':'Pular estas redes'}</button>`:''}</div>`;
    if(!entry)return eyebrow('Recuperar acesso')+`<h2>Conecte o guardian da conta.</h2><p class="pb-lead">Não encontramos um módulo de recuperação compatível nas redes verificadas. Use a passkey ou uma carteira que já controle a conta.</p><button class="pb-primary" data-action="change-source">Trocar carteira</button>`;
    const {n,m}=entry, until=Number(m.until), recovered=n.recovered, hasNext=entries.some((e,i)=>i>state.recoveryIndex&&!state.recoverySkipped.has(e.n.chainId));
    const titles={approve:'Autorize a recuperação.',start:'Inicie a recuperação.',finalize:'Recupere sua conta.'};
    const labels={approve:'Recuperar conta',start:'Recuperar conta',finalize:'Finalizar recuperação'};
    const heading=recovered?'Acesso recuperado.':m.pendingProblem?'Precisamos revisar o novo owner.':m.operation?titles[m.operation]:until?'O prazo já começou.':n.gas==='0'?`Adicione ${n.symbol} para continuar.`:'Falta uma aprovação.';
    const lead=recovered?'Agora a nova carteira controla sua conta nesta rede.':m.pendingProblem?'Esta solicitação não pode ser finalizada com o endereço escolhido.':m.operation==='approve'?'Use o guardian conectado para autorizar a troca da passkey pela nova carteira.':m.operation==='start'?'A autorização está pronta. Confirme na carteira para iniciar o prazo.':m.operation==='finalize'?'O prazo terminou. Confirme a troca de controle na carteira.':until?`Você poderá finalizar a partir de ${new Date(until*1000).toLocaleString('pt-BR')}.`:n.gas==='0'?`Envie ${n.symbol} pela ${n.name} para a carteira que paga as taxas.`:m.guardian?'Faltam aprovações de outros guardians. A nova carteira não precisa aprovar.':'Conecte um guardian configurado nesta rede.';
    const target=until?m.newOwners.join(', '):state.recoveryOwner;
    const primary=state.busy?`<button class="pb-primary" disabled>${state.recoveryMessage.includes('carteira')?'Continue na carteira…':'Processando…'}</button>`:!recovered&&m.operation?`<button class="pb-primary" data-action="recovery-act">${labels[m.operation]}</button>`:(recovered||until)&&hasNext?'<button class="pb-primary" data-action="recovery-next">Continuar na próxima rede</button>':recovered?'<button class="pb-primary" data-action="change-source">Conectar nova carteira</button>':!until&&n.gas!=='0'&&!m.pendingProblem?'<button class="pb-primary" data-action="change-source">Conectar outro guardian</button>':n.gas==='0'?'<button class="pb-primary" data-action="refresh-recovery">Já enviei. Conferir saldo</button>':'';
    return `<div class="pb-recovery-chain">${chain({...n,id:String(n.chainId)})}<span>${escape(n.name)}</span><small>${Math.min(state.recoveryIndex+1,entries.length)} de ${entries.length} redes</small></div><h2>${escape(heading)}</h2><p class="pb-lead">${escape(lead)}</p>${!recovered&&!until?`<p class="pb-recovery-timing">Depois de iniciar, você precisa aguardar <strong>${escape(recoveryDelay(m.period))}</strong> para concluir a recuperação.</p>`:''}${!recovered&&n.gas==='0'?`<p class="pb-source-address">${escape(state.sourceWallet)}</p>`:''}${!recovered?`<div class="pb-recovery-owner-line"><span><small>Nova carteira que controla a conta</small><span class="pb-source-address">${escape(target)}</span></span>${!until?`<button class="pb-link" data-action="edit-recovery-owner" ${state.busy?'disabled':''}>Editar</button>`:''}</div>`:''}${state.recoveryMessage?recoveryProgress():''}<div class="pb-actions">${primary}${!recovered&&!state.busy?`<button class="pb-link" data-action="skip-recovery">${until?'Ver esta rede depois':'Pular esta rede'}</button>`:''}</div>${!state.busy&&!m.operation&&until&&!hasNext?'<p class="pb-note" role="status">Acompanhando o prazo automaticamente. Você pode fechar e voltar depois.</p>':''}`;
  }

  function advanceRecoveryNetwork(restoreRecoveryChain){
    history.push({screen:'recovery-network',recoveryIndex:state.recoveryIndex,restoreRecoveryChain});
    const entries=recoveryEntries(), next=entries.findIndex((e,i)=>i>state.recoveryIndex&&!state.recoverySkipped.has(e.n.chainId));
    if(next>=0){state.recoveryIndex=next;go('recovery-network',false);scheduleRecoveryRefresh();}else go('recovery-overview',false);
  }
  function recoveryOverview(){
    const entries=recoveryEntries(), active=entries.filter(e=>!state.recoverySkipped.has(e.n.chainId)), completed=active.filter(e=>e.n.recovered), pending=active.filter(e=>Number(e.m.until)>0);
    const allSkipped=!active.length;
    return eyebrow('Recuperar acesso')+`<h2>${allSkipped?'Redes deixadas para depois.':completed.length===active.length?'Acesso recuperado.':'Recuperações em andamento.'}</h2><p class="pb-lead">${allSkipped?'Você deixou todas as redes para depois. Seus ativos continuam nas contas de origem.':`${completed.length} rede(s) com acesso recuperado · ${pending.length} aguardando finalização · ${state.recoverySkipped.size} deixada(s) para depois.`}</p>${!allSkipped&&completed.length===active.length?'<button class="pb-primary" data-action="change-source">Conectar nova carteira</button>':allSkipped?'<button class="pb-primary" data-action="recovery-restart">Voltar ao início</button>':''}<details><summary>Ver redes e retomar</summary><div class="pb-recovery-networks">${entries.map((e,i)=>`<button class="pb-link" data-recovery-index="${i}">${escape(e.n.name)} · ${state.recoverySkipped.has(e.n.chainId)?'deixada para depois':e.n.recovered?'recuperada':Number(e.m.until)>0?'recuperação iniciada':e.m.approved?'autorização registrada':'não iniciada'}</button>`).join('')}</div></details><p class="pb-note">Pular uma rede não cancela autorizações ou recuperações que já tenham sido enviadas.</p>`;
  }
  function recoveryProgress(){return `<p class="pb-status" role="status">${escape(state.recoveryMessage)}</p>${state.busy?'<div class="pb-mini-track" role="progressbar" aria-label="Recuperação em andamento"><div class="pb-mini-fill pb-indeterminate" style="width:30%"></div></div>':''}`;}
  async function refreshRecovery(initial=false,receipts=false){
    if(state.busy||state.recoverySending)return;const account=source;if(!account)return;
    go(initial?'recovery-loading':'recovery-network',initial);state.busy=true;state.recoveryMessage=receipts?'Conferindo a confirmação na blockchain…':'Conferindo as redes e os guardians…';render();const epoch=state.epoch;sourceAbort=new AbortController();const signal=sourceAbort.signal;
    try{await verifySource();if(epoch!==state.epoch)return;const api=window.picnicGuidedDiscovery?.recovery;if(!api)throw Error('O módulo de recuperação não carregou. Atualize a página.');if(receipts)await api.receipts(account,signal);const data=await api.read(account,state.sourceWallet,state.recoveryOwner,signal,[...state.recoveryExcluded]);if(epoch!==state.epoch)return;await verifySource();if(epoch!==state.epoch)return;state.recovery=data;state.recoveryMessage='';state.busy=false;
      const pendingOwner=data.networks.flatMap(n=>n.modules).find(m=>Number(m.until)>0)?.newOwners?.[0];
      if(initial&&pendingOwner&&!state.recoveryOwner)state.recoveryOwner=pendingOwner;
      go(data.complete&&!pendingOwner&&!data.pending.length&&(initial||!state.recoveryOwner.trim()||!!data.ownerProblem)?'recovery-owner':'recovery-network',false);
      if(state.screen==='recovery-network')scheduleRecoveryRefresh();
    }catch(error){if(epoch===state.epoch){state.busy=false;go('recovery-network',false);state.error=error.message;render();}}
  }
  function scheduleRecoveryRefresh(){if(['recovery-network','recovery-overview'].includes(state.screen)&&!state.recoverySending)later(()=>{void refreshRecovery(false,!!state.recovery?.pending?.length);},30000);}
  async function submitRecovery(){
    const entry=recoveryEntries()[state.recoveryIndex];if(state.busy||!entry?.m.operation||!state.recovery?.complete)return;
    cancel();state.busy=true;state.recoverySending=true;state.error='';state.recoveryMessage='Preparando a operação…';render();const epoch=state.epoch;sourceAbort=new AbortController();const signal=sourceAbort.signal;
    try{await verifySource();if(epoch!==state.epoch)return;await window.picnicGuidedDiscovery.recovery.perform(source,state.sourceWallet,state.recoveryOwner,entry.n.chainId,entry.m.module,entry.m.operation,state.sourceProvider,signal,message=>{if(epoch===state.epoch){state.recoveryMessage=message;render();}},[...state.recoveryExcluded]);if(epoch!==state.epoch)return;if(['start','finalize'].includes(entry.m.operation)){const next=recoveryEntries().findIndex((e,i)=>i>state.recoveryIndex&&!state.recoverySkipped.has(e.n.chainId));if(next>=0){history.push({screen:'recovery-network',recoveryIndex:state.recoveryIndex});state.recoveryIndex=next;}}state.recoveryMessage='Transação confirmada.';
    }catch(error){if(epoch===state.epoch)state.error=error.message;}
    finally{state.recoverySending=false;if(epoch===state.epoch){const message=state.error;state.busy=false;await refreshRecovery();if(message){state.error=message;render();}}else render();}
  }
  async function next(){
    if(state.busy)return;
    if(state.screen==='recovery-owner'&&!recoveryOwnerError()){await refreshRecovery();return;}
    if(state.screen==='assets'&&count()){go('fees');if(state.payer)void checkGas();}
    else if(state.screen==='fees'&&ready())await advanceVerified('destination');
    else if(state.screen==='destination'&&validDestination()&&ready()){state.sent=0;await advanceVerified('move');}
    else if(state.screen==='fund')void checkGas([state.funding]);
    else if(state.screen==='skipped')go('assets');
    else if(state.screen==='move')demonstrate();
    else if(state.screen==='done')restart();
  }
  root.addEventListener('click',async event=>{
    const target=event.target.closest('button');if(!target||target.disabled)return;if(target.dataset.action==='skip-incomplete-recovery'&&!state.recoverySending&&state.recovery?.incompleteNetworks?.length){for(const id of state.recovery.incompleteNetworks){state.recoveryExcluded.add(id);state.recoverySkipped.add(id);}cancel();state.busy=false;state.recoveryIndex=0;void refreshRecovery();return;}if(target.dataset.action==='copy-qr'){const uri=state.walletConnect?.uri;if(!uri)return;try{await navigator.clipboard.writeText(uri);target.textContent='Conexão copiada';}catch{target.textContent='Não foi possível copiar';}return;}if(target.dataset.action==='cancel-qr'){cancel();state.busy=false;render();return;}if(state.busy)return;
    if(target.dataset.recoveryIndex!==undefined){state.recoveryIndex=Number(target.dataset.recoveryIndex);const entry=recoveryEntries()[state.recoveryIndex];if(entry){state.recoverySkipped.delete(entry.n.chainId);go('recovery-network');scheduleRecoveryRefresh();}return;}
    if(target.dataset.method){startMethod(target.dataset.method);return;}
    if(target.dataset.sourceProvider){void connectSource(target.dataset.sourceProvider);return;}
    if(target.dataset.account){void scanSource(target.dataset.account);return;}
    if(target.dataset.provider){void connectWallet(target.dataset.provider);return;}
    const a=target.dataset.action;
    if(a==='find-wallets'){beginWalletDiscovery();return;}
    if(a==='walletconnect'){void connectQr(target.dataset.source==='yes');return;}
    if(a==='restore-recovery-checks'){for(const id of state.recoveryExcluded)state.recoverySkipped.delete(id);state.recoveryExcluded.clear();void refreshRecovery();return;}
    if(a==='no-passkey'){void refreshRecovery(true);return;}
    if(a==='refresh-recovery'){void refreshRecovery();return;}
    if(a==='recovery-receipt'){void refreshRecovery(false,true);return;}
    if(a==='recovery-act'){void submitRecovery();return;}
    if(a==='recovery-next'){advanceRecoveryNetwork();return;}
    if(a==='skip-recovery'){const entry=recoveryEntries()[state.recoveryIndex];if(entry){state.recoverySkipped.add(entry.n.chainId);advanceRecoveryNetwork(entry.n.chainId);}return;}
    if(a==='recovery-restart'){restart();return;}
    if(a==='recovery-previous'){state.recoveryIndex=Math.max(0,state.recoveryIndex-1);render();return;}
    if(a==='edit-recovery-owner'){go('recovery-owner');return;}
    if(a==='access-passkey'){state.recoveryTarget=source;void discoverWithPasskey();return;}
    if(a==='retry-discovery'){if(state.method==='passkey')void discoverWithPasskey();else void discoverSource();return;}
    if(a==='confirm-passkey'){void discoverWithPasskey(true);return;}
    if(a==='retry-assets'){void scanSource(source);return;}
    if(a==='change-source'){changedSource();return;}
    if(a==='next'){event.preventDefault();next();}
    if(a==='change-wallet'){detachWallet();state.provider=undefined;state.payer='';state.gas={};go('fees',false);}
    if(a==='copy-source'||a==='copy-payer'){try{const copyEpoch=state.epoch;if(a==='copy-payer')await activePayer();if(copyEpoch!==state.epoch)return;await navigator.clipboard.writeText(a==='copy-source'?source:state.payer);if(copyEpoch!==state.epoch)return;if(a==='copy-payer'){target.innerHTML=copiedIcon;target.setAttribute('aria-label','Endereço copiado');target.setAttribute('title','Copiado');scene.querySelector('.pb-copy-feedback').textContent='Endereço copiado';later(()=>{target.innerHTML=copyIcon;target.setAttribute('aria-label','Copiar endereço da carteira para taxas');target.setAttribute('title','Copiar endereço');},1600);}else target.textContent='Endereço copiado';}catch{if(a==='copy-payer'){dropPayer('Não foi possível confirmar a carteira para copiar o endereço. Reconecte.');}else{state.error='Não foi possível copiar. Selecione o endereço acima.';render();}}}
    if(a==='fund'){void openFunding(target);return;}
    if(a==='retry-gas'&&unresolved()[0])void checkGas([unresolved()[0].id]);
    if(a==='skip')animateChoice(target,skipNetwork);
  });
  root.addEventListener('change',event=>{const id=event.target.dataset.network;if(!id)return;event.target.checked?state.selected.add(id):state.selected.delete(id);if(event.target.checked)state.skipped.delete(id);const button=scene.querySelector('[data-action=next]');button.textContent='Levar '+count()+' ativos';button.disabled=!count();syncForward();});
  root.addEventListener('input',event=>{if(event.target.classList.contains('pb-owner-address')){state.recoveryOwner=event.target.value.trim();const error=scene.querySelector('#pb-owner-error');error.textContent=recoveryOwnerError();error.hidden=!state.recoveryOwner||!error.textContent;event.target.setAttribute('aria-invalid',String(!!state.recoveryOwner&&!!error.textContent));scene.querySelector('[data-action=next]').disabled=!!recoveryOwnerError();syncForward();}else if(event.target.classList.contains('pb-address'))validateInput();});
  root.addEventListener('submit',event=>{event.preventDefault();next();});
  root.addEventListener('keydown',event=>{if(event.repeat||state.busy||event.metaKey||event.ctrlKey||event.altKey)return;if(!event.target.matches('input,textarea,select')&&state.screen==='access'&&['a','b'].includes(event.key.toLowerCase())){event.preventDefault();startMethod(event.key.toLowerCase()==='a'?'wallet':'passkey');}else if(state.screen==='recover-access'&&!event.target.matches('input,textarea,select')&&['a','b'].includes(event.key.toLowerCase())){event.preventDefault();scene.querySelector(event.key.toLowerCase()==='a'?'[data-action=access-passkey]':'[data-action=no-passkey]')?.click();}else if(state.screen==='fees'&&!event.target.matches('input,textarea,select')&&['a','b'].includes(event.key.toLowerCase())){event.preventDefault();scene.querySelector(event.key.toLowerCase()==='a'?'[data-action=fund], [data-action=retry-gas]':'[data-action=skip]')?.click();}else if(event.key==='Enter'&&!event.target.closest('button,summary')&&(!event.target.matches('input,textarea,select')||event.target.classList.contains('pb-address'))){event.preventDefault();next();}});
  back.addEventListener('click',goBack);
  forward.addEventListener('click',()=>{if(!forward.disabled)next();});
  window.addEventListener('eip6963:announceProvider',announceWallet);
  function fitViewport(){const viewport=window.visualViewport;root.style.height=viewport&&viewport.scale===1&&viewport.height>0?Math.floor(viewport.height)+'px':'100dvh';}
  window.visualViewport?.addEventListener('resize',fitViewport);
  window.addEventListener('resize',fitViewport);
  fitViewport();
  window.addEventListener('ethereum#initialized',refreshWalletDiscovery);
  window.addEventListener('focus',()=>{if(isWalletChoiceScreen())beginWalletDiscovery();});
  refreshWalletDiscovery();
  render();scene.focus({preventScroll:true});
})();
