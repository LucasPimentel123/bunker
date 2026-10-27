import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const SAFE='0x'+'a'.repeat(40), PAYER='0x'+'b'.repeat(40), DEST='0x'+'c'.repeat(40), GUARDIAN='0x'+'d'.repeat(40);
const inventory=()=>({account:SAFE,checkedAt:new Date().toISOString(),networks:[{id:'100',chainId:100,name:'Gnosis',symbol:'XDAI',status:'complete',guardians:[GUARDIAN],items:[{name:'USDC',balance:'3'}]},{id:'8453',chainId:8453,name:'Base',symbol:'ETH',status:'complete',items:[{name:'ETH',balance:'1'}]}]});
const source=fs.readFileSync('public/designs/assets/guided-live.js','utf8');
const code=source.replace('  render();scene.focus({preventScroll:true});\n})();','  window.testApi={state,render,checkGas,connectWallet,skipNetwork,go,next,providers,goBack,restart,destinationError,startMethod,connectSource,changedSource,scanSource,setInventory,openFunding,animateChoice,discoverWithPasskey,refreshRecovery,submitRecovery,recoveryOwnerError};render();\n})();');
function setup(){
 const nodes=new Map();
 function node(key){if(!nodes.has(key))nodes.set(key,{innerHTML:'',style:{},dataset:{},disabled:false,textContent:'',attrs:{},events:{},classList:{add(){},remove(){},contains(){return false;}},querySelector:s=>node(key+s),setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},addEventListener(k,fn){this.events[k]=fn;},focus(){},insertAdjacentHTML(_,s){this.innerHTML+=s;}});return nodes.get(key);}
 const road=Array.from({length:5},(_,i)=>node('road'+i)),root=node('root');root.querySelector=node;root.querySelectorAll=()=>road;
 const windowEvents=new Map();
 const ctx={document:{getElementById:()=>root},window:{addEventListener(name,fn){windowEvents.set(name,fn);},dispatchEvent(event){windowEvents.get(event.type)?.(event);},matchMedia:()=>({matches:true}),picnicGuidedInventory:inventory()},Event,AbortSignal,AbortController,setTimeout:(...args)=>setTimeout(...args).unref(),clearTimeout,navigator:{clipboard:{writeText:async()=>{}}},fetch:async()=>{throw Error('offline');}};
 vm.createContext(ctx);vm.runInContext(code,ctx);const api=ctx.window.testApi;
 const seed=()=>{api.setInventory(inventory());api.state.method='passkey';api.state.passkeyReady=true;api.state.candidates=[SAFE];api.go('assets');};
 const provider=(address=PAYER)=>{let current=address;const events=new Map();return {request:async()=>[current],on(k,fn){if(!events.has(k))events.set(k,new Set());events.get(k).add(fn);},removeListener(k,fn){events.get(k)?.delete(fn);},change(a){current=a;[...(events.get('accountsChanged')??[])].forEach(fn=>fn([a]));},set(a){current=a;}};};
 function payer(p=provider()){api.state.provider=p;api.state.payer=PAYER;api.state.walletName='Test';return p;}
 function rpc(balances={'100':'0x0','8453':'0x1'}){ctx.fetch=async(url,init)=>{const body=JSON.parse(init.body),id=url.includes('gnosis')?'100':'8453';return {ok:true,json:async()=>({id:1,jsonrpc:'2.0',result:body.method==='eth_chainId'?'0x'+Number(id).toString(16):balances[id]})};};return balances;}
 const gas=(id,status='available',balance=1n)=>api.state.gas[id]={status,balance,payer:PAYER,checkedAt:Date.now()};
 const click=action=>root.events.click({target:{closest:()=>({disabled:false,dataset:{action},setAttribute(){}})},preventDefault(){}});
 return {ctx,api,s:api.state,scene:node('.pb-scene'),road,node,seed,provider,payer,rpc,gas,click};
}
const flush=()=>new Promise(r=>setTimeout(r,5));

test('initial screen ignores old snapshot and direct fund/destination navigation',()=>{
 const h=setup();assert.equal(h.s.screen,'access');assert.equal(h.s.selected.size,0);h.api.go('fund');assert.equal(h.s.screen,'access');assert.doesNotMatch(h.scene.innerHTML,/Envie|0xaaaa/);h.api.startMethod('wallet');assert.equal(h.s.screen,'connect-source');assert.equal(h.s.selected.size,0);
});
test('deposit requires connected payer and a successful zero-balance query for selected network',async()=>{
 const h=setup();h.seed();h.s.funding='100';h.api.go('fund');assert.equal(h.s.screen,'fees');assert.match(h.scene.innerHTML,/Uma carteira paga/);
 h.payer();h.api.go('fund');assert.equal(h.s.screen,'fees');h.gas('100','error');h.api.go('fund');assert.equal(h.s.screen,'fees');h.gas('100','empty',0n);h.s.gas['100'].payer=DEST;h.api.go('fund');assert.equal(h.s.screen,'fees');
 h.rpc();await h.api.checkGas();await h.api.openFunding(h.node('choice'));await flush();assert.equal(h.s.screen,'fund');assert.match(h.scene.innerHTML,new RegExp(PAYER));assert.doesNotMatch(h.scene.innerHTML,/Disponível depois|Ver próxima tela/);
 h.s.selected.delete('100');h.api.render();assert.equal(h.s.screen,'fees');
});
test('RPC errors and wrong chain are unknown; neither exposes Add funds nor deposit',async()=>{
 const h=setup();h.seed();h.payer();h.api.go('fees');await h.api.checkGas();assert.equal(h.s.gas['100'].status,'error');assert.match(h.scene.innerHTML,/não conseguimos consultar/i);assert.doesNotMatch(h.scene.innerHTML,/data-action="fund"/);
 h.ctx.fetch=async()=>({ok:true,json:async()=>({id:1,jsonrpc:'2.0',result:'0x1'})});await h.api.checkGas();assert.equal(h.s.gas['100'].status,'error');await h.api.openFunding(h.node('choice'));assert.equal(h.s.screen,'fees');
});
test('positive balance skips funding and is not represented as a final gas estimate',async()=>{
 const h=setup();h.seed();h.payer();h.rpc({'100':'0x1','8453':'0x1'});h.api.go('fees');await h.api.checkGas();assert.match(h.scene.innerHTML,/custo final precisa ser estimado/);await h.api.next();assert.equal(h.s.screen,'destination');h.s.funding='100';h.api.go('fund');assert.equal(h.s.screen,'fees');
});
test('deposit zero stays pending, error returns to unknown, positive resumes checked flow',async()=>{
 const h=setup();h.seed();h.payer();const balances=h.rpc();h.api.go('fees');await h.api.checkGas();h.s.funding='100';h.api.go('fund');await h.api.checkGas(['100']);assert.equal(h.s.screen,'fund');assert.match(h.scene.innerHTML,/saldo ainda está zerado/);
 h.ctx.fetch=async()=>{throw Error('offline');};await h.api.checkGas(['100']);assert.equal(h.s.screen,'fees');assert.match(h.scene.innerHTML,/Não foi possível conferir/);
 h.rpc(balances);await h.api.checkGas(['100']);h.api.go('fund');balances['100']='0x100';await h.api.checkGas(['100']);assert.equal(h.s.screen,'fees');assert.equal(h.s.gas['100'].status,'available');
});
test('skip only affects one network; all skipped is not a successful withdrawal; Back undoes skip',async()=>{
 const h=setup();h.seed();h.payer();h.gas('100','empty',0n);h.gas('8453','empty',0n);h.api.go('fees');h.api.skipNetwork();assert.deepEqual([...h.s.selected],['8453']);h.api.skipNetwork();assert.equal(h.s.screen,'skipped');assert.match(h.scene.innerHTML,/Nenhum ativo foi retirado/);h.api.goBack();assert.ok(h.s.selected.has('8453'));h.api.goBack();assert.ok(h.s.selected.has('100'));
});
test('wallet switch without event cannot open or copy a stale payer deposit',async()=>{
 const h=setup();h.seed();const p=h.payer();h.gas('100','empty',0n);h.gas('8453');h.api.go('fees');p.set(DEST);await h.api.openFunding(h.node('choice'));assert.equal(h.s.payer,'');assert.equal(h.s.screen,'fees');
 h.payer(p);h.gas('100','empty',0n);h.s.funding='100';h.api.go('fund');let copied=false;h.ctx.navigator.clipboard.writeText=async()=>copied=true;await h.click('copy-payer');assert.equal(copied,false);assert.equal(h.s.payer,'');assert.equal(h.s.screen,'fees');
});
test('canceled gas requests cannot overwrite new wallet or navigation',async()=>{
 const h=setup();h.seed();h.payer();h.api.go('fees');let release;h.ctx.fetch=()=>new Promise(resolve=>release=resolve);const pending=h.api.checkGas(['100']);await flush();h.api.goBack();release({ok:false});await pending;assert.equal(h.s.screen,'assets');assert.equal(Object.keys(h.s.gas).length,0);assert.equal(h.s.busy,false);
});
test('connection denial and late connection responses do not trap or restore old state',async()=>{
 const h=setup();h.seed();h.api.go('fees');h.api.providers.set('reject',{name:'Reject',provider:{request:async()=>{throw Object.assign(Error('denied'),{code:4001});}}});await h.api.connectWallet('reject');assert.equal(h.s.busy,false);assert.match(h.scene.innerHTML,/Conexão cancelada/);
 let release;h.api.providers.set('late',{name:'Late',provider:{request:()=>new Promise(r=>release=r)}});const pending=h.api.connectWallet('late');h.api.goBack();release([PAYER]);await pending;assert.equal(h.s.payer,'');assert.equal(h.s.screen,'assets');
});
test('withdrawal accepts payer and guardian recipients, but rejects the source and invalid addresses',()=>{
 const h=setup();h.seed();h.payer();for(const value of [SAFE,'0x'+'0'.repeat(40),'0x12']){h.s.destination=value;assert.ok(h.api.destinationError());}for(const value of [DEST,PAYER,GUARDIAN]){h.s.destination=value;assert.equal(h.api.destinationError(),'');}
});
test('destination cannot advance after source or payer changed silently',async()=>{
 const h=setup();h.seed();const p=h.payer();h.gas('100');h.gas('8453');h.s.destination=DEST;h.api.go('destination');p.set(GUARDIAN);await h.api.next();assert.equal(h.s.screen,'fees');assert.equal(h.s.payer,'');
});
test('Back preserves answers; completion shows five checks; restart clears identity',async()=>{
 const h=setup();h.seed();h.payer();h.gas('100');h.gas('8453');h.s.destination=DEST;h.api.go('fees');await h.api.next();assert.equal(h.s.screen,'destination');await h.api.next();assert.equal(h.s.screen,'move');h.api.goBack();assert.equal(h.s.destination,DEST);assert.equal(h.s.screen,'destination');
 h.s.screen='done';h.api.render();assert.ok(h.road.every(n=>n.querySelector('b').textContent==='✓'));assert.match(h.scene.innerHTML,/Nada foi enviado/);h.api.restart();assert.equal(h.s.screen,'access');assert.equal(h.s.payer,'');assert.equal(h.s.destination,'');assert.equal(h.s.selected.size,0);
});
test('double choice and cancel during animation never skip stages',async()=>{
 const h=setup();h.seed();h.payer();h.gas('100','empty',0n);h.gas('8453');h.api.go('fees');await h.api.openFunding(h.node('a'));await h.click('skip');await flush();assert.equal(h.s.screen,'fund');assert.ok(h.s.selected.has('100'));
 h.api.goBack();await h.api.openFunding(h.node('a'));h.api.goBack();await flush();assert.equal(h.s.screen,'assets');assert.equal(h.s.busy,false);
});
function external(h,addresses=[SAFE]){
 h.ctx.window.picnicGuidedDiscovery={discover:async(address)=>{assert.equal(address,PAYER);return {addresses,issues:[]};},checkAccess:async(account,wallet)=>({account,wallet,ready:true,networks:[{name:'Gnosis',status:'owner'}]}),scan:async(address,signal,progress)=>{assert.equal(signal.aborted,false);progress(10,10);return {...inventory(),account:address};}};
 const p=h.provider();h.api.providers.set('actual',{name:'Actual wallet',provider:p});return p;
}
test('external connection discovers correct Safe; changing source clears all identities and balances',async()=>{
 const h=setup();const p=external(h);h.api.startMethod('wallet');await h.api.connectSource('actual');assert.equal(h.s.screen,'assets');assert.match(h.scene.innerHTML,new RegExp(SAFE));assert.equal(h.s.payer,PAYER);p.change(DEST);assert.equal(h.s.screen,'connect-source');assert.equal(h.s.selected.size,0);assert.equal(h.s.payer,'');assert.doesNotMatch(h.scene.innerHTML,new RegExp(SAFE));
});
test('multiple accounts require a choice; no results never fall back to snapshot',async()=>{
 const h=setup();external(h,[SAFE,DEST]);h.api.startMethod('wallet');await h.api.connectSource('actual');assert.equal(h.s.screen,'account');assert.equal(h.s.selected.size,0);await h.api.scanSource(DEST);assert.equal(h.s.screen,'assets');assert.match(h.scene.innerHTML,new RegExp(DEST));
 external(h,[]);h.api.startMethod('wallet');await h.api.connectSource('actual');assert.equal(h.s.screen,'no-account');assert.equal(h.s.selected.size,0);
});
test('passkey must identify and verify an account before displaying assets; no preloaded fixture',async()=>{
 const h=setup();let release;h.ctx.window.picnicGuidedDiscovery={discoverPasskey:()=>new Promise(r=>release=r),scan:async(a)=>({...inventory(),account:a})};h.api.startMethod('passkey');assert.equal(h.s.screen,'passkey-discover');assert.equal(h.s.selected.size,0);release({addresses:[DEST],issues:[],needsSecond:false});await flush();assert.equal(h.s.screen,'assets');assert.equal(h.s.passkeyReady,true);assert.match(h.scene.innerHTML,new RegExp(DEST));assert.equal(h.s.payer,'');await h.api.next();assert.equal(h.s.screen,'fees');assert.match(h.scene.innerHTML,/Uma carteira paga as taxas/);
});
test('second passkey is requested only for multiple verified candidate keys',async()=>{
 const h=setup();let calls=0;h.ctx.window.picnicGuidedDiscovery={discoverPasskey:async()=>({addresses:[],issues:[],needsSecond:true}),confirmPasskey:async()=>{calls++;return {addresses:[SAFE],issues:[],needsSecond:false};},scan:async()=>inventory()};h.api.startMethod('passkey');await flush();assert.equal(h.s.screen,'passkey-confirm');assert.equal(calls,0);await h.api.discoverWithPasskey(true);assert.equal(calls,1);assert.equal(h.s.screen,'assets');
});
test('canceling passkey aborts discovery and ignores a late credential result',async()=>{
 const h=setup();let release,signal;h.ctx.window.picnicGuidedDiscovery={discoverPasskey:(s)=>{signal=s;return new Promise(r=>release=r);}};h.api.startMethod('passkey');h.api.goBack();assert.equal(signal.aborted,true);release({addresses:[SAFE],issues:[],needsSecond:false});await flush();assert.equal(h.s.screen,'access');assert.equal(h.s.selected.size,0);
});
test('asset withdrawal stays demonstrative; UI has no raw wallet send methods or snapshot bypass',()=>{
 assert.doesNotMatch(source,/eth_send|eth_sign|personal_sign|wallet_send|passkeyPreview|Ver próxima tela|Disponível depois/);
 const html=fs.readFileSync('public/designs/guided.html','utf8');assert.doesNotMatch(html,/guided-account\.js/);assert.match(html,/guided-segments\.css/);
 const gallery=fs.readFileSync('public/designs/assets/navigation-studies.js','utf8');assert.match(gallery,/location.replace\('guided.html\?design=segments'\)/);assert.doesNotMatch(gallery,/Disponível depois|Ver próxima tela/);
});

test('a silently changed source clears inventory even when a different wallet pays gas',async()=>{
 const h=setup();const src=external(h);h.api.startMethod('wallet');await h.api.connectSource('actual');h.payer();h.gas('100');h.gas('8453');h.s.destination=DEST;h.api.go('destination');src.set(GUARDIAN);await h.api.next();assert.equal(h.s.screen,'connect-source');assert.equal(h.s.selected.size,0);assert.equal(h.s.payer,'');
});

test('guardian relationship blocks asset indexing until ownership is actually restored',async()=>{
 const h=setup();external(h);let scans=0,ready=false;
 h.ctx.window.picnicGuidedDiscovery.checkAccess=async(account,wallet)=>({account,wallet,ready,networks:[{name:'Polygon',status:ready?'owner':'guardian',passkey:true}]});
 h.ctx.window.picnicGuidedDiscovery.scan=async()=>{scans++;return inventory();};
 h.api.startMethod('wallet');await h.api.connectSource('actual');assert.equal(scans,0);assert.equal(h.s.screen,'recover-access');assert.equal(h.s.selected.size,0);assert.match(h.scene.innerHTML,/Você tem a passkey/);assert.doesNotMatch(h.scene.innerHTML,/Verificar o acesso novamente/);
 ready=true;await h.api.scanSource(SAFE);assert.equal(scans,1);assert.equal(h.s.screen,'assets');
});
test('unknown or mixed-chain access cannot start asset indexing',async()=>{
 const h=setup();external(h);let scans=0;
 h.ctx.window.picnicGuidedDiscovery.checkAccess=async(account,wallet)=>({account,wallet,ready:false,networks:[{name:'Gnosis',status:'owner'},{name:'Polygon',status:'unknown'}]});
 h.ctx.window.picnicGuidedDiscovery.scan=async()=>{scans++;return inventory();};
 h.api.startMethod('wallet');await h.api.connectSource('actual');assert.equal(scans,0);assert.equal(h.s.screen,'recover-access');assert.match(h.scene.innerHTML,/verificação indisponível/);
});
test('guardian may use the matching passkey, but another Safe never bypasses the access gate',async()=>{
 const h=setup();external(h);let scans=0,match=false;
 h.ctx.window.picnicGuidedDiscovery.checkAccess=async(account,wallet)=>({account,wallet,ready:false,networks:[{name:'Polygon',status:'guardian',passkey:true}]});
 h.ctx.window.picnicGuidedDiscovery.discoverPasskey=async()=>({addresses:[match?SAFE:DEST],issues:[],needsSecond:false});
 h.ctx.window.picnicGuidedDiscovery.scan=async()=>{scans++;return inventory();};
 h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('access-passkey');await flush();assert.equal(scans,0);assert.equal(h.s.screen,'recover-access');assert.match(h.scene.innerHTML,/não confirmou acesso/);
 match=true;await h.click('access-passkey');await flush();assert.equal(scans,1);assert.equal(h.s.screen,'assets');assert.equal(h.s.method,'passkey');assert.equal(h.s.payer,PAYER);
});
test('canceled access checks cannot restore old identity or start scanning',async()=>{
 const h=setup();external(h);let resolve,scans=0;
 h.ctx.window.picnicGuidedDiscovery.checkAccess=()=>new Promise(r=>resolve=r);
 h.ctx.window.picnicGuidedDiscovery.scan=async()=>{scans++;return inventory();};
 h.api.startMethod('wallet');const pending=h.api.connectSource('actual');await flush();assert.equal(h.s.screen,'check-access');h.api.changedSource();resolve({account:SAFE,wallet:PAYER,ready:true,networks:[]});await pending;assert.equal(scans,0);assert.equal(h.s.screen,'connect-source');
});

test('the gas payer can be selected as the asset withdrawal destination',async()=>{
 const h=setup();h.seed();h.payer();h.gas('100');h.gas('8453');h.s.destination=PAYER;h.api.go('destination');await h.api.next();assert.equal(h.s.screen,'move');
});

function guardianRecovery(h){
 external(h);let operation='approve',reads=0,calls=[];
 h.ctx.window.picnicGuidedDiscovery.checkAccess=async(account,wallet)=>({account,wallet,ready:false,networks:[{name:'Polygon',status:'guardian',passkey:true}]});
 h.ctx.window.picnicGuidedDiscovery.recovery={
  read:async(account,wallet,owner)=>{reads++;return {account,wallet,owner,complete:true,guardians:[PAYER,GUARDIAN],pending:[],issues:[],networks:[{chainId:137,name:'Polygon',symbol:'POL',gas:'1',owners:[SAFE],recovered:operation==='done',modules:[{module:GUARDIAN,guardian:true,period:'604800',until:operation==='wait'?'2000000000':'0',newOwners:[DEST],threshold:'1',approvals:operation==='approve'?'0':'1',approved:operation!=='approve',operation:['approve','start','finalize'].includes(operation)&&owner?operation:undefined}]}]};},
  perform:async(...args)=>{calls.push(args);args[8]('Confirme na carteira.');operation=operation==='approve'?'start':operation==='start'?'wait':'done';},receipts:async()=>{},
 };
 return {calls,reads:()=>reads,set:v=>operation=v};
}
test('No passkey starts real recovery preparation; new owner cannot be any guardian',async()=>{
 const h=setup();const r=guardianRecovery(h);h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('no-passkey');await flush();assert.equal(h.s.screen,'recovery-owner');assert.equal(r.reads(),1);assert.equal(r.calls.length,0);
 for(const owner of [PAYER,GUARDIAN,SAFE,'bad']){h.s.recoveryOwner=owner;assert.ok(h.api.recoveryOwnerError());}
 h.s.recoveryOwner=DEST;assert.equal(h.api.recoveryOwnerError(),'');await h.api.next();assert.equal(h.s.screen,'recovery-network');assert.match(h.scene.innerHTML,/Recuperar conta/);
 await h.api.submitRecovery();assert.equal(r.calls.length,1);assert.equal(r.calls[0][5],'approve');assert.equal(r.calls[0][2],DEST);assert.match(h.scene.innerHTML,/Recuperar conta/);
 await h.api.submitRecovery();assert.equal(r.calls[1][5],'start');assert.match(h.scene.innerHTML,/O prazo já começou/);assert.doesNotMatch(h.scene.innerHTML,/data-action="recovery-act"/);
 r.set('finalize');await h.api.refreshRecovery();assert.match(h.scene.innerHTML,/Finalizar recuperação/);await h.api.submitRecovery();assert.equal(r.calls[2][5],'finalize');assert.match(h.scene.innerHTML,/Conectar nova carteira/);assert.equal(h.s.selected.size,0);h.api.restart();
});
test('recovery choice supports Back without rechecking unchanged access',async()=>{
 const h=setup();const r=guardianRecovery(h);h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('no-passkey');await flush();h.api.goBack();assert.equal(h.s.screen,'recover-access');assert.match(h.scene.innerHTML,/Não tenho a passkey/);assert.equal(r.reads(),1);h.api.restart();
});

test('Back cancels passkey identification and returns to the same recovery choice',async()=>{
 const h=setup();guardianRecovery(h);h.ctx.window.picnicGuidedDiscovery.discoverPasskey=()=>new Promise(()=>{});h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('access-passkey');h.api.goBack();assert.equal(h.s.screen,'recover-access');assert.match(h.scene.innerHTML,/Você tem a passkey/);h.api.restart();
});

test('wallets use extension icons and keep the QR option last for source and payer',()=>{
 const h=setup();h.api.providers.set('metamask',{name:'MetaMask',icon:'data:image/svg+xml,%3Csvg%3E%3C/svg%3E',provider:h.provider()});h.api.startMethod('wallet');assert.match(h.scene.innerHTML,/<img src="data:image/);assert.ok(h.scene.innerHTML.indexOf('MetaMask')<h.scene.innerHTML.indexOf('Outra carteira'));assert.match(h.scene.innerHTML,/QR code · WalletConnect/);
 h.seed();h.api.go('fees');assert.match(h.scene.innerHTML,/QR code · WalletConnect/);h.api.providers.get('metamask').icon='https://tracker.invalid/icon.svg';h.api.render();assert.doesNotMatch(h.scene.innerHTML,/tracker.invalid/);
});

test('a stored WalletConnect option never hides injected extensions',()=>{
 const h=setup();h.api.providers.set('walletconnect',{name:'WalletConnect',provider:h.provider()});h.ctx.window.ethereum=Object.assign(h.provider(),{isMetaMask:true});h.api.startMethod('wallet');assert.match(h.scene.innerHTML,/MetaMask/);assert.ok(h.scene.innerHTML.indexOf('MetaMask')<h.scene.innerHTML.indexOf('Outra carteira'));h.api.restart();
});
test('late extension injection is discovered without reloading, and EIP metadata replaces its fallback',()=>{
 const h=setup();h.api.startMethod('wallet');assert.match(h.scene.innerHTML,/Nenhuma extensão detectada/);
 const provider=Object.assign(h.provider(),{isMetaMask:true});h.ctx.window.ethereum=provider;h.ctx.window.dispatchEvent({type:'ethereum#initialized'});assert.match(h.scene.innerHTML,/MetaMask/);
 h.ctx.window.dispatchEvent({type:'eip6963:announceProvider',detail:{provider,info:{uuid:'meta',name:'MetaMask',icon:'data:image/png;base64,abc'}}});assert.equal([...h.api.providers.values()].filter(w=>w.provider===provider).length,1);assert.match(h.scene.innerHTML,/data:image\/png;base64,abc/);h.api.restart();
});
test('legacy multi-provider injection lists each actual wallet alongside QR',()=>{
 const h=setup();h.ctx.window.ethereum={providers:[Object.assign(h.provider(),{isMetaMask:true}),Object.assign(h.provider(),{isRabby:true,isMetaMask:true})]};h.api.startMethod('wallet');assert.match(h.scene.innerHTML,/MetaMask/);assert.match(h.scene.innerHTML,/Rabby/);assert.match(h.scene.innerHTML,/Outra carteira/);h.api.restart();
});

test('Rabby legacy and EIP-6963 wrapper become one choice with the official provider and logo',async()=>{
 const h=setup(),legacy=Object.assign(h.provider(),{isRabby:true,isMetaMask:true}),official=h.provider();h.ctx.window.ethereum=legacy;h.api.startMethod('wallet');
 const announce=()=>h.ctx.window.dispatchEvent({type:'eip6963:announceProvider',detail:{provider:official,info:{uuid:'rabby',rdns:'io.rabby',name:'Rabby Wallet',icon:'data:image/png;base64,rabby'}}});announce();
 h.ctx.window.dispatchEvent({type:'ethereum#initialized'});announce();h.ctx.window.dispatchEvent({type:'focus'});
 assert.equal([...h.api.providers.values()].filter(w=>w.brand==='rabby').length,1);assert.equal(h.api.providers.get('eip6963:rabby').provider,official);assert.equal((h.scene.innerHTML.match(/<strong>Rabby Wallet<\/strong>/g)??[]).length,1);assert.match(h.scene.innerHTML,/data:image\/png;base64,rabby/);
 h.api.restart();
});
test('announcement first suppresses a late legacy wrapper; distinct wallets remain distinct',()=>{
 const h=setup();h.ctx.window.dispatchEvent({type:'eip6963:announceProvider',detail:{provider:h.provider(),info:{uuid:'rabby',rdns:'io.rabby',name:'Rabby Wallet'}}});h.ctx.window.ethereum={providers:[Object.assign(h.provider(),{isRabby:true,isMetaMask:true}),Object.assign(h.provider(),{isMetaMask:true}),Object.assign(h.provider(),{isPhantom:true,isMetaMask:true})]};h.api.startMethod('wallet');assert.equal([...h.api.providers.values()].filter(w=>w.brand==='rabby').length,1);assert.match(h.scene.innerHTML,/assets\/wallets\/phantom.svg/);assert.match(h.scene.innerHTML,/MetaMask/);h.api.restart();
});
test('a throwing legacy ethereum getter does not prevent official announcements',()=>{
 const h=setup();Object.defineProperty(h.ctx.window,'ethereum',{get(){throw Error('conflict');}});h.api.startMethod('wallet');h.ctx.window.dispatchEvent({type:'eip6963:announceProvider',detail:{provider:h.provider(),info:{uuid:'meta',rdns:'io.metamask',name:'MetaMask'}}});assert.match(h.scene.innerHTML,/MetaMask/);h.api.restart();
});
test('repeated unchanged announcements do not redraw the wallet list or move focus',()=>{
 const h=setup();h.api.startMethod('wallet');const announcement={type:'eip6963:announceProvider',detail:{provider:h.provider(),info:{uuid:'rabby',rdns:'io.rabby',name:'Rabby Wallet'}}};h.ctx.window.dispatchEvent(announcement);h.scene.innerHTML='focus-preserved';h.ctx.window.dispatchEvent(announcement);assert.equal(h.scene.innerHTML,'focus-preserved');h.api.restart();
});

test('skip recovery does not sign, scan assets, or pretend that access was recovered',async()=>{
 const h=setup();const r=guardianRecovery(h);h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('no-passkey');await flush();h.s.recoveryOwner=DEST;await h.api.next();assert.match(h.scene.innerHTML,/Recuperar conta/);assert.match(h.scene.innerHTML,/Pular esta rede/);await h.click('skip-recovery');assert.equal(r.calls.length,0);assert.equal(h.s.screen,'recovery-overview');assert.equal(h.s.recoverySkipped.has(137),true);assert.equal(h.s.selected.size,0);assert.match(h.scene.innerHTML,/Redes deixadas para depois/);h.api.restart();
});

test('Back returns to the preceding recovery network and undoes skipping without signing',async()=>{
 const h=setup();const r=guardianRecovery(h);const original=h.ctx.window.picnicGuidedDiscovery.recovery.read;h.ctx.window.picnicGuidedDiscovery.recovery.read=async(...args)=>{const data=await original(...args);data.networks.push({...data.networks[0],chainId:100,name:'Gnosis'});return data;};h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('no-passkey');await flush();h.s.recoveryOwner=DEST;await h.api.next();await h.click('skip-recovery');assert.equal(h.s.recoveryIndex,1);assert.equal(h.s.recoverySkipped.has(137),true);h.api.goBack();assert.equal(h.s.screen,'recovery-network');assert.equal(h.s.recoveryIndex,0);assert.equal(h.s.recoverySkipped.has(137),false);assert.equal(r.calls.length,0);h.api.restart();
});

test('mobile keyboard resize keeps the app frame inside the visible viewport without constraining zoom',()=>{
 const h=setup();h.ctx.window.visualViewport={height:412,scale:1};h.ctx.window.dispatchEvent({type:'resize'});assert.equal(h.node('root').style.height,'412px');h.ctx.window.visualViewport.scale=2;h.ctx.window.dispatchEvent({type:'resize'});assert.equal(h.node('root').style.height,'100dvh');
});

test('retrying incomplete recovery shows loading and skipping cancels the stale read',async()=>{
 const h=setup();const r=guardianRecovery(h),base=h.ctx.window.picnicGuidedDiscovery.recovery.read;let reads=0,release;
 h.ctx.window.picnicGuidedDiscovery.recovery.read=async(a,w,o,signal,excluded=[])=>{reads++;const data=await base(a,w,o);if(excluded.includes(999))return {...data,incompleteNetworks:[]};if(reads===2)return new Promise(resolve=>release=()=>resolve({...data,complete:false,issues:['HyperEVM'],incompleteNetworks:[999]}));return {...data,complete:false,issues:['HyperEVM'],incompleteNetworks:[999]};};
 h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('no-passkey');await flush();assert.match(h.scene.innerHTML,/Pular esta rede/);const waiting=h.api.refreshRecovery();await flush();assert.match(h.scene.innerHTML,/Conferindo redes…/);assert.match(h.scene.innerHTML,/pb-indeterminate/);assert.match(h.scene.innerHTML,/disabled aria-busy="true"/);
 await h.click('skip-incomplete-recovery');await flush();assert.equal(h.s.recoveryExcluded.has(999),true);assert.equal(h.s.screen,'recovery-owner');release();await waiting;assert.equal(h.s.screen,'recovery-owner');assert.equal(r.calls.length,0);assert.equal(h.s.selected.size,0);h.api.restart();
});
test('the contract delay is visible before authorizing recovery, outside collapsed details',async()=>{
 const h=setup();guardianRecovery(h);h.api.startMethod('wallet');await h.api.connectSource('actual');await h.click('no-passkey');await flush();h.s.recoveryOwner=DEST;await h.api.next();const text=h.scene.innerHTML;assert.match(text,/<strong>7 dias<\/strong>/);assert.doesNotMatch(text,/Detalhes da recuperação|<details/);assert.match(text,new RegExp(DEST));assert.match(text,/data-action="edit-recovery-owner"/);h.api.restart();
});
